#!/usr/bin/env node
// Dependency freshness + known advisories, for every version this repo pins
// (scripts/deps/inventory.mjs lists the kinds). Two outcomes per pin: current,
// or DECLARED in .github/dependency-holds with a reason. No advisory tier.
//
//   node scripts/check-deps.mjs              freshness, then advisories
//   node scripts/check-deps.mjs freshness    every pin against its upstream
//   node scripts/check-deps.mjs audit        OSV for the direct pins, `npm audit`
//                                            for every .github/<tool> tree
//
// Network required: an upstream that does not answer is UNKNOWN and fails,
// never "up to date". Runs in CI (the `deps` job, on every push and weekly) -
// not in pre-commit, which must work offline. GITHUB_TOKEN / GH_TOKEN, else
// `gh auth token`, is used for the GitHub API when present.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {
    parseDockerfile, parseEngines, parseHolds, parsePackageJson, parsePreCommit,
    parseRequirements, parseWorkflow,
} from './deps/inventory.mjs';
import {
    dependabotPrs, dockerLatest, githubLatest, nodeLines, npmLatest, osvAdvisories, prFor,
    pypiLatest,
} from './deps/sources.mjs';
import {nodeVerdict, verdict} from './deps/verdict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'fschmutz/claude-usage-panel';
const HOLDS = '.github/dependency-holds';
const run = promisify(execFile);

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ls = (dir, re) => fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})
    .filter(d => re.test(d.name)).map(d => path.posix.join(dir, d.name));

