// What upstream says about each pin. Every lookup takes an `io` ({fetch, exec,
// token}) so tests replay recorded answers offline. A lookup that cannot
// answer returns {error}: UNKNOWN, which the verdict turns into a failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {newest} from './verdict.mjs';

// Three tries for a dropped connection, a 429 or a 5xx: ~25 lookups run at
// once and one reset socket must not read as UNKNOWN. A 4xx is an answer.
async function getJson(io, url, headers = {}, tries = 3) {
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await io.fetch(url, {headers: {accept: 'application/json', ...headers}});
        } catch (e) {
            if (attempt >= tries)
                throw new Error(`${url}: ${e.cause?.code ?? e.message}`);
            await io.sleep(attempt * 1000);
            continue;
        }
        if (res.ok)
            return res.json();
        if (attempt >= tries || !(res.status === 429 || res.status >= 500))
            throw new Error(`${url} answered ${res.status}`);
        await io.sleep(attempt * 1000);
    }
}

const ghHeaders = io => (io.token ? {authorization: `Bearer ${io.token}`} : {});

async function guard(fn) {
    try {
        return await fn();
    } catch (e) {
        return {error: e.message};
    }
}

/** A GitHub repo (action or pre-commit hook): newest release tag + its date. */
export function githubLatest(io, repo, track = null) {
    return guard(async () => {
        // ls-remote lists every tag with no API quota; the API is asked only
        // for the date of the one tag that matters.
        const out = await io.exec('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}`]);
        const tags = out.split('\n').map(l => l.split('refs/tags/')[1]).filter(Boolean);
        const latest = newest(tags, track);
        if (!latest)
            return {latest: null};
        const commit = await getJson(io, `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(latest)}`, ghHeaders(io));
        return {latest, publishedAt: Date.parse(commit.commit?.committer?.date) || null};
    });
}

export function npmLatest(io, name, current) {
    return guard(async () => {
        // a scoped name's slash is encoded (@scope%2Fname), every one of them
        const doc = await getJson(io, `https://registry.npmjs.org/${name.replaceAll('/', '%2F')}`);
        const latest = doc['dist-tags']?.latest ?? null;
        return {
            latest,
            publishedAt: Date.parse(doc.time?.[latest]) || null,
            deprecated: Boolean(doc.versions?.[current]?.deprecated),
        };
    });
}

export function pypiLatest(io, name) {
    return guard(async () => {
        const doc = await getJson(io, `https://pypi.org/pypi/${name}/json`);
        const latest = doc.info?.version ?? null;
        const files = doc.releases?.[latest] ?? [];
        return {latest, publishedAt: Date.parse(files[0]?.upload_time_iso_8601) || null};
    });
}

/**
 * A Docker Hub image. The tag's variant suffix (`-noble`) is kept: only tags
 * of the same variant compete. Also returns the pinned tag's current digest,
 * so a rebuilt tag reads as due once it is out of the grace window.
 */
export function dockerLatest(io, image, currentTag, track = null) {
    return guard(async () => {
        const [repo, ns] = image.includes('/') ? [image.split('/')[1], image.split('/')[0]] : [image, 'library'];
        const variant = currentTag.match(/^[\d.]+(-.+)?$/)?.[1] ?? '';
        const tags = [];
        let url = `https://hub.docker.com/v2/namespaces/${ns}/repositories/${repo}/tags?page_size=100${variant ? `&name=${encodeURIComponent(variant)}` : ''}`;
        for (let page = 0; url && page < 20; page++) {
            const doc = await getJson(io, url);
            tags.push(...doc.results);
            url = doc.next;
        }
        const plain = tags.filter(t => t.name.endsWith(variant) && /^\d/.test(t.name));
        const byName = new Map(plain.map(t => [t.name.slice(0, t.name.length - variant.length), t]));
        const latest = newest([...byName.keys()], track);
        const mine = byName.get(currentTag.slice(0, currentTag.length - variant.length));
        return {
            latest: latest && `${latest}${variant}`,
            publishedAt: Date.parse(byName.get(latest)?.tag_last_pushed ?? byName.get(latest)?.last_updated) || null,
            digest: mine?.digest ?? null,
            digestUpdatedAt: Date.parse(mine?.tag_last_pushed ?? mine?.last_updated) || null,
        };
    });
}

/** Node release lines: [{major, ltsSince, eol}] from nodejs.org + the schedule. */
export function nodeLines(io) {
    return guard(async () => {
        const [index, schedule] = await Promise.all([
            getJson(io, 'https://nodejs.org/dist/index.json'),
            getJson(io, 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'),
        ]);
        const lines = new Map();
        for (const r of index) {
            const major = Number(r.version.replace(/^v/, '').split('.')[0]);
            const line = lines.get(major) ?? {major, ltsSince: null, eol: null};
            if (r.lts && (!line.ltsSince || Date.parse(r.date) < line.ltsSince))
                line.ltsSince = Date.parse(r.date);
            lines.set(major, line);
        }
        for (const [key, s] of Object.entries(schedule)) {
            const line = lines.get(Number(key.replace(/^v/, '')));
            if (line)
                line.eol = Date.parse(s.end) || null;
        }
        return {lines: [...lines.values()]};
    });
}

/** Open Dependabot PRs: [{number, title}]. Null when GitHub would not say. */
export async function dependabotPrs(io, repo) {
    try {
        const prs = await getJson(io, `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`, ghHeaders(io));
        return prs.filter(p => p.user?.login === 'dependabot[bot]').map(p => ({number: p.number, title: p.title}));
    } catch {
        return null;
    }
}

/**
 * The open PR that bumps `name` to `version`, read from Dependabot's title
 * ("bump <name> from <a> to <b>"): exact name and version, so knip never
 * matches eslint-plugin-knip and 3.2.5 never matches 3.2.57. A grouped PR
 * ("bump the actions-minor group ... with 3 updates") names no single pin
 * and counts for none. The pre-commit ecosystem names a hook by its repo URL;
 * a digest bump names short digests in backticks (`version` is then the
 * full sha256:...).
 */
export function prFor(prs, name, version) {
    const want = String(version).replace(/^v/, '');
    for (const p of prs ?? []) {
        const m = /\bbump (\S+) from \S+ to (\S+?)(?:\s|$)/i.exec(p.title);
        if (!m)
            continue;
        const who = m[1].replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
        const to = m[2].replace(/^`|`$/g, '').replace(/^v/, '');
        const digest = want.startsWith('sha256:') && to.length >= 7 && want.slice(7).startsWith(to);
        if (who === name && (to === want || digest))
            return p.number;
    }
    return null;
}

/**
 * Known advisories for the direct pins, from OSV (npm, PyPI and GitHub
 * Actions): [{pin, ids}]. Transitive npm advisories come from `npm audit`
 * in check-deps.mjs.
 */
export function osvAdvisories(io, pins) {
    const eco = {npm: 'npm', pip: 'PyPI', action: 'GitHub Actions'};
    const asked = pins.filter(p => eco[p.kind]);
    return guard(async () => {
        const res = await io.fetch('https://api.osv.dev/v1/querybatch', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({queries: asked.map(p => ({
                package: {ecosystem: eco[p.kind], name: p.name},
                version: p.current.replace(/^v/, ''),
            }))}),
        });
        if (!res.ok)
            throw new Error(`api.osv.dev answered ${res.status}`);
        const {results} = await res.json();
        return {found: asked.map((pin, i) => ({pin, ids: (results[i]?.vulns ?? []).map(v => v.id)}))
            .filter(r => r.ids.length)};
    });
}

/**
 * `npm audit` of the tool tree in `dir` (its package.json, and its lockfile
 * when one is committed), run in a scratch copy, never in place, with
 * install scripts off: [{name, id, severity, title}].
 */
export async function npmAudit(io, dir) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-audit-'));
    try {
        for (const f of ['package.json', 'package-lock.json']) {
            if (fs.existsSync(path.join(dir, f)))
                fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
        }
        if (!fs.existsSync(path.join(tmp, 'package-lock.json')))
            await io.exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: tmp});
        let out;
        try {
            out = await io.exec('npm', ['audit', '--json'], {cwd: tmp});
        } catch (e) {
            out = e.stdout; // npm audit exits 1 when it finds something
            if (!out)
                throw e;
        }
        const found = [];
        for (const v of Object.values(JSON.parse(out).vulnerabilities ?? {})) {
            for (const via of v.via) {
                if (typeof via === 'object')
                    found.push({name: via.name, id: via.url?.split('/').pop() ?? String(via.source), severity: via.severity, title: via.title});
            }
        }
        return {found};
    } catch (e) {
        return {error: e.message};
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
}
