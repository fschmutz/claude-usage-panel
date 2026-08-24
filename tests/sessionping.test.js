// Tests for the scheduled session pings: scripts/session-ping.sh (day guard,
// claude resolution, ping invocation) and the `sessionping` install target's
// argument handling + dry-run wiring.
//
// Everything here is offline: `claude` is a stub on a sandboxed PATH that
// records its argv, and HOME/XDG_* point at throwaway directories.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-ping.sh');
const INSTALL = path.join(ROOT, 'install.sh');

// Run a command, returning {status, stdout, stderr} without throwing on a
// non-zero exit (the script uses exit codes as its API).
function run(cmd, args, opts = {}) {
    try {
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

// A sandbox HOME with stub executables on its own bin dir: `claude` appends
// its argv to $HOME/claude-calls.log, and `crontab` serves $HOME/crontab.txt
// so no test ever reads (or writes!) the developer's real crontab.
function makeSandbox(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-sp-'));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
        path.join(bin, 'claude'),
        '#!/bin/sh\necho "$@" >>"$HOME/claude-calls.log"\n',
    );
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
    fs.writeFileSync(
        path.join(bin, 'crontab'),
        '#!/bin/sh\n'
            + 'case "$1" in\n'
            + '    -l) cat "$HOME/crontab.txt" 2>/dev/null || exit 1 ;;\n'
            + '    *) cat >"$HOME/crontab.txt" ;;\n'
            + 'esac\n',
    );
    fs.chmodSync(path.join(bin, 'crontab'), 0o755);
    // launchctl/systemctl operate on the REAL user domain regardless of HOME -
    // a sandboxed uninstall would otherwise boot out the developer's actual
    // session-ping agent. install.sh calls them unqualified, so PATH stubs
    // (which just record the call) keep every test inside the sandbox.
    for (const tool of ['launchctl', 'systemctl']) {
        fs.writeFileSync(
            path.join(bin, tool),
            `#!/bin/sh\necho "${tool} $@" >>"$HOME/scheduler-calls.log"\n`,
        );
        fs.chmodSync(path.join(bin, tool), 0o755);
    }
    return home;
}

// PATH and the script's probe list (SP_TEST_CLAUDE_PATHS) are fully replaced:
// the script must find only the stub, never a real `claude` install, and
// "claude missing" tests point both at directories with no claude at all.
const env = (home, {withClaude = true, extra = {}} = {}) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: withClaude ? `${path.join(home, 'bin')}:/usr/bin:/bin` : '/usr/bin:/bin',
    SP_TEST_CLAUDE_PATHS: withClaude ? path.join(home, 'bin') : path.join(home, 'nowhere'),
    ...extra,
});

const calls = (home) => {
    const f = path.join(home, 'claude-calls.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

// ── scripts/session-ping.sh ─────────────────────────────────────────────────────
test('pings claude with the expected argv and records last-ping', (t) => {
    const home = makeSandbox(t);
    const r = run('bash', [SCRIPT, '--force'], {env: env(home)});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pinged \(model haiku\)/);
    const argv = calls(home);
    assert.match(argv, /-p ping/);
    assert.match(argv, /--model haiku/);
    assert.match(argv, /--max-turns 1/);
    // NOT --strict-mcp-config: claude rejects it when an enterprise MCP
    // config exists, which would break every scheduled ping on such machines.
    assert.doesNotMatch(argv, /--strict-mcp-config/);
    assert.equal(
        fs.existsSync(path.join(home, 'state', 'claude-usage-panel', 'last-ping')),
        true,
    );
});

test('skips days that are not configured, unless forced', (t) => {
    const home = makeSandbox(t);
    // Saturday against the Mon-Fri default: skip, no claude call.
    let r = run('bash', [SCRIPT], {env: env(home, {extra: {SP_TEST_WEEKDAY: '6'}})});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: not a configured day/);
    assert.equal(calls(home), '');
    // Saturday explicitly configured: ping.
    r = run('bash', [SCRIPT, '--days=6'], {env: env(home, {extra: {SP_TEST_WEEKDAY: '6'}})});
    assert.equal(r.status, 0);
    assert.match(calls(home), /--model haiku/);
    // --force overrides the day guard.
    r = run('bash', [SCRIPT, '--force'], {env: env(home, {extra: {SP_TEST_WEEKDAY: '7'}})});
    assert.equal(r.status, 0);
    assert.equal(calls(home).trim().split('\n').length, 2);
});

test('a weekday within the default list pings without --force', (t) => {
    const home = makeSandbox(t);
    const r = run('bash', [SCRIPT], {env: env(home, {extra: {SP_TEST_WEEKDAY: '3'}})});
    assert.equal(r.status, 0);
    assert.match(calls(home), /--model haiku/);
});

test('a missing claude CLI is a skip (exit 0), not an error', (t) => {
    const home = makeSandbox(t);
    const r = run('bash', [SCRIPT, '--force'], {env: env(home, {withClaude: false})});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skip: claude CLI not found/);
    assert.equal(calls(home), '');
});

