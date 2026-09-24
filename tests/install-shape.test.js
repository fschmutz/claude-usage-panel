// What `./install.sh update` does in the SHAPE a real update runs in - which
// is not the shape the rest of the suite exercises. The daily job runs it from
// a scheduler, with a minimal PATH and with clients already installed, and
// every defect these tests pin was invisible to a stubbed installer:
//
//   - no node on the scheduler's PATH: the Node clients were dropped from the
//     update set, the run exited 0, and the new version was recorded as
//     installed while two-month-old code kept running;
//   - nothing but the daily job ever wrote the installed-version stamp, so a
//     manual or curl install left it absent and the whole update decision read
//     a guess;
//   - the launchd agent reinstalled itself from inside its own job, which
//     killed the job halfway through.
//
// Everything runs against a throwaway HOME with stub schedulers on PATH.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const stateDir = (home) => path.join(home, 'state', 'claude-usage-panel');
const stamp = (home) => path.join(stateDir(home), 'installed-version');

// The scheduler's environment: our stubs first, then the bare PATH a systemd
// user service or a launchd agent actually gets. `node` is deliberately absent
// unless a test adds it back.
const env = (home, extra = {}) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
    ...extra,
});

const withNode = (home, extra = {}) =>
    env(home, {PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`, ...extra});

/** A HOME that already has the status line and the CLI installed. */
function installedHome(t, {segments = 'context,limits,tokens,ping', tokens = 'all'} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-shape-'});
    const r = run('bash', [INSTALL, 'statusline', 'cli', `--segments=${segments}`, `--tokens=${tokens}`],
        {env: withNode(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return home;
}

test('a fresh install records the version and the checkout - not only the daily job', (t) => {
    const home = installedHome(t);
    assert.equal(fs.readFileSync(stamp(home), 'utf8').trim(), VERSION);
    assert.equal(
        fs.readFileSync(path.join(stateDir(home), 'checkout-path'), 'utf8').trim(),
        ROOT,
        'the pointer the extension copy and the macOS app resolve the checkout through',
    );
});

test('update with no node on PATH fails loudly and records nothing', (t) => {
    const home = installedHome(t);
    fs.rmSync(stamp(home));

    const r = run('bash', [INSTALL, 'update'], {env: env(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /could not be reinstalled/);
    assert.match(r.stderr, /statusline: Node\.js not found/);
    assert.match(r.stderr, /cli: Node\.js not found/);
    assert.equal(fs.existsSync(stamp(home)), false, 'a partial update is never stamped');
});

test('the installed set is read without node, so nothing is silently dropped', (t) => {
    const home = installedHome(t);
    const r = run('bash', [INSTALL, '--list'], {env: env(home)});
    assert.equal(r.status, 0, r.stderr);
    const installed = /installed: +([^(]*)/.exec(r.stdout)[1];
    assert.match(installed, /statusline/);
    assert.match(installed, /cli/);
});

test('update keeps the status-line segments the user chose', (t) => {
    const home = installedHome(t, {segments: 'limits,account', tokens: 'fresh'});
    const settings = path.join(home, '.claude', 'settings.json');
    assert.match(fs.readFileSync(settings, 'utf8'), /--segments=limits,account --tokens=fresh/);

    const r = run('bash', [INSTALL, 'update'], {env: withNode(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(
        fs.readFileSync(settings, 'utf8'),
        /--segments=limits,account --tokens=fresh/,
        'an update must not reset the segments to the defaults',
    );

    // …and an explicit flag still wins.
    run('bash', [INSTALL, 'statusline', '--segments=context'], {env: withNode(home)});
    assert.match(fs.readFileSync(settings, 'utf8'), /--segments=context --tokens=fresh/);
});

// The blocker this file exists for: on macOS the daily job runs `install.sh
// update`, which reinstalls the autoupdate target, which used to `launchctl
// bootout` the very job it was running in. launchd then SIGTERMs the process
// group - so the bootstrap on the next line, the remaining targets, the stamp
// and the notification all never happened.
test('the launchd agent is not booted out from inside its own update run', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-launchd-'});
    const launchdEnv = (extra) => withNode(home, {CUP_TEST_SCHEDULER: 'launchd', ...extra});

    assert.equal(run('bash', [INSTALL, 'autoupdate'], {env: launchdEnv()}).status, 0);
    const plist = path.join(home, 'Library', 'LaunchAgents',
        'io.github.fschmutz.claude-usage-panel.update.plist');
    assert.ok(fs.existsSync(plist));
    const calls = () => fs.readFileSync(path.join(home, 'scheduler-calls.log'), 'utf8');
    assert.match(calls(), /launchctl bootstrap/, 'the first install does load it');

    // A rewritten plist, so the "unchanged, nothing to do" path is not what is
    // being tested: this is the reload path, from inside the job.
    fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace('<integer>17<', '<integer>18<'));
    fs.writeFileSync(path.join(home, 'scheduler-calls.log'), '');

    const r = run('bash', [INSTALL, 'update'], {env: launchdEnv({CUP_UPDATE_RUN: '1'})});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(calls(), /bootout/, 'booting out the running job kills the update');
    assert.match(r.stdout, /applies at the next login/);
    assert.match(fs.readFileSync(plist, 'utf8'), /<integer>17</, 'the new plist is written anyway');
    assert.equal(fs.readFileSync(stamp(home), 'utf8').trim(), VERSION);
});

