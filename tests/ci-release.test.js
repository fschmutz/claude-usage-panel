// CI and release plumbing: the checks that keep a release honest (built from
// its tag, matching its version), the pins that keep CI reproducible (actions,
// hooks, images and tools pinned where Dependabot can see them), the Node the
// package claims, and the file-size ceiling. Workflows are read as text: there
// is no YAML dependency and the assertions are about exact lines.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {run} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** The body of one top-level job of a workflow, as text. */
function job(workflow, name) {
    const lines = read(workflow).split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    assert.ok(start >= 0, `${workflow} has no job ${name}`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

test('release: both jobs check out the tag, resolved before the checkout', () => {
    const release = job('.github/workflows/release.yml', 'release');
    const resolve = release.indexOf('name: Resolve tag');
    const checkout = release.indexOf('uses: actions/checkout@');
    assert.ok(resolve >= 0 && checkout > resolve, 'the tag must be resolved before the checkout');
    assert.match(release, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+ref: refs\/tags\/\$\{\{ steps\.t\.outputs\.tag \}\}/);
    assert.match(release, /scripts\/check-versions\.sh --tag "\$TAG"/);
    const mac = job('.github/workflows/release.yml', 'macos-asset');
    assert.match(mac, /uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+ref: refs\/tags\/\$\{\{ needs\.release\.outputs\.tag \}\}/);
    for (const body of [release, mac]) {
        assert.match(body, /git rev-parse HEAD\)" = "\$\(git rev-parse "refs\/tags\/\$TAG\^\{commit\}"\)"/);
    }
});

test('check-versions --tag: passes on the package.json version, fails on any other', () => {
    const script = path.join(ROOT, 'scripts/check-versions.sh');
    assert.equal(run('bash', [script, '--tag', `v${pkg.version}`]).status, 0);
    const wrong = run('bash', [script, '--tag', 'v999.0.0']);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /tag v999\.0\.0 does not match package\.json/);
    assert.equal(run('bash', [script, '--tag']).status, 2);
});

test('plugin: the npx spec is pinned to the release tag of package.json', () => {
    const args = JSON.parse(read('plugin/.mcp.json')).mcpServers['claude-usage'].args;
    assert.deepEqual(args, ['-y', `github:fschmutz/claude-usage-panel#v${pkg.version}`]);
    assert.match(read('scripts/version-sites.sh'), /"plugin\/\.mcp\.json\|npxref\|github:fschmutz\/claude-usage-panel"/);
});

test('version-sites npxref: write pins an unpinned spec, read gets it back', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-npxref-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, '{"args": ["-y", "github:fschmutz/claude-usage-panel"]}\n');
    const sites = path.join(ROOT, 'scripts/version-sites.sh');
    const key = 'github:fschmutz/claude-usage-panel';
    const sh = (v) => run('bash', ['-c', '. "$1"; version_site_write "$2" npxref "$3" "$4"; version_site_read "$2" npxref "$3"', '_', sites, file, key, v]);
    assert.equal(sh('3.4.5').stdout.trim(), '3.4.5');
    assert.equal(sh('3.4.6').stdout.trim(), '3.4.6');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"args": ["-y", "github:fschmutz/claude-usage-panel#v3.4.6"]}\n');
});

test('ci lint: no composite that resolves actions by tag or installs an unpinned pre-commit', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.doesNotMatch(ci, /pre-commit\/action@/);
    assert.match(job('.github/workflows/ci.yml', 'lint'), /pip install [^\n]*-r \.github\/pre-commit\/requirements\.txt/);
    assert.match(read('.github/pre-commit/requirements.txt'), /^pre-commit==\d+\.\d+\.\d+$/m);
    for (const wf of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
        for (const m of read(`.github/workflows/${wf}`).matchAll(/uses: (\S+)/g)) {
            assert.match(m[1], /@[0-9a-f]{40}$/, `${wf}: ${m[1]} is not SHA-pinned`);
        }
    }
});

