// Tests for the daily auto-update path: scripts/auto-update.sh (version
// ordering + the guards that decide whether a checkout may be touched) and the
// `autoupdate` install target's dry-run wiring.
//
// Everything here is offline: the "remote" is a local bare repo, so the real
// `git ls-remote` / `merge --ff-only` code paths run without network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'auto-update.sh');

// Run a command, returning {status, stdout, stderr} without throwing on a
// non-zero exit (the script uses exit codes as its API).
function run(cmd, args, opts = {}) {
    try {
        // Explicit stdio: execFileSync otherwise leaks the child's stderr into
        // the test runner's own output instead of capturing it.
        const stdout = execFileSync(cmd, args, {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            ...opts,
        });
        return {status: 0, stdout, stderr: ''};
    } catch (e) {
        return {status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
    }
}

const compare = (a, b) =>
    run('bash', [SCRIPT, '--version-compare', a, b]).stdout.trim();

test('version_compare orders released versions', () => {
    assert.equal(compare('1.5.0', '1.5.0'), '0');
    assert.equal(compare('1.6.0', '1.5.0'), '1');
    assert.equal(compare('1.5.0', '1.6.0'), '-1');
    // Numeric, not lexical: 10 > 9, and 1.5.10 > 1.5.9.
    assert.equal(compare('1.10.0', '1.9.0'), '1');
    assert.equal(compare('1.5.10', '1.5.9'), '1');
    assert.equal(compare('2.0.0', '1.99.99'), '1');
    // Leading v, zero-padding and missing components are all tolerated.
    assert.equal(compare('v1.5.0', '1.5.0'), '0');
    assert.equal(compare('1.5', '1.5.0'), '0');
    assert.equal(compare('1.06.0', '1.6.0'), '0');
});

// ── A throwaway checkout wired to a local bare "origin" ─────────────────────────
// Layout mirrors the real repo closely enough for the script: package.json at
// the root, scripts/auto-update.sh, and an install.sh it can invoke.
function makeCheckout(t, {localVersion, tags}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-au-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const origin = path.join(dir, 'origin.git');
    const work = path.join(dir, 'work');
    const seed = path.join(dir, 'seed');
    const git = (cwd, ...args) =>
        execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', encoding: 'utf8'});

    execFileSync('git', ['init', '--bare', '-b', 'main', origin], {stdio: 'pipe'});
    execFileSync('git', ['init', '-b', 'main', seed], {stdio: 'pipe'});
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'test');

    const writeRepo = (root, version) => {
        fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({name: 'claude-usage-panel', version}, null, 2) + '\n',
        );
        fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'auto-update.sh'));
        fs.chmodSync(path.join(root, 'scripts', 'auto-update.sh'), 0o755);
        // Stand-in for the real installer: records that it ran. The log lives
        // outside the checkout, so running it can't dirty the worktree.
        fs.writeFileSync(
            path.join(root, 'install.sh'),
            '#!/usr/bin/env bash\necho "install.sh $*" >>"$HOME/install-calls.log"\n',
        );
        fs.chmodSync(path.join(root, 'install.sh'), 0o755);
    };

    writeRepo(seed, localVersion);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    for (const tag of tags ?? []) {
        git(seed, 'tag', tag);
    }
    if (tags?.length) git(seed, 'push', '-q', 'origin', '--tags');

    execFileSync('git', ['clone', '-q', origin, work], {stdio: 'pipe'});
    return {dir, origin, work, seed, git};
}

// The script keeps its state under XDG_STATE_HOME - point it at the sandbox so
// tests never touch the real ~/.local/state.
const env = (dir) => ({
    ...process.env,
    XDG_STATE_HOME: path.join(dir, 'state'),
    HOME: dir,
});

const runScript = (c, args) =>
    run('bash', [path.join(c.work, 'scripts', 'auto-update.sh'), ...args], {
        env: env(c.dir),
        cwd: c.work,
    });

test('--check reports an available update with exit code 10', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0', 'v1.6.0']});
    const r = runScript(c, ['--check']);
    assert.equal(r.status, 10);
    assert.match(r.stdout, /update available: v1\.5\.0 → v1\.6\.0/);
});

test('--check is quiet and exits 0 when the newest tag is already installed', (t) => {
    const c = makeCheckout(t, {localVersion: '1.6.0', tags: ['v1.5.0', 'v1.6.0']});
    const r = runScript(c, ['--check']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /up to date \(v1\.6\.0, latest v1\.6\.0\)/);
});

test('a prerelease-only remote is ignored (released tags only)', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0', 'v1.6.0-rc1']});
    const r = runScript(c, ['--check']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /up to date/);
});

test('a dirty worktree is skipped, never touched', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    const scratch = path.join(c.work, 'package.json');
    fs.writeFileSync(scratch, fs.readFileSync(scratch, 'utf8') + '\n');
    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: local changes/);
    // Untouched: no install run, and our edit survives.
    assert.equal(fs.existsSync(path.join(c.dir, 'install-calls.log')), false);
    assert.match(fs.readFileSync(scratch, 'utf8'), /\n\n$/);
});

