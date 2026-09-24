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

import {run} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'auto-update.sh');
const LIB = path.join(ROOT, 'scripts', 'lib.sh');

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

// Every git in here runs with the developer's own global and system config
// switched off. A machine-wide `core.hooksPath` (a pre-push confirm guard, for
// one) otherwise reaches into these throwaway repos and fails the seed push,
// so the suite would pass in CI and on a fresh clone while going red on the
// one machine that has the guard installed.
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
};

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
        execFileSync('git', ['-C', cwd, ...args], {stdio: 'pipe', encoding: 'utf8', env: GIT_ENV});

    execFileSync('git', ['init', '--bare', '-b', 'main', origin], {stdio: 'pipe', env: GIT_ENV});
    execFileSync('git', ['init', '-b', 'main', seed], {stdio: 'pipe', env: GIT_ENV});
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'test');

    const writeRepo = (root, version) => {
        fs.mkdirSync(path.join(root, 'scripts'), {recursive: true});
        fs.writeFileSync(
            path.join(root, 'package.json'),
            JSON.stringify({name: 'claude-usage-panel', version}, null, 2) + '\n',
        );
        // The worker sources lib.sh from its own directory, so the copy
        // travels with it - exactly as install.sh gnome / pack-gnome.sh ship it.
        fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'auto-update.sh'));
        fs.copyFileSync(LIB, path.join(root, 'scripts', 'lib.sh'));
        fs.chmodSync(path.join(root, 'scripts', 'auto-update.sh'), 0o755);
        // Stand-in for the real installer: records that it ran, and fails when
        // $HOME/install-exit says so (a partial install - no node on the
        // scheduler's PATH, /Applications not writable). Both the log and the
        // switch live outside the checkout, so neither can dirty the worktree,
        // which the worker would then refuse to touch.
        fs.writeFileSync(
            path.join(root, 'install.sh'),
            '#!/usr/bin/env bash\necho "install.sh $*" >>"$HOME/install-calls.log"\n'
                + 'exit "$(cat "$HOME/install-exit" 2>/dev/null || echo 0)"\n',
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

    execFileSync('git', ['clone', '-q', origin, work], {stdio: 'pipe', env: GIT_ENV});
    return {dir, origin, work, seed, git};
}