test('pre-commit: every remote hook is frozen to a SHA, and Dependabot watches every pin', () => {
    const revs = [...read('.pre-commit-config.yaml').matchAll(/^\s+rev: (.*)$/gm)].map((m) => m[1]);
    assert.ok(revs.length >= 8, 'expected the remote hook repos');
    for (const rev of revs) assert.match(rev, /^[0-9a-f]{40} {2}# frozen: v\S+$/);
    const eco = [...read('.github/dependabot.yml').matchAll(/package-ecosystem: (\S+)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(eco)].sort(), ['docker', 'github-actions', 'npm', 'pip', 'pre-commit']);
    assert.match(read('.github/dependabot.yml'), /directory: \/\.github\/claude-cli/);
    assert.match(read('.github/dependabot.yml'), /directory: \/\.github\/bash32/);
    assert.match(read('.github/dependabot.yml'), /directory: \/\.github\/pre-commit/);
    assert.match(read('.github/dependabot.yml'), /directory: \/\.github\/swift/);
});

test('swift-core: the toolchain image is pinned by digest, the package is in Swift 6 mode', () => {
    const from = read('.github/swift/Dockerfile').match(/^FROM (\S+)$/m)[1];
    assert.match(from, /^swift:\d+\.\d+(\.\d+)?-\w+@sha256:[0-9a-f]{64}$/);
    const body = job('.github/workflows/ci.yml', 'swift-core');
    assert.match(body, /docker build [^\n]*\.github\/swift/);
    assert.doesNotMatch(body, /setup-swift/);
    assert.match(read('macos/Package.swift'), /^\/\/ swift-tools-version: 6\.\d/);
    assert.doesNotMatch(read('macos/Package.swift'), /StrictConcurrency|swiftLanguageMode\(\.v5\)/);
});

test('bash32: the image is pinned by digest and CI never names a bare bash tag', () => {
    const from = read('.github/bash32/Dockerfile').match(/^FROM (\S+)$/m)[1];
    assert.match(from, /^bash:3\.2\.\d+@sha256:[0-9a-f]{64}$/);
    const body = job('.github/workflows/ci.yml', 'bash32');
    assert.doesNotMatch(body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /bash:3/);
    assert.match(body, /docker build [^\n]*\.github\/bash32/);
});

test('node: CI runs the engines floor, and nothing below it', () => {
    const floor = Number(pkg.engines.node.match(/^>=(\d+)$/)[1]);
    assert.ok(floor >= 22, `engines floor ${floor} names an end-of-life Node`);
    const js = job('.github/workflows/ci.yml', 'js');
    const matrix = js.match(/node: \[([^\]]+)\]/)[1].split(',').map((s) => Number(s.replace(/["\s]/g, '')));
    assert.equal(Math.min(...matrix), floor, 'the js matrix must run the declared floor');
    for (const m of read('.github/workflows/ci.yml').matchAll(/node-version: "(\d+)"/g)) {
        assert.ok(Number(m[1]) >= floor, `node-version ${m[1]} is below the engines floor`);
    }
});

// The file-size gate, run against a throwaway repo holding a copy of it.
function sizeRepo(t, exempt) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-size-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.mkdirSync(path.join(dir, 'scripts'));
    let src = read('scripts/check-file-size.sh');
    src = src.replace(/EXEMPT=\(\n[\s\S]*?\n\)/, `EXEMPT=(\n${exempt.map((e) => `    "${e}"`).join('\n')}\n)`);
    fs.writeFileSync(path.join(dir, 'scripts/check-file-size.sh'), src);
    run('git', ['init', '-q', dir]);
    return dir;
}
const lines = (n) => 'x\n'.repeat(n);
const size = (dir) => run('bash', [path.join(dir, 'scripts/check-file-size.sh')], {cwd: dir});

test('file size: 700 lines passes, 701 fails unless the file is declared', (t) => {
    const dir = sizeRepo(t, ['LOG.md|append-only']);
    fs.writeFileSync(path.join(dir, 'LOG.md'), lines(900));
    fs.writeFileSync(path.join(dir, 'ok.js'), lines(700));
    assert.equal(size(dir).status, 0);
    fs.writeFileSync(path.join(dir, 'big.js'), lines(701));
    const r = size(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /big\.js: 701 lines/);
});

test('file size: an exemption that matches no oversized file fails (delete it)', (t) => {
    const dir = sizeRepo(t, ['LOG.md|append-only', 'gone/*.po|generated']);
    fs.writeFileSync(path.join(dir, 'LOG.md'), lines(900));
    const r = size(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /exemption 'gone\/\*\.po' matches no file/);
});

test('file size: the repo itself is within the ceiling', () => {
    const r = run('bash', [path.join(ROOT, 'scripts/check-file-size.sh')]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(read('.pre-commit-config.yaml'), /entry: scripts\/check-file-size\.sh/);
});

// ── C49: the plugin manifests, validated by a pinned Claude Code CLI ─────────

test('ci plugin-validate: a pinned CLI validates both manifests strictly, behind ci-gate', () => {
    const body = job('.github/workflows/ci.yml', 'plugin-validate');
    assert.match(body, /npm ci [^\n]*\n\s+working-directory: \.github\/claude-cli/);
    assert.match(body, /plugin validate --strict "\$target"/);
    assert.match(body, /for target in \. plugin; do/);
    assert.match(body, /grep -qi 'warning'/, 'a warning in the output fails the job too');
    const cli = JSON.parse(read('.github/claude-cli/package.json'));
    const want = cli.dependencies['@anthropic-ai/claude-code'];
    assert.match(want, /^\d+\.\d+\.\d+$/, 'an exact version, never a range');
    const lock = JSON.parse(read('.github/claude-cli/package-lock.json'));
    assert.equal(lock.packages['node_modules/@anthropic-ai/claude-code'].version, want);
    const needs = job('.github/workflows/ci.yml', 'ci-gate').match(/needs: \[([^\]]+)\]/)[1].split(/,\s*/);
    assert.ok(needs.includes('plugin-validate'), 'plugin-validate must be in ci-gate needs:');
});

test('ci: every job declared in ci.yml is in ci-gate needs, and permissions are job-level', () => {
    const ci = read('.github/workflows/ci.yml');
    const jobs = [...ci.split('\njobs:\n')[1].matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    const needs = job('.github/workflows/ci.yml', 'ci-gate').match(/needs: \[([^\]]+)\]/)[1].split(/,\s*/);
    assert.deepEqual(jobs.filter((j) => j !== 'ci-gate').sort(), [...needs].sort());
    for (const wf of fs.readdirSync(path.join(ROOT, '.github/workflows'))) {
        assert.match(read(`.github/workflows/${wf}`), /^permissions: \{\}$/m, `${wf}: workflow-level permissions must be {}`);
    }
    for (const j of jobs) assert.match(job('.github/workflows/ci.yml', j), /\n {4}permissions:/, `ci.yml ${j}: no job-level permissions`);
});

// ── R9: GNOME Shell releases vs metadata.json ─────────────────────────────────

function gnomeCheck(t, {shellVersion, tags}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-gnome-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const meta = path.join(dir, 'metadata.json');
    fs.writeFileSync(meta, JSON.stringify({uuid: 'x', 'shell-version': shellVersion}, null, 2));
    const refs = path.join(dir, 'refs.json');
    fs.writeFileSync(refs, JSON.stringify(tags.map((tag) => ({ref: `refs/tags/${tag}`, object: {sha: '0'.repeat(40)}}))));
    return run('bash', [path.join(ROOT, 'scripts/check-gnome-shell-version.sh'), '--refs-file', refs], {
        env: {PATH: '/usr/bin:/bin', GNOME_SHELL_METADATA: meta},
    });
}

test('gnome-shell check: passes when the newest stable major is listed', (t) => {
    const r = gnomeCheck(t, {shellVersion: ['45', '46', '47'], tags: ['3.38.4', '46.2', '47.0', '47.1', '48.alpha', '48.beta', '48.rc']});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /newest stable GNOME Shell is 47, metadata\.json covers up to 47/);
});

test('gnome-shell check: fails when a newer stable major is out', (t) => {
    const r = gnomeCheck(t, {shellVersion: ['46', '47'], tags: ['46.0', '47.3', '48.0', '49.alpha']});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /GNOME Shell 48 is out; metadata\.json shell-version stops at 47/);
});

test('gnome-shell check: majors compare as numbers, and no stable tag is an error', (t) => {
    assert.equal(gnomeCheck(t, {shellVersion: ['10', '9'], tags: ['9.0', '10.1']}).status, 0);
    assert.equal(gnomeCheck(t, {shellVersion: ['10'], tags: ['9.4']}).status, 0, '"9" > "10" only as strings');
    assert.equal(gnomeCheck(t, {shellVersion: ['9'], tags: ['9.4', '10.0']}).status, 1);
    const none = gnomeCheck(t, {shellVersion: ['47'], tags: ['48.alpha', '48.rc']});
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no stable gnome-shell tag/);
});

