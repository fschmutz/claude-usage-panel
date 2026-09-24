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