/** Every pin, plus every pin-shaped line that did not parse. */
export function inventory() {
    const parts = [
        ...ls('.github/workflows', /\.ya?ml$/).map(f => parseWorkflow(f, read(f))),
        parsePreCommit('.pre-commit-config.yaml', read('.pre-commit-config.yaml')),
        parseEngines('package.json', read('package.json')),
        ...ls('.github', /^[^.]/).flatMap(dir => {
            const out = [];
            if (fs.existsSync(path.join(ROOT, dir, 'package.json')))
                out.push(parsePackageJson(`${dir}/package.json`, read(`${dir}/package.json`)));
            if (fs.existsSync(path.join(ROOT, dir, 'requirements.txt')))
                out.push(parseRequirements(`${dir}/requirements.txt`, read(`${dir}/requirements.txt`)));
            if (fs.existsSync(path.join(ROOT, dir, 'Dockerfile')))
                out.push(parseDockerfile(`${dir}/Dockerfile`, read(`${dir}/Dockerfile`)));
            return out;
        }),
    ];
    const floor = parts.flatMap(p => p.pins).find(p => p.kind === 'node' && p.floor)?.current;
    const seen = new Set();
    const pins = [];
    for (const p of parts.flatMap(x => x.pins)) {
        // One check per (kind, name, version): checkout@v7.0.1 is pinned in
        // thirteen places and is one decision. A CI node-version equal to the
        // engines floor is that floor, not a second LTS claim.
        const pin = p.kind === 'node' && p.current === floor ? {...p, floor: true} : p;
        const key = `${pin.kind} ${pin.name} ${pin.current} ${pin.floor ?? ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            pins.push(pin);
        }
    }
    return {pins, errors: parts.flatMap(p => p.errors)};
}

async function defaultIo() {
    let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token) {
        try {
            token = (await run('gh', ['auth', 'token'])).stdout.trim();
        } catch {
            token = '';
        }
    }
    return {
        fetch: (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(30000)}),
        exec: async (cmd, args, opts = {}) => (await run(cmd, args, {maxBuffer: 64 << 20, timeout: 120000, ...opts})).stdout,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        token,
    };
}

function report(results) {
    let failed = 0;
    for (const r of results) {
        const mark = {pass: '  ok  ', info: '  --  ', fail: '  XX  '}[r.level];
        console.log(`${mark}${r.msg}`);
        if (r.level === 'fail')
            failed++;
    }
    return failed;
}

async function upstreamFor(io, pin, hold) {
    const track = hold?.track ?? null;
    switch (pin.kind) {
    case 'action':
    case 'hook':
        return githubLatest(io, pin.name, track);
    case 'npm':
        return npmLatest(io, pin.name, pin.current);
    case 'pip':
        return pypiLatest(io, pin.name);
    case 'docker':
        return dockerLatest(io, pin.name, pin.current, track);
    default:
        return {error: `no upstream for kind ${pin.kind}`};
    }
}

/** Freshness results, and the holds the run consulted. */
export async function freshness(io, {pins, holds, now = Date.now()}) {
    const results = [];
    const used = new Set();
    const prs = await dependabotPrs(io, REPO);
    if (prs === null)
        results.push({level: 'info', msg: 'open Dependabot PRs unreadable here - a bump in flight counts as stale'});
    const node = pins.some(p => p.kind === 'node') ? await nodeLines(io) : null;
    const checks = pins.map(async pin => {
        if (pin.kind === 'node')
            return node.error ? {level: 'fail', msg: `node: ${node.error} - UNKNOWN, not clean`} : nodeVerdict(pin, node.lines, now);
        const hold = holds.find(h => h.kind === pin.kind && h.name === pin.name) ?? null;
        const up = await upstreamFor(io, pin, hold);
        const openPr = up.latest ? prFor(prs, pin.name, up.latest) : null;
        return verdict(pin, up, {hold, openPr, now});
    });
    for (const r of await Promise.all(checks)) {
        if (r.hold)
            used.add(r.hold);
        results.push(r);
    }
    for (const h of holds.filter(x => x.kind !== 'audit' && !used.has(x)))
        results.push({level: 'fail', msg: `dependency-holds:${h.line}: ${h.kind} ${h.name} matches no pin - delete it`});
    return results;
}

/** `npm audit` of one .github/<tool> tree, in a scratch copy (never in place). */
async function npmAudit(io, dir) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-audit-'));
    try {
        for (const f of ['package.json', 'package-lock.json']) {
            if (fs.existsSync(path.join(ROOT, dir, f)))
                fs.copyFileSync(path.join(ROOT, dir, f), path.join(tmp, f));
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

export async function audit(io, {pins, holds}) {
    const results = [];
    const accepted = holds.filter(h => h.kind === 'audit');
    const used = new Set();
    const judge = (name, id, what) => {
        const hold = accepted.find(h => h.name === name && h.version === id);
        if (hold) {
            used.add(hold);
            return {level: 'info', msg: `${what}: ACCEPTED (dependency-holds:${hold.line}): ${hold.reason}`};
        }
        return {level: 'fail', msg: `${what}: known advisory - take the fixed version, or declare it with the reason`};
    };
    const osv = await osvAdvisories(io, pins);
    if (osv.error)
        results.push({level: 'fail', msg: `OSV: ${osv.error} - advisories UNKNOWN, not clean`});
    else {
        for (const {pin, ids} of osv.found)
            ids.forEach(id => results.push(judge(pin.name, id, `${pin.kind} ${pin.name} ${pin.current} ${id}`)));
        if (!osv.found.length)
            results.push({level: 'pass', msg: `OSV: no advisory for the ${pins.filter(p => ['npm', 'pip', 'action'].includes(p.kind)).length} direct npm/PyPI/Actions pins`});
    }
    for (const dir of [...new Set(pins.filter(p => p.kind === 'npm').map(p => path.posix.dirname(p.file)))]) {
        const r = await npmAudit(io, dir);
        if (r.error)
            results.push({level: 'fail', msg: `npm audit ${dir}: ${r.error} - UNKNOWN, not clean`});
        else if (!r.found.length)
            results.push({level: 'pass', msg: `npm audit ${dir}: no advisory in the tree`});
        else
            r.found.forEach(f => results.push(judge(f.name, f.id, `npm audit ${dir}: ${f.name} ${f.id} (${f.severity}) ${f.title}`)));
    }
    for (const h of accepted.filter(x => !used.has(x)))
        results.push({level: 'fail', msg: `dependency-holds:${h.line}: audit ${h.name} ${h.version} matches no finding - delete it`});
    return results;
}

async function main(argv) {
    const mode = argv[0] ?? 'all';
    if (!['all', 'freshness', 'audit'].includes(mode)) {
        console.error('usage: node scripts/check-deps.mjs [freshness|audit]');
        return 2;
    }
    const inv = inventory();
    const held = parseHolds(fs.existsSync(path.join(ROOT, HOLDS)) ? read(HOLDS) : '');
    const errors = [...inv.errors, ...held.errors];
    errors.forEach(e => console.log(`  XX  ${e}`));
    const io = await defaultIo();
    const ctx = {pins: inv.pins, holds: held.holds};
    let failed = errors.length;
    if (mode !== 'audit') {
        console.log(`freshness - ${inv.pins.length} pins`);
        failed += report(await freshness(io, ctx));
    }
    if (mode !== 'freshness') {
        console.log('advisories');
        failed += report(await audit(io, ctx));
    }
    console.log(failed ? `check-deps: ${failed} finding(s)` : 'check-deps: clean');
    return failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
    process.exitCode = await main(process.argv.slice(2));
