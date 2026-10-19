// scripts/awake-backstop.sh - the one thing that must still release a Mac
// when the panel is gone - driven against a journal on disk with a FAKE
// sudo/pmset on PATH, plus the two install targets in --dry-run.
//
// The script is the only recovery path that needs neither node nor Swift, so
// it is tested the way it runs: as a shell script, from a journal file, with
// nothing of this project loaded.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSTOP = path.join(ROOT, 'scripts', 'awake-backstop.sh');
const INSTALL = path.join(ROOT, 'install.sh');

/**
 * A HOME plus a directory holding a fake `sudo` and `pmset`. The script
 * hardcodes the absolute paths of both (a PATH lookup for a privileged
 * command is a bug), so the suite aims it at the fakes through its one named
 * test hook, CUP_TEST_PMSET_DIR.
 */
function world(t, {darwin = true} = {}) {
  const home = stubbedHome(t, {prefix: 'cup-backstop-'});
  const bin = path.join(home, 'bin');
  const calls = path.join(home, 'pmset-calls.log');
  const fakes = path.join(home, 'fakes');
  fs.mkdirSync(fakes, {recursive: true});
  fs.writeFileSync(path.join(fakes, 'sudo'),
    `#!/bin/sh\necho "sudo $*" >>"${calls}"\nif [ -f "${home}/sudo-fails" ]; then exit 1; fi\nexit 0\n`);
  fs.chmodSync(path.join(fakes, 'sudo'), 0o755);
  fs.writeFileSync(path.join(fakes, 'pmset'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(fakes, 'pmset'), 0o755);
  const stateDir = darwin
    ? path.join(home, 'Library', 'Application Support', 'claude-usage-panel')
    : path.join(home, 'state', 'claude-usage-panel');
  const awakeDir = path.join(stateDir, 'awake');
  fs.mkdirSync(awakeDir, {recursive: true});
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    PATH: `${bin}:/usr/bin:/bin`,
    CUP_TEST_PMSET_DIR: fakes,
  };
  // uname is what the script branches on; stub it for the darwin case.
  fs.writeFileSync(path.join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s|"") echo ${darwin ? 'Darwin' : 'Linux'} ;; *) /bin/uname "$@" ;; esac\n`);
  fs.chmodSync(path.join(bin, 'uname'), 0o755);
  return {
    home,
    env,
    awakeDir,
    journal: path.join(awakeDir, 'journal.json'),
    session: path.join(awakeDir, 'session.json'),
    lock: path.join(awakeDir, '.hold.lock'),
    log: path.join(stateDir, 'awake-backstop.log'),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
    failSudo: () => fs.writeFileSync(path.join(home, 'sudo-fails'), ''),
  };
}

/** Run the backstop with its privileged commands pointed at the fakes. */
function backstop(w, args = []) {
  return run('bash', [BACKSTOP, ...args], {env: w.env});
}

const journalText = (o) => `${JSON.stringify({version: 1, ...o}, null, 2)}\n`;

test('a clean journal costs nothing: no lock, no sudo, no log', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({at: 1, endsAt: 2}));
  const r = backstop(w);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(w.calls(), []);
  assert.equal(fs.existsSync(w.log), false);
  assert.equal(fs.existsSync(w.lock), false, 'the lock is always released');
});

test('no journal at all is a no-op', (t) => {
  const w = world(t);
  assert.equal(backstop(w).status, 0);
  assert.deepEqual(w.calls(), []);
});

test('a dirty journal whose session is still running is left alone', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now(), endsAt: Date.now() + 3_600_000, sleepDisabled: true,
  }));
  assert.equal(backstop(w).status, 0);
  assert.deepEqual(w.calls(), [], 'cutting a live session short is not the backstop’s job');
  assert.match(fs.readFileSync(w.journal, 'utf8'), /"sleepDisabled": true/);
});

test('past the grace window it gives sleep back and clears the flag', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true, lowPower: true,
  }));
  fs.writeFileSync(w.session, '{"version":1}\n');
  const r = backstop(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')), [
    'sudo -n pmset -a disablesleep 0',
    'sudo -n pmset -b lowpowermode 0',
  ]);
  const journal = fs.readFileSync(w.journal, 'utf8');
  assert.match(journal, /"sleepDisabled": false/);
  assert.match(journal, /"lowPower": false/);
  assert.equal(fs.existsSync(w.session), false, 'the session file is history');
  assert.match(fs.readFileSync(w.log, 'utf8'), /recovered sleepDisabled lowPower/);
});

test('--force overrides the deadline, so `claudectl awake off` can use it', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now(), endsAt: Date.now() + 3_600_000, sleepDisabled: true,
  }));
  assert.equal(backstop(w, ['--force']).status, 0);
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')),
    ['sudo -n pmset -a disablesleep 0']);
});

test('a pmset that fails keeps the claim and exits non-zero so the next run retries', (t) => {
  const w = world(t);
  w.failSudo();
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  const r = backstop(w);
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(w.journal, 'utf8'), /"sleepDisabled": true/, 'still owed');
  assert.match(r.stdout, /could not undo sleepDisabled/);
  assert.match(r.stdout, /install\.sh awakelid/);
});

test('a lock held by a live process stops the run dead (exit 75), touching nothing', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  fs.writeFileSync(w.lock, `${process.pid}\n`);
  const r = backstop(w);
  assert.equal(r.status, 75);
  assert.deepEqual(w.calls(), []);
  assert.equal(fs.readFileSync(w.lock, 'utf8').trim(), String(process.pid), 'not stolen');
});

test('a lock whose holder is gone is taken over', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  fs.writeFileSync(w.lock, '999999\n');
  assert.equal(backstop(w).status, 0);
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')),
    ['sudo -n pmset -a disablesleep 0']);
});

test('on Linux a journal that claims a pmset setting is reported, never run', (t) => {
  const w = world(t, {darwin: false});
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  const r = backstop(w);
  assert.equal(r.status, 1);
  assert.deepEqual(w.calls(), []);
  assert.match(r.stdout, /not macOS/);
});

test('--status reads the store without changing anything', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({at: 1, endsAt: 1770000000000, sleepDisabled: true}));
  const r = backstop(w, ['--status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /owed: +sleepDisabled/);
  assert.deepEqual(w.calls(), []);
});

// ── install targets ─────────────────────────────────────────────────────────

test('install.sh --dry-run awake schedules the backstop and writes nothing', (t) => {
  const home = stubbedHome(t, {prefix: 'cup-awake-inst-'});
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
  };
  const r = run('bash', [INSTALL, '--dry-run', 'awake'], {env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /would: add crontab line: \* \* \* \* \* .*awake-backstop\.sh --quiet/);
  assert.match(r.stdout, /would: chmod \+x .*awake-backstop\.sh/);
  assert.equal(fs.existsSync(path.join(home, 'crontab.txt')), false, 'dry-run writes nothing');
});

test('install.sh --dry-run awakelid never touches sudoers, and says what it would', (t) => {
  const home = stubbedHome(t, {prefix: 'cup-awakelid-'});
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
  };
  // No USER, as under a scheduler or `env -i`: the target asks the system who
  // it runs as (set -u killed it on an unset USER before it said anything).
  delete env.USER;
  // uname says Darwin, so the privileged branch is the one exercised.
  fs.writeFileSync(path.join(home, 'bin', 'uname'),
    '#!/bin/sh\ncase "$1" in -s|"") echo Darwin ;; *) /bin/uname "$@" ;; esac\n');
  fs.chmodSync(path.join(home, 'bin', 'uname'), 0o755);
  fs.writeFileSync(path.join(home, 'bin', 'sudo'), '#!/bin/sh\necho "sudo ran" >&2\nexit 1\n');
  fs.chmodSync(path.join(home, 'bin', 'sudo'), 0o755);

  const r = run('bash', [INSTALL, '--dry-run', 'awakelid'], {env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ventilated surface/);
  assert.match(r.stdout, /would: write \/etc\/sudoers\.d\/claude-usage-panel-awake/);
  assert.doesNotMatch(r.stderr, /sudo ran/, 'a dry run must never invoke sudo');
});

test('install.sh update awakelid never asks for a password when the rule is in force', (t) => {
  // The daily auto-update reinstalls every installed target from a scheduler,
  // with no terminal: a sudo that has to prompt fails there, the target fails,
  // and the update is retried forever without ever being recorded.
  const home = stubbedHome(t, {prefix: 'cup-awakelid-up-'});
  const calls = path.join(home, 'sudo-calls.log');
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
  };
  fs.writeFileSync(path.join(home, 'bin', 'uname'),
    '#!/bin/sh\ncase "$1" in -s|"") echo Darwin ;; *) /bin/uname "$@" ;; esac\n');
  fs.chmodSync(path.join(home, 'bin', 'uname'), 0o755);
  fs.writeFileSync(path.join(home, 'bin', 'defaults'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(home, 'bin', 'defaults'), 0o755);
  // `sudo -n -l` grants all four commands (the rule is in force); anything
  // else would need a password, which a scheduler cannot type.
  fs.writeFileSync(path.join(home, 'bin', 'sudo'),
    `#!/bin/sh\necho "sudo $*" >>"${calls}"\n[ "$1" = -n ] && [ "$2" = -l ] && exit 0\nexit 1\n`);
  fs.chmodSync(path.join(home, 'bin', 'sudo'), 0o755);

  const r = run('bash', [INSTALL, 'update', 'awakelid'], {env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const sudo = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  assert.doesNotMatch(sudo, /^sudo (?!-n -l )/m, `only non-interactive checks may run: ${sudo}`);
  assert.match(sudo, /^sudo -n -l \/usr\/bin\/pmset/m, 'the rule is checked, not assumed');
});

