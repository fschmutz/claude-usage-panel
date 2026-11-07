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

import {AWAKE_BACKSTOP_GRACE_MS} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {
  AWAKE_SUDO_COMMANDS, awakeSudoArgv, awakeSudoersBody,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake-power.js';
import {awakeDir} from '../claude-code/paths.js';
import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKSTOP = path.join(ROOT, 'scripts', 'awake-backstop.sh');
const INSTALL = path.join(ROOT, 'install.sh');

/** The undo the backstop owes for a journal key, as the fake sudo records
 *  it: AWAKE_SUDO_COMMANDS's own argv, so the shell's copy cannot drift. */
const undo = (key) => awakeSudoArgv(key, false).join(' ')
  .replace('/usr/bin/sudo', 'sudo').replace('/usr/bin/pmset', 'pmset');

/**
 * A HOME plus a directory holding a fake `sudo` and `pmset`. The script
 * hardcodes the absolute paths of both (a PATH lookup for a privileged
 * command is a bug), so the suite aims it at the fakes through its one named
 * test hook, CUP_TEST_PMSET_DIR. The store is where claude-code/paths.js
 * puts it, handed to the script the way the installed schedule hands it.
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
  const dir = awakeDir({
    platform: darwin ? 'darwin' : 'linux', homedir: home, env: {XDG_STATE_HOME: path.join(home, 'state')},
  });
  fs.mkdirSync(dir, {recursive: true});
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
    awakeDir: dir,
    journal: path.join(dir, 'journal.json'),
    session: path.join(dir, 'session.json'),
    lock: path.join(dir, '.hold.lock'),
    log: path.join(path.dirname(dir), 'awake-backstop.log'),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
    failSudo: () => fs.writeFileSync(path.join(home, 'sudo-fails'), ''),
  };
}

/** Run the backstop with its privileged commands pointed at the fakes. */
function backstop(w, args = []) {
  return run('bash', [BACKSTOP, '--awake-dir', w.awakeDir, ...args], {env: w.env});
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
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')),
    [undo('sleepDisabled'), undo('lowPower')]);
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
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')), [undo('sleepDisabled')]);
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
  assert.deepEqual(w.calls().map((c) => c.replace(/\/\S*pmset/, 'pmset')), [undo('sleepDisabled')]);
  assert.equal(fs.existsSync(w.lock), false, 'released');
  assert.deepEqual(fs.readdirSync(w.awakeDir).filter((f) => f.startsWith('.hold.lock')), [], 'no lock and no takeover guard left');
});

test('the grace window is the JS contract\'s: just inside it nothing runs, just past it the undo does', (t) => {
  const w = world(t);
  const at = (endedAgoMs) => journalText({at: 1, endsAt: Date.now() - endedAgoMs, sleepDisabled: true});
  fs.writeFileSync(w.journal, at(AWAKE_BACKSTOP_GRACE_MS - 30_000));
  assert.equal(backstop(w).status, 0);
  assert.deepEqual(w.calls(), [], 'still inside the grace window');
  fs.writeFileSync(w.journal, at(AWAKE_BACKSTOP_GRACE_MS + 30_000));
  assert.equal(backstop(w).status, 0);
  assert.equal(w.calls().length, 1, 'just past it');
});

test('without the store it was installed with, the backstop refuses rather than guess', (t) => {
  const w = world(t);
  for (const args of [[], ['--awake-dir', 'relative/awake'], ['--awake-dir']]) {
    const r = run('bash', [BACKSTOP, ...args], {env: w.env});
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /--awake-dir/);
  }
  assert.deepEqual(w.calls(), []);
});

test('the backstop releases only its own lock, never one taken over from it', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  // While the run holds the lock, another holder takes it over (the run
  // overran the stale window): its lock must survive the run's exit.
  const other = `${process.pid}\nsomeone-else\n`;
  const sudo = path.join(w.env.CUP_TEST_PMSET_DIR, 'sudo');
  fs.writeFileSync(sudo, `#!/bin/sh\nprintf '%s' '${other}' >"${w.lock}.new" && mv "${w.lock}.new" "${w.lock}"\nexit 0\n`);
  assert.equal(backstop(w).status, 0);
  assert.equal(fs.readFileSync(w.lock, 'utf8'), other, 'the newer holder keeps its lock');
});