test('uninstalling everything drops the state the update path reads', (t) => {
    const home = installedHome(t);
    assert.ok(fs.existsSync(stamp(home)));
    // The default stub answers every `claude` call with 0, which would keep
    // reporting the MCP server as installed; this one answers honestly.
    fs.writeFileSync(path.join(home, 'bin', 'claude'),
        '#!/bin/sh\ncase "$1 $2" in "mcp get") exit 1 ;; esac\nexit 0\n');
    fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
    const r = run('bash', [INSTALL, '--uninstall', 'statusline', 'cli'], {env: withNode(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(stamp(home)), false);
    assert.equal(fs.existsSync(path.join(stateDir(home), 'checkout-path')), false);
});

test('outside its own job, a changed agent is reloaded as before', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-launchd-'});
    const launchdEnv = withNode(home, {CUP_TEST_SCHEDULER: 'launchd'});
    assert.equal(run('bash', [INSTALL, 'autoupdate'], {env: launchdEnv}).status, 0);
    const plist = path.join(home, 'Library', 'LaunchAgents',
        'io.github.fschmutz.claude-usage-panel.update.plist');
    fs.writeFileSync(plist, 'stale\n');
    fs.writeFileSync(path.join(home, 'scheduler-calls.log'), '');

    assert.equal(run('bash', [INSTALL, 'update'], {env: launchdEnv}).status, 0);
    const calls = fs.readFileSync(path.join(home, 'scheduler-calls.log'), 'utf8');
    assert.match(calls, /bootout/);
    assert.match(calls, /bootstrap/);
});

// ── Failure isolation: one target failing never takes the run down ──────────

/** A stub executable in the sandbox's bin dir. */
function stub(home, name, body) {
    fs.writeFileSync(path.join(home, 'bin', name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(home, 'bin', name), 0o755);
}

/** The `claude` stub answers `mcp get` honestly (not installed). */
const honestClaude = (home) => stub(home, 'claude', 'case "$1 $2" in "mcp get") exit 1 ;; esac\nexit 0');

/**
 * A throwaway copy of the installer (install.sh, scripts/, package.json and an
 * empty macos/) so a build step that writes into $ROOT/macos never touches
 * the real checkout.
 */
function installerCopy(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-root-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.copyFileSync(INSTALL, path.join(dir, 'install.sh'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
    fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'macos'));
    return dir;
}

/** uname says Darwin and `swift build` fails, as on a Mac with a broken toolchain. */
function brokenMac(home) {
    stub(home, 'uname', 'case "$1" in -s|"") echo Darwin ;; *) /bin/uname "$@" ;; esac');
    stub(home, 'swift', 'echo "error: compile failed" >&2\nexit 1');
    for (const tool of ['osascript', 'open', 'codesign']) stub(home, tool, 'exit 0');
}

test('a failed swift build fails the macOS target instead of shipping an empty bundle', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-mac-'});
    brokenMac(home);
    const root = installerCopy(t);

    const r = run('bash', [path.join(root, 'install.sh'), 'macos', '--build-only'], {env: withNode(home)});
    assert.notEqual(r.status, 0, 'release.yml runs this very command: a zero exit publishes a binary-less zip');
    assert.match(r.stdout, /macos: the build failed/);
    assert.doesNotMatch(r.stdout, /ok +built/);
    assert.equal(fs.existsSync(path.join(root, 'macos', 'ClaudeUsagePanel.app')), false);
    assert.equal(fs.existsSync(stamp(home)), false, 'a failed build is never stamped');
});

test('update carries on past a target that failed hard, and says which one', (t) => {
    const home = installedHome(t);
    brokenMac(home);
    fs.rmSync(stamp(home));
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{}\n');

    const r = run('bash', [INSTALL, 'update', 'macos', 'statusline'], {env: withNode(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Claude Code status line/, 'the target after the failed one still ran');
    assert.match(fs.readFileSync(settings, 'utf8'), /statusline\.js/);
    assert.match(r.stderr, /could not be reinstalled:[\s\S]*macos: the build failed/);
    assert.equal(fs.existsSync(stamp(home)), false);
});

test('a GNOME pack that fails leaves the installed extension in place and the run going', (t) => {
    const home = installedHome(t);
    stub(home, 'glib-compile-schemas', 'exit 0');
    stub(home, 'gnome-extensions', 'exit 1');
    stub(home, 'gsettings', 'exit 0');
    stub(home, 'cpio', 'echo "cpio: broken" >&2\nexit 1');
    const ext = path.join(home, '.local', 'share', 'gnome-shell', 'extensions',
        'claude-usage-panel@fschmutz.github.io');
    fs.mkdirSync(ext, {recursive: true});
    fs.writeFileSync(path.join(ext, 'extension.js'), '// the working install\n');
    fs.rmSync(stamp(home));

    const r = run('bash', [INSTALL, 'update', 'gnome', 'statusline'], {env: withNode(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(fs.readFileSync(path.join(ext, 'extension.js'), 'utf8'), '// the working install\n',
        'the panel must survive a failed pack');
    assert.match(r.stdout, /Claude Code status line/, 'the next target still ran');
    assert.match(r.stderr, /gnome: packing the extension failed/);
    assert.deepEqual(
        fs.readdirSync(path.join(home, '.local', 'share', 'gnome-shell')).filter((n) => n.startsWith('.cup-')),
        [], 'no staging dir left behind');
    assert.equal(fs.existsSync(stamp(home)), false);
});

test('a GNOME reinstall swaps the new tree in whole', (t) => {
    const home = installedHome(t);
    stub(home, 'glib-compile-schemas', 'exit 0');
    stub(home, 'gnome-extensions', 'exit 1');
    stub(home, 'gsettings', 'exit 0');
    const shell = path.join(home, '.local', 'share', 'gnome-shell');
    const ext = path.join(shell, 'extensions', 'claude-usage-panel@fschmutz.github.io');
    fs.mkdirSync(ext, {recursive: true});
    fs.writeFileSync(path.join(ext, 'stale.js'), '// from an older release\n');

    const r = run('bash', [INSTALL, 'gnome'], {env: withNode(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(ext, 'extension.js')));
    assert.ok(fs.existsSync(path.join(ext, 'scripts', 'auto-update.sh')));
    assert.equal(fs.existsSync(path.join(ext, 'stale.js')), false, 'the old tree is replaced, not merged into');
    assert.deepEqual(fs.readdirSync(shell).filter((n) => n.startsWith('.cup-')), []);
});

// ── Uninstall ─────────────────────────────────────────────────────────────────

test('a bare --uninstall removes what is installed, opt-in sessionping included', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-uninst-'});
    honestClaude(home);
    const unit = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unit, {recursive: true});
    fs.writeFileSync(path.join(unit, 'claude-usage-panel-sessionping.timer'), '[Timer]\n');

    const r = run('bash', [INSTALL, '--uninstall', '--dry-run'],
        {env: withNode(home, {CUP_TEST_SCHEDULER: 'systemd'})});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /==> uninstall: sessionping {2}\(dry-run\)/);
});

test('a bare --uninstall with nothing installed says so', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-uninst-'});
    honestClaude(home);
    const r = run('bash', [INSTALL, '--uninstall'], {env: withNode(home)});
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Nothing installed to uninstall/);
});

test('uninstalling the status line without node skips loudly and still removes the rest', (t) => {
    const home = installedHome(t);
    const cli = path.join(home, '.local', 'bin', 'claudectl');
    assert.ok(fs.existsSync(cli));

    const r = run('bash', [INSTALL, '--uninstall', 'statusline', 'cli'], {env: env(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /command not found/);
    assert.match(r.stderr, /could not be fully removed:[\s\S]*statusline: Node\.js not found/);
    assert.equal(fs.existsSync(cli), false, 'the target after it was still uninstalled');
    assert.match(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), /statusline\.js/,
        'nothing half-edited');
});

test('uninstalling the MCP server without node does not claim the Cursor entry is gone', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-uninst-'});
    honestClaude(home);
    const mcp = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(mcp), {recursive: true});
    const body = '{"mcpServers": {"claude-usage": {"command": "node", "args": ["x"]}}}\n';
    fs.writeFileSync(mcp, body);

    const r = run('bash', [INSTALL, '--uninstall', 'mcp'], {env: env(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /ok +removed/);
    assert.match(r.stderr, /mcp: Node\.js not found/);
    assert.equal(fs.readFileSync(mcp, 'utf8'), body);
});

// skip_fatal has one channel, INCOMPLETE_LOG: every target runs in a
// subshell, so a variable copy of the record died there. A skip_fatal with no
// log to write to must fail, never report success with the record gone.
test('skip_fatal records to the log from inside a subshell, and refuses to run without one', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-skipfatal-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const ui = path.join(ROOT, 'scripts', 'install', 'ui.sh');
    const log = path.join(dir, 'incomplete.log');
    fs.writeFileSync(log, '');

    const logged = run('bash', ['-c', 'set -eu; . "$1"; INCOMPLETE_LOG="$2"; ( set -e; skip_fatal "demo: no scheduler" )',
        '_', ui, log]);
    assert.equal(logged.status, 0, logged.stderr);
    assert.equal(fs.readFileSync(log, 'utf8'), '  demo: no scheduler\n');

    const lost = run('bash', ['-c', 'set -eu; . "$1"; ( set -e; skip_fatal "demo: no scheduler" )', '_', ui]);
    assert.notEqual(lost.status, 0, 'a record with nowhere to go must not pass silently');
    assert.match(lost.stderr, /no INCOMPLETE_LOG[\s\S]*demo: no scheduler/);
});