test('gnome-shell workflow: weekly + metadata.json edits, never behind ci-gate', () => {
    const wf = read('.github/workflows/gnome-shell.yml');
    assert.match(wf, /schedule:\n\s+- cron: "[^"]+"/);
    assert.match(wf, /pull_request:\n\s+paths:\n\s+- "claude-usage-panel@fschmutz\.github\.io\/metadata\.json"/);
    assert.match(job('.github/workflows/gnome-shell.yml', 'shell-version'), /run: \.\/scripts\/check-gnome-shell-version\.sh$/m);
    assert.doesNotMatch(read('.github/workflows/ci.yml'), /check-gnome-shell-version/);
    const real = run('bash', [path.join(ROOT, 'scripts/check-gnome-shell-version.sh'), '--refs-file', '/dev/null']);
    assert.equal(real.status, 2, 'an empty upstream answer must never pass');
});

// ── R11: the Homebrew tap ─────────────────────────────────────────────────────

const TOKEN = 'ghp_TESTtokenNEVERinARGV0123456789';
const PINNED = 'a'.repeat(64);
const cask = (version, sha = `"${PINNED}"`) =>
    `cask "claude-usage-panel" do\n  version "${version}"\n  sha256 ${sha}\n\n  url "https://example.invalid/v#{version}.zip"\nend\n`;