test('the backstop grace window and lock staleness match the JS contract', async () => {
  const {AWAKE_BACKSTOP_GRACE_MS} =
    await import('../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js');
  const text = fs.readFileSync(BACKSTOP, 'utf8');
  const grace = Number(/^GRACE_SECONDS=(\d+)$/m.exec(text)[1]);
  assert.equal(grace * 1000, AWAKE_BACKSTOP_GRACE_MS);
  // The lock path and the state dir are a second copy of claude-code/paths.js;
  // a rename there has to land here too.
  assert.match(text, /AWAKE_DIR="\$STATE_DIR\/awake"/);
  assert.match(text, /HOLD_LOCK="\$AWAKE_DIR\/\.hold\.lock"/);
  assert.match(text, /Library\/Application Support\/claude-usage-panel/);
});

test('every runner install.sh makes executable is committed executable', () => {
  // install.sh chmods each scheduled runner in the checkout itself. One
  // committed 0644 turns that chmod into a local mode change, `git status
  // --porcelain` reports the checkout dirty, and auto-update then refuses to
  // touch it ever again - the awake backstop shipped exactly so.
  const dir = path.join(ROOT, 'scripts', 'install');
  const runners = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sh'))
    .flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8')
      .matchAll(/runner="\$ROOT\/([^"]+)"/g)].map((m) => m[1]));
  assert.ok(runners.includes('scripts/awake-backstop.sh'), `runners found: ${runners}`);
  for (const rel of runners) {
    const r = run('git', ['-C', ROOT, 'ls-files', '-s', '--', rel]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^100755 /, `${rel} is committed as ${r.stdout.split(' ')[0] || 'untracked'}`);
  }
});
