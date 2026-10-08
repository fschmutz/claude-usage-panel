// scripts/check-deps.mjs, offline: the inventory over the real tree, the
// freshness rule, the holds, and the advisory pass against recorded upstream
// answers. Nothing here reaches a registry.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {audit, freshness, inventory} from '../scripts/check-deps.mjs';
import {
    parseDockerfile, parseHolds, parsePackageJson, parsePreCommit, parseWorkflow,
} from '../scripts/deps/inventory.mjs';
import {prFor} from '../scripts/deps/sources.mjs';
import {GRACE_DAYS, compareVersions, newest, nodeVerdict, verdict, versionParts} from '../scripts/deps/verdict.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-10-08T00:00:00Z');

test('inventory: the real tree parses with no error, and every pin-shaped line is a pin', () => {
    const {pins, errors} = inventory();
    assert.deepEqual(errors, []);
    const workflows = fs.readdirSync(path.join(ROOT, '.github/workflows')).map(f => read(`.github/workflows/${f}`)).join('\n');
    const actions = new Set([...workflows.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@/g)].map(m => m[1]));
    assert.deepEqual(new Set(pins.filter(p => p.kind === 'action').map(p => p.name)), actions);
    const revs = read('.pre-commit-config.yaml').match(/^\s+rev:/gm).length;
    assert.equal(pins.filter(p => p.kind === 'hook').length, revs);
    // every tool dir under .github is read, whatever it pins
    const tools = fs.readdirSync(path.join(ROOT, '.github'), {withFileTypes: true}).filter(d => d.isDirectory());
    const has = f => tools.filter(d => fs.existsSync(path.join(ROOT, '.github', d.name, f))).map(d => `.github/${d.name}/${f}`);
    assert.deepEqual(new Set(pins.filter(p => p.kind === 'npm').map(p => p.file)), new Set(has('package.json')));
    assert.deepEqual(new Set(pins.filter(p => p.kind === 'docker').map(p => p.file)), new Set(has('Dockerfile')));
    assert.deepEqual(new Set(pins.filter(p => p.kind === 'pip').map(p => p.file)), new Set(has('requirements.txt')));
    const floor = pins.filter(p => p.kind === 'node' && p.floor).map(p => p.current);
    assert.deepEqual([...new Set(floor)], ['22'], 'the CI matrix floor is the engines floor');
});

test('inventory: a pin the gate cannot read is an error, never skipped', () => {
    assert.equal(parseWorkflow('w.yml', '      - uses: actions/checkout@v4\n').errors.length, 1, 'a tag');
    assert.equal(parseWorkflow('w.yml', `      - uses: actions/checkout@${'a'.repeat(40)}\n`).errors.length, 1, 'no version comment');
    assert.equal(parseWorkflow('w.yml', '      - uses: ./local-action\n').errors.length, 0, 'a local action is not a pin');
    assert.equal(parsePreCommit('p.yaml', '  - repo: https://github.com/a/b\n    rev: v1.0.0\n').errors.length, 1);
    assert.equal(parseDockerfile('Dockerfile', 'FROM bash:3.2\n').errors.length, 1);
    assert.equal(parsePackageJson('package.json', '{"dependencies":{"x":"^1.0.0"}}').errors.length, 1);
});

test('versions: packaging revisions order, pre-releases never win, track narrows', () => {
    assert.deepEqual(versionParts('v7.0.1'), [7, 0, 1]);
    assert.equal(versionParts('2.0.0-rc1'), null);
    assert.equal(compareVersions('v0.11.0.1-1', 'v0.11.0.1'), 1);
    assert.equal(compareVersions('3.14.1-1', '3.14.2'), -1);
    assert.equal(compareVersions('v10.12.0', 'v10.9.0'), 1, 'numeric, not lexical');
    assert.equal(newest(['v1.2.0', 'v1.10.0', 'v2.0.0-beta', 'v1']), 'v1.10.0');
    assert.equal(newest(['3.2.57', '5.3.3', '3.2.9', '3.20.1'], '3.2'), '3.2.57', '3.20 is not 3.2');
});

const pin = {kind: 'npm', name: 'x', current: '1.0.0', file: 'f'};
const up = (latest, ageDays, extra = {}) => ({latest, publishedAt: NOW - ageDays * DAY, ...extra});