/** A bare "tap" with one commit on main, a fake git that logs its argv, and
 *  a runner for publish-cask.sh against them. */
function tapRepo(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-tap-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const env = {PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', TMPDIR: dir};
    const bare = path.join(dir, 'tap.git');
    run('git', ['init', '-q', '--bare', '-b', 'main', bare], {env});
    const seed = path.join(dir, 'seed');
    run('git', ['clone', '-q', bare, seed], {env});
    fs.writeFileSync(path.join(seed, 'README.md'), 'tap\n');
    run('git', ['-C', seed, 'add', '.'], {env});
    run('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], {env});
    run('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main'], {env});
    // Every git call the script makes goes through this wrapper, which records
    // its argv and whether the auth header applies to the tap URL.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'git-argv.log');
    fs.writeFileSync(path.join(bin, 'git'), [
        '#!/bin/bash',
        `printf 'ARGV %s\\n' "$*" >> '${log}'`,
        `printf 'HEADER %s\\n' "$(/usr/bin/git config --get-urlmatch http.extraheader "$TAP_URL/info/refs")" >> '${log}'`,
        'exec /usr/bin/git "$@"',
        '',
    ].join('\n'), {mode: 0o755});
    const publish = (version, file, extra = {}) =>
        run('bash', [path.join(ROOT, 'scripts/publish-cask.sh'), version, file], {
            env: {...env, PATH: `${bin}:/usr/bin:/bin`, TAP_URL: `file://${bare}`, HOMEBREW_TAP_TOKEN: TOKEN, ...extra},
        });
    const file = (name, text) => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, text);
        return p;
    };
    const tapGit = (...args) => run('git', ['--git-dir', bare, ...args], {env}).stdout;
    return {publish, file, tapGit, log, dir};
}