test('the backstop lock carries its pid on the first line, then an owner token', (t) => {
  const w = world(t);
  fs.writeFileSync(w.journal, journalText({
    at: Date.now() - 3_600_000, endsAt: Date.now() - 600_000, sleepDisabled: true,
  }));
  const sudo = path.join(w.env.CUP_TEST_PMSET_DIR, 'sudo');
  const seen = path.join(w.home, 'lock-seen');
  fs.writeFileSync(sudo, `#!/bin/sh\ncat "${w.lock}" >"${seen}"\nexit 0\n`);
  assert.equal(backstop(w).status, 0);
  const [pid, token, rest] = fs.readFileSync(seen, 'utf8').split('\n');
  assert.match(pid, /^\d+$/);
  assert.match(token, /^\d+-\d+-\d+$/);
  assert.equal(rest, '');
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
  assert.match(r.stdout, /would: add crontab line: \* \* \* \* \* .*awake-backstop\.sh --awake-dir \S+ --quiet/);
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
  // the rule is checked, not assumed - and for exactly the commands it grants
  assert.deepEqual(sudo.trim().split('\n').map((l) => l.replace(/^sudo -n -l /, '')),
    AWAKE_SUDO_COMMANDS.map((c) => c.join(' ')));
});

/** A Darwin-looking sandbox where sudo runs the command as is and visudo
 *  accepts, writing the rule into a sandbox sudoers.d. */
function sudoersWorld(t, {tamper = false} = {}) {
  const home = stubbedHome(t, {prefix: 'cup-awakelid-w-'});
  const sudoersDir = path.join(home, 'sudoers.d');
  fs.mkdirSync(sudoersDir);
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
    CUP_TEST_SUDOERS: path.join(sudoersDir, 'claude-usage-panel-awake'),
  };
  const bin = (name, body) => {
    fs.writeFileSync(path.join(home, 'bin', name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(home, 'bin', name), 0o755);
  };
  bin('uname', 'case "$1" in -s|"") echo Darwin ;; *) /bin/uname "$@" ;; esac');
  bin('defaults', 'exit 0');
  // visudo -cf F: accept, but a tampering visudo stands for anything that
  // rewrites the temp between render and install
  bin('visudo', tamper ? 'chmod u+w "$2"; echo "ALL ALL=(ALL) NOPASSWD: ALL" >"$2"; exit 0' : 'exit 0');
  bin('sudo', '[ "$1" = -n ] && [ "$2" = -l ] && exit 0\nexec "$@"');
  return {home, sudoersDir, env, rule: env.CUP_TEST_SUDOERS};
}

test('install.sh awakelid writes the rendered rule 0440 and leaves no temp behind', async (t) => {
  const w = sudoersWorld(t);
  const r = run('bash', [INSTALL, 'awakelid'], {env: w.env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const {userInfo} = await import('node:os');
  assert.equal(fs.readFileSync(w.rule, 'utf8'), awakeSudoersBody(userInfo().username));
  assert.equal(fs.statSync(w.rule).mode & 0o777, 0o440);
  assert.deepEqual(fs.readdirSync(w.sudoersDir), ['claude-usage-panel-awake'], 'the temp is gone');
});

test('install.sh awakelid never installs a rule that differs from what it rendered', (t) => {
  const w = sudoersWorld(t, {tamper: true});
  const r = run('bash', [INSTALL, 'awakelid'], {env: w.env});
  assert.match(r.stdout + r.stderr, /failed validation - nothing was written/);
  assert.deepEqual(fs.readdirSync(w.sudoersDir), [], 'neither the rule nor the temp is left');
});

test('the installed schedule repairs the store claude-code/paths.js names', (t) => {
  // Not a dry run: install, read the line cron would run, and run it against
  // a journal written where every Node client writes it. Linux, so the run
  // ends on "not macOS" - which it can only say after reading THAT journal.
  const home = stubbedHome(t, {prefix: 'cup-awake-sched-'});
  const env = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
  };
  fs.writeFileSync(path.join(home, 'bin', 'uname'),
    '#!/bin/sh\ncase "$1" in -s|"") echo Linux ;; *) /bin/uname "$@" ;; esac\n');
  fs.chmodSync(path.join(home, 'bin', 'uname'), 0o755);
  const r = run('bash', [INSTALL, 'awake'], {env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8')
    .split('\n').find((l) => l.includes('awake-backstop.sh'));
  const command = line.split(' ').slice(5).join(' ').replace(/ {2}# claude-usage-panel.*$/, '')
    .replace(/\\%/g, '%');

  const dir = awakeDir({platform: 'linux', homedir: home, env});
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'journal.json'),
    journalText({at: 1, endsAt: Date.now() - 3_600_000, sleepDisabled: true}));
  const ran = run('bash', ['-c', command], {env});
  assert.equal(ran.status, 1, ran.stdout + ran.stderr);
  assert.match(fs.readFileSync(path.join(path.dirname(dir), 'awake-backstop.log'), 'utf8'),
    /journal claims sleepDisabled, but this is not macOS/);
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