test('verdict: current passes, stale fails, unknown fails', () => {
    assert.equal(verdict(pin, up('1.0.0', 90), {now: NOW}).level, 'pass');
    assert.equal(verdict(pin, up('1.1.0', GRACE_DAYS + 1), {now: NOW}).level, 'fail');
    assert.equal(verdict(pin, {error: 'ECONNRESET'}, {now: NOW}).level, 'fail');
    assert.equal(verdict(pin, {latest: null}, {now: NOW}).level, 'fail');
});

test("verdict: inside Dependabot's window, or with its PR open, a bump is in flight", () => {
    assert.equal(verdict(pin, up('1.1.0', GRACE_DAYS - 1), {now: NOW}).level, 'info');
    const r = verdict(pin, up('1.1.0', 60), {openPr: 41, now: NOW});
    assert.equal(r.level, 'info');
    assert.match(r.msg, /PR #41/);
});

test('verdict: a hold covers exactly the release it was taken against', () => {
    const hold = {kind: 'npm', name: 'x', version: '1.1.0', reason: 'r', line: 3};
    assert.equal(verdict(pin, up('1.1.0', 60), {hold, now: NOW}).level, 'info');
    assert.match(verdict(pin, up('1.2.0', 60), {hold, now: NOW}).msg, /upstream is now 1\.2\.0/);
    assert.match(verdict({...pin, current: '1.1.0'}, up('1.1.0', 60), {hold, now: NOW}).msg, /delete the hold/);
});

test('verdict: ahead of the latest tag is current unless deprecated; a moved digest is due', () => {
    assert.equal(verdict({...pin, current: '2.0.0'}, up('1.9.0', 60), {now: NOW}).level, 'info');
    assert.equal(verdict({...pin, current: '2.0.0'}, up('1.9.0', 60, {deprecated: true}), {now: NOW}).level, 'fail');
    const img = {kind: 'docker', name: 'swift', current: '6.4-noble', digest: 'sha256:a', file: 'D'};
    const moved = {latest: '6.4-noble', digest: 'sha256:b', digestUpdatedAt: NOW - 30 * DAY};
    assert.equal(verdict(img, moved, {now: NOW}).level, 'fail');
    assert.equal(verdict(img, {...moved, digest: 'sha256:a'}, {now: NOW}).level, 'pass');
});

test('node: an end-of-life floor fails, CI must be on the active LTS once it settled', () => {
    const lines = [
        {major: 22, ltsSince: NOW - 700 * DAY, eol: NOW + 200 * DAY},
        {major: 24, ltsSince: NOW - 300 * DAY, eol: NOW + 900 * DAY},
        {major: 26, ltsSince: NOW - 3 * DAY, eol: NOW + 1000 * DAY},
    ];
    assert.equal(nodeVerdict({current: '22', floor: true, file: 'p'}, lines, NOW).level, 'pass');
    assert.equal(nodeVerdict({current: '22', floor: true, file: 'p'}, lines, NOW + 201 * DAY).level, 'fail');
    assert.equal(nodeVerdict({current: '24', file: 'ci'}, lines, NOW).level, 'pass', '26 is LTS for 3 days only');
    assert.equal(nodeVerdict({current: '24', file: 'ci'}, lines, NOW + 30 * DAY).level, 'fail');
});

test('holds: a line without a reason is malformed, and a Node line cannot be held', () => {
    assert.equal(parseHolds('npm x 1.0.0\n').errors.length, 1);
    assert.equal(parseHolds('node node 22 we like it\n').errors.length, 1);
    const {holds} = parseHolds('# c\ndocker bash track:3.2 the bash macOS ships\n');
    assert.deepEqual(holds, [{kind: 'docker', name: 'bash', version: null, track: '3.2', reason: 'the bash macOS ships', line: 2}]);
});

test("dependabot.yml is the grace window: weekly, 7-day cooldown, and bash held where the holds say", () => {
    const yml = read('.github/dependabot.yml');
    const entries = yml.split(/\n {2}- package-ecosystem:/).slice(1);
    assert.ok(entries.length >= 5);
    for (const e of entries) {
        assert.match(e, /interval: weekly/);
        assert.match(e, /default-days: 7/);
    }
    assert.equal(GRACE_DAYS, 7 + 7);
    assert.match(yml, /dependency-name: bash\n\s+versions: \[">= 3\.3"\]/);
    const {holds} = parseHolds(read('.github/dependency-holds'));
    assert.ok(holds.some(h => h.kind === 'docker' && h.name === 'bash' && h.track === '3.2'));
});

test('dependabot PR titles find the bump they carry', () => {
    const prs = [
        {number: 7, title: 'chore(deps): bump knip from 6.39.0 to 6.40.0 in /.github/knip'},
        {number: 8, title: 'chore(deps): bump eslint-plugin-knip from 1.0.0 to 6.40.0'},
        {number: 9, title: 'chore(deps): bump bash from 3.2.5 to 3.2.57 in /.github/bash32'},
        {number: 10, title: 'chore(deps): bump actions/setup-node from 7.0.0 to 7.1.0'},
        {number: 11, title: 'chore(deps): bump the actions-minor group with 3 updates'},
        {number: 12, title: 'chore(deps): bump https://github.com/gitleaks/gitleaks from v8.30.1 to v8.31.0'},
        {number: 13, title: 'chore(deps): bump swift from `64bab76` to `9f3c2d1` in /.github/swift'},
    ];
    assert.equal(prFor(prs, 'gitleaks/gitleaks', 'v8.31.0'), 12, 'a hook is named by its repo URL');
    assert.equal(prFor(prs, 'swift', `sha256:9f3c2d1${'0'.repeat(57)}`), 13, 'a digest bump');
    assert.equal(prFor(prs, 'knip', '6.40.0'), 7);
    assert.equal(prFor(prs, 'knip', '6.41.0'), null);
    assert.equal(prFor(prs, 'bash', '3.2.5'), null, '3.2.5 is not 3.2.57');
    assert.equal(prFor(prs, 'actions/setup-node', 'v7.1.0'), 10, 'a v-tag matches its bare version');
    assert.equal(prFor(prs, 'actions/cache', 'v6.2.0'), null, 'a group PR names no single pin');
    assert.equal(prFor(null, 'knip', '6.40.0'), null);
});

// A recorded upstream: npm registry + an empty Dependabot PR list.
function fakeIo(npm, {osv = {results: []}, auditJson = '{"vulnerabilities":{}}'} = {}) {
    const json = body => ({ok: true, status: 200, json: async () => body});
    return {
        token: '',
        sleep: async () => {},
        fetch: async (url, init) => {
            if (url.includes('/pulls'))
                return json([]);
            if (url.startsWith('https://registry.npmjs.org/'))
                return json(npm[decodeURIComponent(url.split('/').pop())]);
            if (url.includes('osv.dev') && init?.method === 'POST')
                return json(osv);
            return {ok: false, status: 404};
        },
        exec: async (cmd, args) => {
            if (cmd === 'npm' && args[0] === 'audit')
                return auditJson;
            return '';
        },
    };
}

test('freshness: a hold that matches no pin fails - delete it', async () => {
    const io = fakeIo({x: {'dist-tags': {latest: '1.0.0'}, time: {'1.0.0': '2026-01-01'}, versions: {}}});
    const {holds} = parseHolds('npm gone 1.0.0 nothing pins it any more\n');
    const r = await freshness(io, {pins: [pin], holds, now: NOW});
    assert.ok(r.some(x => x.level === 'pass' && x.msg.startsWith('npm x')));
    assert.ok(r.some(x => x.level === 'fail' && /matches no pin - delete it/.test(x.msg)));
});

test('audit: an advisory fails unless declared, and a declaration nothing hits fails too', async () => {
    // a tool dir that does not exist: npmAudit works on a scratch copy and
    // asks the (fake) npm, so no real tree is read
    const npmPin = {kind: 'npm', name: 'x', current: '1.0.0', file: 'tests/no-such-tool/package.json'};
    const auditJson = JSON.stringify({vulnerabilities: {y: {via: [
        {name: 'y', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high', title: 'bad'},
    ]}}});
    const io = fakeIo({}, {osv: {results: [{vulns: [{id: 'GHSA-1111-2222-3333'}]}]}, auditJson});
    const bare = await audit(io, {pins: [npmPin], holds: []});
    assert.equal(bare.filter(r => r.level === 'fail').length, 2, 'the OSV hit and the transitive one');
    const {holds} = parseHolds([
        'audit x GHSA-1111-2222-3333 not reachable: the CLI never parses untrusted input',
        'audit y GHSA-aaaa-bbbb-cccc dev-only path, fixed upstream in the next release',
        'audit z GHSA-zzzz-zzzz-zzzz stale',
    ].join('\n'));
    const declared = await audit(io, {pins: [npmPin], holds});
    assert.deepEqual(declared.filter(r => r.level === 'fail').map(r => r.msg),
        ['dependency-holds:3: audit z GHSA-zzzz-zzzz-zzzz matches no finding - delete it']);
});