test('publish-cask: commits the cask to the tap main, token only in the scoped env header', (t) => {
    const tap = tapRepo(t);
    const r = tap.publish('v2.3.0', tap.file('c.rb', cask('2.3.0')));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(tap.tapGit('log', '-1', '--format=%s', 'main').trim(), 'claude-usage-panel 2.3.0');
    assert.equal(tap.tapGit('show', 'main:Casks/claude-usage-panel.rb'), cask('2.3.0'));
    const log = fs.readFileSync(tap.log, 'utf8');
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.match(log, /^ARGV clone /m);
    assert.match(log, /^ARGV push /m);
    for (const line of log.split('\n').filter((l) => l.startsWith('ARGV'))) {
        assert.ok(!line.includes(TOKEN) && !line.includes(b64), `token in git argv: ${line}`);
    }
    assert.match(log, new RegExp(`^HEADER AUTHORIZATION: basic ${b64}$`, 'm'), 'the header must apply to the tap URL');
    for (const out of [r.stdout, r.stderr]) assert.ok(!out.includes(TOKEN) && !out.includes(b64));
    assert.ok(!tap.tapGit('cat-file', '-p', 'main').includes(TOKEN));
});

test('publish-cask: publishing the same cask again is a no-op, a new one is one commit', (t) => {
    const tap = tapRepo(t);
    const c = tap.file('c.rb', cask('2.3.0'));
    assert.equal(tap.publish('2.3.0', c).status, 0);
    const again = tap.publish('2.3.0', c);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already has claude-usage-panel 2\.3\.0/);
    assert.equal(tap.tapGit('rev-list', '--count', 'main').trim(), '2');
    assert.equal(tap.publish('2.4.0', tap.file('d.rb', cask('2.4.0'))).status, 0);
    assert.equal(tap.tapGit('rev-list', '--count', 'main').trim(), '3');
});

test('publish-cask: refuses the template, a version mismatch and a missing token', (t) => {
    const tap = tapRepo(t);
    const template = tap.publish('2.3.0', tap.file('t.rb', cask('2.3.0', ':no_check')));
    assert.equal(template.status, 1);
    assert.match(template.stderr, /no pinned sha256/);
    const wrong = tap.publish('2.3.0', tap.file('w.rb', cask('2.2.0')));
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /is version '2\.2\.0', expected 2\.3\.0/);
    const noToken = tap.publish('2.3.0', tap.file('n.rb', cask('2.3.0')), {HOMEBREW_TAP_TOKEN: ''});
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /HOMEBREW_TAP_TOKEN is not set/);
    assert.equal(tap.tapGit('rev-list', '--count', 'main').trim(), '1', 'nothing reached the tap');
});

test('release homebrew-tap: runs after the cask asset, secret only in the step env', () => {
    const body = job('.github/workflows/release.yml', 'homebrew-tap');
    assert.match(body, /needs: \[release, macos-asset\]/);
    assert.match(body, /permissions:\n\s+contents: read/);
    assert.match(body, /gh release download "\$TAG" --pattern claude-usage-panel\.rb/);
    assert.match(body, /HOMEBREW_TAP_TOKEN: \$\{\{ secrets\.HOMEBREW_TAP_TOKEN \}\}\n\s+TAG: [^\n]+\n\s+run: \.\/scripts\/publish-cask\.sh "\$TAG" /);
    assert.match(job('.github/workflows/release.yml', 'macos-asset'), /gh release upload "\$TAG" "Casks\/claude-usage-panel\.rb"/);
});