test('a failing claude exits 1', (t) => {
    const home = makeSandbox(t);
    fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\nexit 3\n');
    fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
    const r = run('bash', [SCRIPT, '--force'], {env: env(home)});
    assert.equal(r.status, 1);
    assert.match(r.stdout, /error: the claude ping failed/);
});

test('--quiet prints nothing but still logs the ping', (t) => {
    const home = makeSandbox(t);
    const r = run('bash', [SCRIPT, '--force', '--quiet'], {env: env(home)});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const log = path.join(home, 'state', 'claude-usage-panel', 'session-ping.log');
    assert.match(fs.readFileSync(log, 'utf8'), /pinged \(model haiku\)/);
});

test('--status reports never, then the last ping', (t) => {
    const home = makeSandbox(t);
    let r = run('bash', [SCRIPT, '--status'], {env: env(home)});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /last ping: {2}never/);
    assert.match(r.stdout, /schedule: {3}not installed/);
    run('bash', [SCRIPT, '--force'], {env: env(home)});
    r = run('bash', [SCRIPT, '--status'], {env: env(home)});
    assert.match(r.stdout, /last ping: {2}\d{4}-/);
});

test('bad arguments exit 2', (t) => {
    const home = makeSandbox(t);
    let r = run('bash', [SCRIPT, '--nope'], {env: env(home)});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown option/);
    r = run('bash', [SCRIPT, '--days=8'], {env: env(home)});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--days wants/);
});

// ── install.sh sessionping ──────────────────────────────────────────────────────
const runInstall = (home, args) =>
    run('bash', [INSTALL, ...args], {env: env(home)});

test('install.sh --dry-run sessionping writes nothing and shows the schedule', (t) => {
    const home = makeSandbox(t);
    fs.rmSync(path.join(home, 'bin'), {recursive: true}); // keep readdir clean
    const r = runInstall(home, ['--dry-run', 'sessionping', '5:30', '10:35', '--days=mon,wed,fri']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /schedule: at 05:30 10:35 on days 1,3,5/);
    assert.match(r.stdout, /would: write .*sessionping\.(timer|service|plist)|would: add crontab line/);
    assert.match(r.stdout, /dry-run: no changes written/);
    assert.deepEqual(fs.readdirSync(home), []);
});

test('install.sh sessionping defaults to 05:30 Mon-Fri', (t) => {
    const home = makeSandbox(t);
    const r = runInstall(home, ['--dry-run', 'sessionping']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /schedule: at 05:30 on days 1,2,3,4,5/);
});

test('a reinstall with no arguments preserves the scheduled times and days', (t) => {
    const home = makeSandbox(t);
    // Fabricate the systemd artifacts exactly as install_sessionping writes
    // them - _sp_current_times/_sp_current_days probe files, not the platform.
    const unit = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unit, {recursive: true});
    fs.writeFileSync(
        path.join(unit, 'claude-usage-panel-sessionping.service'),
        '[Service]\nType=oneshot\nExecStart=/x/session-ping.sh --quiet --days=1,3,5\n',
    );
    fs.writeFileSync(
        path.join(unit, 'claude-usage-panel-sessionping.timer'),
        '[Timer]\nOnCalendar=*-*-* 06:15:00\nOnCalendar=*-*-* 11:45:00\nPersistent=false\n',
    );
    const r = runInstall(home, ['--dry-run', 'sessionping']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /schedule: at 06:15 11:45 on days 1,3,5/);
});

test('a plist written by the macOS app is read back the same way', (t) => {
    // The exact shape SessionPingAgent.plistXML (macos/Sources/ClaudeUsageCore)
    // emits - pinned on the Swift side by SessionPingTests. install.sh's sed
    // parser and the schedule summary must both understand it.
    const home = makeSandbox(t);
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(
        path.join(dir, 'io.github.fschmutz.claude-usage-panel.sessionping.plist'),
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<plist version="1.0">',
            '<dict>',
            '  <key>ProgramArguments</key>',
            '  <array>',
            '    <string>/bin/bash</string>',
            '    <string>/x/session-ping.sh</string>',
            '    <string>--quiet</string>',
            '    <string>--days=2,4</string>',
            '  </array>',
            '  <key>StartCalendarInterval</key>',
            '  <array>',
            '    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>',
            '    <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>',
            '  </array>',
            '</dict>',
            '</plist>',
            '',
        ].join('\n'),
    );
    const r = runInstall(home, ['--dry-run', 'sessionping']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /schedule: at 06:00 11:00 on days 2,4/);
});

test('invalid times and days exit 2', (t) => {
    const home = makeSandbox(t);
    for (const args of [
        ['sessionping', '25:00'],
        ['sessionping', '10:99'],
        ['sessionping', '--days=funday'],
    ]) {
        const r = runInstall(home, ['--dry-run', ...args]);
        assert.equal(r.status, 2, args.join(' '));
        assert.match(r.stderr, /invalid/);
    }
});