test('a checkout with no origin is skipped', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    c.git(c.work, 'remote', 'remove', 'origin');
    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: no 'origin' remote/);
});

test('a detached HEAD is skipped', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    c.git(c.work, 'checkout', '-q', '--detach', 'HEAD');
    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: detached HEAD/);
});

test('a real update fast-forwards and reinstalls', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    // Cut v1.6.0 upstream, exactly as scripts/bump-version.sh + a tag would.
    const pkg = path.join(c.seed, 'package.json');
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('1.5.0', '1.6.0'));
    c.git(c.seed, 'commit', '-qam', 'chore(release): v1.6.0');
    c.git(c.seed, 'tag', 'v1.6.0');
    c.git(c.seed, 'push', '-q', 'origin', 'main', '--tags');

    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /updating v1\.5\.0 → v1\.6\.0/);
    assert.match(r.stdout, /updated to v1\.6\.0/);
    assert.match(fs.readFileSync(path.join(c.work, 'package.json'), 'utf8'), /1\.6\.0/);
    assert.match(
        fs.readFileSync(path.join(c.dir, 'install-calls.log'), 'utf8'),
        /install\.sh update/,
    );

    // Second run is a no-op: idempotent, no second install.
    const again = runScript(c, []);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /up to date \(v1\.6\.0/);
    assert.equal(
        fs.readFileSync(path.join(c.dir, 'install-calls.log'), 'utf8').trim().split('\n')
            .length,
        1,
    );
});

test('a diverged branch is refused rather than merged', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    // Upstream cuts v1.6.0…
    const pkg = path.join(c.seed, 'package.json');
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('1.5.0', '1.6.0'));
    c.git(c.seed, 'commit', '-qam', 'release');
    c.git(c.seed, 'tag', 'v1.6.0');
    c.git(c.seed, 'push', '-q', 'origin', 'main', '--tags');
    // …while the local branch grew its own committed commit.
    c.git(c.work, 'config', 'user.email', 'test@example.com');
    c.git(c.work, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(c.work, 'local.txt'), 'mine\n');
    c.git(c.work, 'add', '-A');
    c.git(c.work, 'commit', '-qm', 'local work');

    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not a fast-forward/);
    assert.equal(fs.existsSync(path.join(c.dir, 'install-calls.log')), false);
    assert.equal(fs.readFileSync(path.join(c.work, 'local.txt'), 'utf8'), 'mine\n');
});

test('--quiet prints nothing but still logs', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    const r = runScript(c, ['--check', '--quiet']);
    assert.equal(r.status, 10);
    assert.equal(r.stdout, '');
    const log = path.join(c.dir, 'state', 'claude-usage-panel', 'auto-update.log');
    assert.match(fs.readFileSync(log, 'utf8'), /update available/);
});

test('--status reports the local and remote versions', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    const r = runScript(c, ['--status']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /installed: +1\.5\.0/);
    assert.match(r.stdout, /latest: +1\.6\.0/);
});

// --status --json is the contract both UIs parse (macOS Settings > Updates,
// GNOME prefs > Updates). Shape changes here break them silently, so pin it.
test('--status --json emits the shape the UIs parse', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    const r = runScript(c, ['--status', '--json']);
    assert.equal(r.status, 0);
    const st = JSON.parse(r.stdout);
    assert.equal(st.installed, '1.5.0');
    assert.equal(st.latest, '1.6.0');
    assert.equal(st.updateAvailable, true);
    assert.equal(st.blocked, false);
    assert.equal(st.blockedReason, '');
    assert.equal(typeof st.lastCheck, 'string');
    assert.equal(typeof st.log, 'string');
});

// The case the Updates section exists for: a checkout auto-update refuses to
// touch must report blocked with a reason, not a bare "up to date".
test('--status --json reports why a dirty checkout is skipped', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    const scratch = path.join(c.work, 'package.json');
    fs.writeFileSync(scratch, fs.readFileSync(scratch, 'utf8') + '\n');
    const st = JSON.parse(runScript(c, ['--status', '--json']).stdout);
    assert.equal(st.blocked, true);
    assert.match(st.blockedReason, /local changes/);
});

test('an unknown flag exits 2 with usage', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: []});
    const r = runScript(c, ['--nope']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown option/);
});

// ── install.sh autoupdate ───────────────────────────────────────────────────────
test('install.sh --dry-run autoupdate writes nothing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-home-'));
    try {
        const r = run('bash', [path.join(ROOT, 'install.sh'), '--dry-run', 'autoupdate'], {
            env: {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config')},
        });
        assert.equal(r.status, 0);
        assert.match(r.stdout, /would: write .*claude-usage-panel-update\.(timer|service)|would: (write .*\.plist|add crontab line)/);
        assert.match(r.stdout, /dry-run: no changes written/);
        assert.deepEqual(fs.readdirSync(home), []);
    } finally {
        fs.rmSync(home, {recursive: true, force: true});
    }
});

test('autoupdate is a known target of install.sh', () => {
    const r = run('bash', [path.join(ROOT, 'install.sh'), '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /autoupdate\s+check for a new release once a day/);
});