// The script keeps its state under XDG_STATE_HOME - point it at the sandbox so
// tests never touch the real ~/.local/state.
const env = (dir) => ({
    ...GIT_ENV,
    XDG_STATE_HOME: path.join(dir, 'state'),
    // Sandboxed too: the script reads the installed systemd unit from here to
    // find the checkout, and must not see the developer's real one.
    XDG_CONFIG_HOME: path.join(dir, 'config'),
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

// `install.sh gnome` copies this script beside the extension so prefs.js can
// run it, and that copy has no package.json and no git above it. Resolving the
// root from $0 alone made it die on `sed: can't read .../package.json`, which
// the Updates row rendered as "Cannot self-update / No git checkout found".
test('an installed copy outside any checkout resolves the scheduled one', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const unitDir = path.join(c.dir, 'config', 'systemd', 'user');
    fs.mkdirSync(unitDir, {recursive: true});
    fs.writeFileSync(
        path.join(unitDir, 'claude-usage-panel-update.service'),
        `[Service]\nExecStart=${path.join(c.work, 'scripts', 'auto-update.sh')} --quiet\n`,
    );
    const installed = path.join(c.dir, 'extension', 'scripts');
    fs.mkdirSync(installed, {recursive: true});
    fs.copyFileSync(SCRIPT, path.join(installed, 'auto-update.sh'));
    fs.copyFileSync(LIB, path.join(installed, 'lib.sh'));

    const r = run('bash', [path.join(installed, 'auto-update.sh'), '--status', '--json'], {
        env: env(c.dir),
        cwd: c.dir,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const st = JSON.parse(r.stdout);
    assert.equal(st.checkout, fs.realpathSync(c.work));
    assert.equal(st.checkout_version, '1.5.0');
    assert.equal(st.blocked, false);
});

test('with no checkout anywhere, --status stays valid JSON and says why', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const installed = path.join(c.dir, 'extension', 'scripts');
    fs.mkdirSync(installed, {recursive: true});
    fs.copyFileSync(SCRIPT, path.join(installed, 'auto-update.sh'));
    fs.copyFileSync(LIB, path.join(installed, 'lib.sh'));

    const r = run('bash', [path.join(installed, 'auto-update.sh'), '--status', '--json'], {
        env: env(c.dir),
        cwd: c.dir,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const st = JSON.parse(r.stdout);
    assert.equal(st.blocked, true);
    assert.match(st.blockedReason, /not a git checkout/);
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

// Upstream rewritten (a force-push to purge data): the same history with
// different SHAs, release tags re-pointed. Returns after cutting v1.6.0 on it.
function rewriteUpstream(c) {
    c.git(c.seed, 'commit', '-q', '--amend', '-m', 'seed (rewritten)');
    c.git(c.seed, 'tag', '-f', 'v1.5.0');
    const pkg = path.join(c.seed, 'package.json');
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('1.5.0', '1.6.0'));
    c.git(c.seed, 'commit', '-qam', 'chore(release): v1.6.0');
    c.git(c.seed, 'tag', 'v1.6.0');
    c.git(c.seed, 'push', '-q', '--force', 'origin', 'main');
    c.git(c.seed, 'push', '-q', '--force', 'origin', '--tags');
}

test('a rewritten upstream is followed when the checkout holds nothing of its own', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    rewriteUpstream(c);
    const r = runScript(c, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /upstream history was rewritten - following it/);
    assert.match(r.stdout, /updated to v1\.6\.0/);
    assert.equal(c.git(c.work, 'rev-parse', 'HEAD'), c.git(c.seed, 'rev-parse', 'HEAD'));
    // the re-pointed tag was taken, not refused
    assert.equal(c.git(c.work, 'rev-parse', 'v1.5.0^{}'), c.git(c.seed, 'rev-parse', 'v1.5.0^{}'));
});

test('a rewritten upstream never takes a local commit with it', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    c.git(c.work, 'config', 'user.email', 'test@example.com');
    c.git(c.work, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(c.work, 'local.txt'), 'mine\n');
    c.git(c.work, 'add', '-A');
    c.git(c.work, 'commit', '-qm', 'local work');
    const mine = c.git(c.work, 'rev-parse', 'HEAD');
    rewriteUpstream(c);
    const r = runScript(c, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /not a fast-forward/);
    assert.equal(c.git(c.work, 'rev-parse', 'HEAD'), mine);
    assert.equal(fs.readFileSync(path.join(c.work, 'local.txt'), 'utf8'), 'mine\n');
    assert.equal(fs.existsSync(path.join(c.dir, 'install-calls.log')), false);
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

// A manual `git pull` moves the checkout ahead of the installed clients. The
// daily run compares checkout-to-latest, matches, and never reinstalls - so the
// panel ran a release behind while --status said "up to date".
test('--status --json reports clients left behind by a manual pull', (t) => {
    const c = makeCheckout(t, {localVersion: '1.8.0', tags: ['v1.8.0']});
    // XDG_STATE_HOME is <dir>/state; the script namespaces under it.
    const stateDir = path.join(c.dir, 'state', 'claude-usage-panel');
    fs.mkdirSync(stateDir, {recursive: true});
    fs.writeFileSync(path.join(stateDir, 'installed-version'), '1.7.0\n');
    const st = JSON.parse(runScript(c, ['--status', '--json']).stdout);
    assert.equal(st.installed, '1.7.0', 'reports what is DEPLOYED');
    assert.equal(st.checkout_version, '1.8.0');
    assert.equal(st.clientsStale, true);
    assert.equal(st.updateAvailable, true, '1.8.0 is newer than the deployed 1.7.0');
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

// ── Deciding on the DEPLOYED version, not the checkout ──────────────────────────
// The blocker behind "the update never works": the run compared the checkout
// with the latest tag. Every path that leaves the clients behind the checkout -
// a manual pull, an install.sh that failed after the fast-forward, a partial
// install - therefore looked "up to date" forever, and the reinstall that
// would have fixed it was never attempted again.

/** The stamp that says what the CLIENTS run. */
const stampPath = (c) => path.join(c.dir, 'state', 'claude-usage-panel', 'installed-version');
const writeStamp = (c, v) => {
    fs.mkdirSync(path.dirname(stampPath(c)), {recursive: true});
    fs.writeFileSync(stampPath(c), `${v}\n`);
};
const installCalls = (c) => {
    try {
        return fs.readFileSync(path.join(c.dir, 'install-calls.log'), 'utf8').trim().split('\n');
    } catch {
        return [];
    }
};
/** Make the stub installer fail, the way a partial install does. */
const breakInstaller = (c) => fs.writeFileSync(path.join(c.dir, 'install-exit'), '1\n');

test('clients behind the checkout are reinstalled, with no fast-forward to do', (t) => {
    const c = makeCheckout(t, {localVersion: '1.6.0', tags: ['v1.6.0']});
    writeStamp(c, '1.5.0');
    const r = runScript(c, []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already holds v1\.6\.0 - reinstalling the clients \(on v1\.5\.0\)/);
    assert.match(r.stdout, /updated to v1\.6\.0/);
    assert.deepEqual(installCalls(c), ['install.sh update']);
    assert.equal(fs.readFileSync(stampPath(c), 'utf8').trim(), '1.6.0');
});

test('a reinstall that failed is retried on the next run, not declared done', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const pkg = path.join(c.seed, 'package.json');
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('1.5.0', '1.6.0'));
    c.git(c.seed, 'commit', '-qam', 'chore(release): v1.6.0');
    c.git(c.seed, 'tag', 'v1.6.0');
    c.git(c.seed, 'push', '-q', 'origin', 'main', '--tags');
    breakInstaller(c);

    const first = runScript(c, []);
    assert.equal(first.status, 1);
    assert.match(first.stdout, /install\.sh update failed at v1\.6\.0/);
    assert.equal(fs.existsSync(stampPath(c)), false, 'a failed install is never stamped');

    // The checkout is now at 1.6.0, which is exactly the state that used to
    // read as "up to date" and strand the clients on 1.5.0 forever.
    const second = runScript(c, []);
    assert.equal(second.status, 1);
    assert.equal(installCalls(c).length, 2, 'it tries again');
});

test('the update installs the release tag, not whatever main has since grown', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const pkg = path.join(c.seed, 'package.json');
    fs.writeFileSync(pkg, fs.readFileSync(pkg, 'utf8').replace('1.5.0', '1.6.0'));
    c.git(c.seed, 'commit', '-qam', 'chore(release): v1.6.0');
    c.git(c.seed, 'tag', 'v1.6.0');
    // Unreleased work lands on main after the tag.
    fs.writeFileSync(path.join(c.seed, 'unreleased.txt'), 'not in any release\n');
    c.git(c.seed, 'add', '-A');
    c.git(c.seed, 'commit', '-qm', 'feat: after the release');
    c.git(c.seed, 'push', '-q', 'origin', 'main', '--tags');

    assert.equal(runScript(c, []).status, 0);
    assert.equal(
        c.git(c.work, 'rev-parse', 'HEAD').trim(),
        c.git(c.seed, 'rev-parse', 'v1.6.0^{}').trim(),
        'the checkout sits on the tag',
    );
    assert.equal(fs.existsSync(path.join(c.work, 'unreleased.txt')), false);
});

test('a git failure is reported as itself, and is not counted as a check', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.6.0']});
    c.git(c.work, 'remote', 'set-url', 'origin', path.join(c.dir, 'gone.git'));
    const r = run('bash', [path.join(c.work, 'scripts', 'auto-update.sh')], {
        env: {...env(c.dir), CUP_RETRY_TRIES: '1'},
        cwd: c.work,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: .*(does not appear to be a git repository|not a git repository|Could not read)/i);
    assert.doesNotMatch(r.stdout, /offline/);
    assert.equal(
        fs.existsSync(path.join(c.dir, 'state', 'claude-usage-panel', 'last-check')),
        false,
        'a failed lookup is not a check - otherwise the freshness window swallows the next real one',
    );
});

test('a reachable remote with no release tag says so', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: []});
    const r = run('bash', [path.join(c.work, 'scripts', 'auto-update.sh')], {
        env: {...env(c.dir), CUP_RETRY_TRIES: '1'},
        cwd: c.work,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no vX\.Y\.Z release tag/);
});

// Scheduled runs are allowed to fire often (at load, at resume, daily) because
// of this window; without it, RunAtLoad would check on every login.
test('a scheduled run inside the freshness window is a no-op; a manual one is not', (t) => {
    const c = makeCheckout(t, {localVersion: '1.6.0', tags: ['v1.6.0']});
    assert.equal(runScript(c, ['--quiet']).status, 0);
    const log = path.join(c.dir, 'state', 'claude-usage-panel', 'auto-update.log');
    const after = (mark) => fs.readFileSync(log, 'utf8').split(mark).pop();

    assert.equal(runScript(c, ['--quiet']).status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /skip: checked \d+ min ago/);

    // Not quiet: the user asked, so it checks whatever the window says.
    const manual = runScript(c, []);
    assert.match(manual.stdout, /up to date/);
    assert.equal(after('') !== null, true);
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

// ── Read-only means read-only ─────────────────────────────────────────────────
// scripts/lib.sh promises that a status query leaves a HOME that has never run
// a job exactly as it found it. Both workers used to create their state dir
// before even looking at --status.
test('--status creates no state dir, in either worker', (t) => {
    const c = makeCheckout(t, {localVersion: '1.5.0', tags: ['v1.5.0']});
    const state = path.join(c.dir, 'state');
    assert.equal(runScript(c, ['--status']).status, 0);
    assert.equal(fs.existsSync(state), false, 'auto-update.sh --status wrote into the state dir');

    const r = run('bash', [path.join(ROOT, 'scripts', 'session-ping.sh'), '--status'], {
        env: {...env(c.dir), SP_TEST_CLAUDE_PATHS: ''},
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(state), false, 'session-ping.sh --status wrote into the state dir');
});

// ── A checkout path that needs quoting ────────────────────────────────────────
// systemd and cron both split their command on blanks, and cron hands it to
// /bin/sh: a checkout under "Dev & Ops" installed jobs that could never start.
// The path is written quoted, and runner_in() - how the installed copies find
// the checkout again - has to read that quoting back.
test('systemd and cron jobs keep a checkout path with blanks, quotes and % whole', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-q-'));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    const checkout = path.join(home, "Dev & Ops", "it's 100% $HOME");
    fs.mkdirSync(checkout, {recursive: true});
    fs.copyFileSync(path.join(ROOT, 'install.sh'), path.join(checkout, 'install.sh'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(checkout, 'package.json'));
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(checkout, 'scripts'), {recursive: true});
    execFileSync('git', ['init', '-q', checkout], {stdio: 'pipe', env: GIT_ENV});
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const [name, body] of [
        ['systemctl', 'exit 0'],
        // Written through a temp file: `crontab -l | … | crontab -` reads the
        // table while the new one is written, as the real crontab allows.
        ['crontab', 'case "$1" in -l) cat "$HOME/crontab.txt" 2>/dev/null || exit 1 ;;'
            + ' *) cat >"$HOME/crontab.new" && mv "$HOME/crontab.new" "$HOME/crontab.txt" ;; esac'],
    ]) {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        fs.chmodSync(path.join(bin, name), 0o755);
    }
    const unitDir = path.join(home, 'config', 'systemd', 'user');
    const runner = path.join(checkout, 'scripts', 'auto-update.sh');

    // An installed copy of the worker outside any checkout, so it has to find
    // the checkout through the schedule alone.
    const copy = path.join(home, 'extension', 'scripts');
    fs.mkdirSync(copy, {recursive: true});
    fs.copyFileSync(SCRIPT, path.join(copy, 'auto-update.sh'));
    fs.copyFileSync(LIB, path.join(copy, 'lib.sh'));
    const resolved = () => {
        fs.rmSync(path.join(home, 'state', 'claude-usage-panel', 'checkout-path'), {force: true});
        const r = run('bash', [path.join(copy, 'auto-update.sh'), '--status', '--json'],
            {env: {...env(home), PATH: `${bin}:/usr/bin:/bin`}});
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout).checkout;
    };
    const install = (scheduler) => {
        const r = run('bash', [path.join(checkout, 'install.sh'), 'autoupdate', 'sessionping', '06:00'], {
            env: {...env(home), PATH: `${bin}:/usr/bin:/bin`, CUP_TEST_SCHEDULER: scheduler},
        });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    };

    install('systemd');
    for (const unit of ['claude-usage-panel-update', 'claude-usage-panel-sessionping']) {
        const exec = /^ExecStart=(.*)$/m.exec(fs.readFileSync(path.join(unitDir, `${unit}.service`), 'utf8'))[1];
        assert.match(exec, /^"[^"]*Dev & Ops\/it's 100%% \$\$HOME\/scripts\/[a-z-]+\.sh" --quiet/, exec);
    }
    assert.equal(resolved(), checkout, 'runner_in lost the quoted systemd path');

    fs.rmSync(unitDir, {recursive: true});
    install('cron');
    const lines = fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) {
        // What /bin/sh gets once cron has turned \% back into %.
        const command = line.replace(/ {2}#.*$/, '').replace(/^(\S+ +){5}/, '').replace(/\\%/g, '%');
        const argv = run('bash', ['-c', `set -- ${command}; printf '%s\\n' "$@"`]).stdout.split('\n');
        assert.match(argv[0], /^\/.*\/Dev & Ops\/it's 100% \$HOME\/scripts\/(auto-update|session-ping)\.sh$/, line);
        assert.equal(argv[1], '--quiet');
    }
    assert.equal(resolved(), checkout, 'runner_in lost the quoted cron path');
    assert.ok(lines.find((l) => l.includes('auto-update')).includes(`'${runner.slice(0, 5)}`),
        'the path is single-quoted for /bin/sh');
});