test('HH:MM times without the sessionping target exit 2', (t) => {
    const home = makeSandbox(t);
    const r = runInstall(home, ['--dry-run', '05:30']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /only apply to the sessionping target/);
});

test('install.sh --dry-run --uninstall sessionping removes nothing', (t) => {
    const home = makeSandbox(t);
    fs.rmSync(path.join(home, 'bin'), {recursive: true});
    const r = runInstall(home, ['--dry-run', '--uninstall', 'sessionping']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /would: rm -f .*sessionping/);
    assert.deepEqual(fs.readdirSync(home), []);
});

test('day specs normalize to sorted unique 1..7 lists', (t) => {
    const home = makeSandbox(t);
    for (const [spec, want] of [
        ['all', '1,2,3,4,5,6,7'],
        ['mon-fri', '1,2,3,4,5'],
        ['MON,Wed', '1,3'],
        ['mon,mon,1', '1'],
        ['5,1,3', '1,3,5'],
        ['mon,3', '1,3'],
    ]) {
        const r = runInstall(home, ['--dry-run', 'sessionping', `--days=${spec}`]);
        assert.equal(r.status, 0, spec);
        assert.match(r.stdout, new RegExp(`schedule: at 05:30 on days ${want} `), spec);
    }
});

// The cron branch, end to end against the stubbed crontab: real (non-dry)
// install writes the tagged lines, both read-back parsers preserve them on a
// bare reinstall, --status sees them, and uninstall drains them cleanly even
// when they are the only crontab content (the pipefail-guard regression).
test('cron branch: install, read back, status, uninstall', (t) => {
    const home = makeSandbox(t);
    const cronEnv = {extra: {CUP_TEST_SCHEDULER: 'cron'}};
    let r = run(
        'bash',
        [INSTALL, 'sessionping', '06:00', '11:00', '--days=mon,wed,fri'],
        {env: env(home, cronEnv)},
    );
    assert.equal(r.status, 0);
    const cron = fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8');
    assert.match(cron, /^0 6 \* \* \* \S+session-ping\.sh --quiet --days=1,3,5 {2}# claude-usage-panel session-ping$/m);
    assert.match(cron, /^0 11 \* \* \* .*--days=1,3,5/m);

    // Bare reinstall: times and days come back from the crontab lines.
    r = run('bash', [INSTALL, '--dry-run', 'sessionping'], {env: env(home, cronEnv)});
    assert.match(r.stdout, /schedule: at 06:00 11:00 on days 1,3,5/);

    // The worker's --status reads the same lines through the stub.
    r = run('bash', [SCRIPT, '--status'], {env: env(home)});
    assert.match(r.stdout, /schedule: {3}06:00 11:00/);

    // Uninstall with nothing else in the crontab: exit 0, lines gone.
    r = run('bash', [INSTALL, '--uninstall', 'sessionping'], {env: env(home, cronEnv)});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /removed \(no more session pings\)/);
    assert.doesNotMatch(
        fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8'),
        /session-ping/,
    );
});

test('a concurrent run skips and leaves the lock alone', (t) => {
    const home = makeSandbox(t);
    const lock = path.join(home, 'state', 'claude-usage-panel', 'session-ping.lock');
    fs.mkdirSync(lock, {recursive: true});
    const r = run('bash', [SCRIPT, '--force'], {env: env(home)});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /another ping is in progress/);
    assert.equal(fs.existsSync(lock), true); // the skipping run must not clean it up
    assert.equal(calls(home), '');
});

test('a stale lock (>15 min) is reclaimed and the ping proceeds', (t) => {
    const home = makeSandbox(t);
    const lock = path.join(home, 'state', 'claude-usage-panel', 'session-ping.lock');
    fs.mkdirSync(lock, {recursive: true});
    const old = (Date.now() - 20 * 60 * 1000) / 1000;
    fs.utimesSync(lock, old, old);
    const r = run('bash', [SCRIPT, '--force'], {env: env(home)});
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pinged \(model haiku\)/);
});

test('the log is trimmed to 500 lines', (t) => {
    const home = makeSandbox(t);
    const dir = path.join(home, 'state', 'claude-usage-panel');
    fs.mkdirSync(dir, {recursive: true});
    const log = path.join(dir, 'session-ping.log');
    fs.writeFileSync(log, Array.from({length: 600}, (_, i) => `seed ${i}`).join('\n') + '\n');
    const r = run('bash', [SCRIPT, '--force'], {env: env(home)});
    assert.equal(r.status, 0);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, 500);
    assert.match(lines[lines.length - 1], /pinged \(model haiku\)/);
    assert.doesNotMatch(lines[0], /seed 0$/); // oldest seeded lines rotated out
    assert.equal(fs.existsSync(`${log}.tmp`), false);
});

test('sessionping is a known, documented target of install.sh', () => {
    const r = run('bash', [INSTALL, '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /sessionping \[HH:MM \.\.\.\]/);
});
