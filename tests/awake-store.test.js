// The Awake store and the holder, in a throwaway state dir against a FAKE
// machine: a recorded `exec` stands in for pmset / caffeinate /
// systemd-inhibit, so the journal, the lock, the read-back, the floors and
// the release are all exercised without touching this machine's power state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {openAwake} from '../claude-code/awake.js';
import {hold, parseWorkerArgs} from '../claude-code/awake-worker.js';
import {awakeDir} from '../claude-code/paths.js';
import {sandboxHome} from './helpers.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

/**
 * A sandbox plus a fake machine. `answers` maps a command line to what it
 * prints; anything else exits 0 with no output. Every call is recorded.
 */
function world(t, {platform = 'darwin', answers = {}, now = NOW, sessions = 0} = {}) {
    const io = sandboxHome(t, {prefix: 'cup-awake-'});
    const calls = [];
    const state = {now, sleepDisabled: false, lowPower: false};
    const exec = (file, args) => {
        const line = [file, ...args].join(' ');
        calls.push(line);
        const answer = answers[line];
        if (answer instanceof Error) throw answer;
        if (line === '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1') state.sleepDisabled = true;
        if (line === '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0') state.sleepDisabled = false;
        if (line === '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 1') state.lowPower = true;
        if (line === '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0') state.lowPower = false;
        if (answer !== undefined) return answer;
        if (line === '/usr/bin/pmset -g') return `SleepDisabled ${state.sleepDisabled ? 1 : 0}\n`;
        if (line === '/usr/bin/pmset -g batt')
          return "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; present: true\n";
        if (line === '/usr/bin/pmset -g therm') return 'CPU_Speed_Limit = 100\n';
        return '';
    };
    // Live-session count without a registry: the store's own reader walks
    // ~/.claude/sessions, which these tests do not populate.
    const full = {
      ...io, platform, exec, nowMs: () => state.now, hostname: 'box',
      pidAlive: (pid) => pid === process.pid,
      liveSessions: () => sessions, settleMs: 0,
    };
    return {io: full, awake: openAwake(full), calls, state, dir: awakeDir(io)};
}

test('status with nothing held reads clean, and nothing is created', (t) => {
  const {awake, io} = world(t);
  const state = awake.status();
  assert.equal(state.active, false);
  assert.equal(state.recovery, null);
  assert.equal(fs.existsSync(awakeDir(io)), false, 'a read must not create the store');
});

test('status only walks the session registry for a hold that depends on it', (t) => {
  // The status line renders this on every prompt: a /proc sweep for a count
  // nothing reads is not free.
  let scans = 0;
  const {io, awake} = world(t, {platform: 'linux'});
  const counted = openAwake({...io, liveSessions: () => (scans += 1)});
  awake.writeSession({
    ...awake.newSession({seconds: 3600}), owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  counted.status();
  assert.equal(scans, 0, 'a timer-only hold never asks');

  awake.writeSession({
    ...awake.newSession({seconds: null, whileSessions: true}),
    owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  counted.status();
  assert.equal(scans, 1);
});

test('the config comes from config.json, with the floors repaired', (t) => {
  const {awake} = world(t);
  assert.deepEqual(awake.config(),
    {lowPowerFloor: 40, endFloor: 10, maxSeconds: 43200, thermalRules: true});
  awake.writeConfig({lowPowerFloor: 10, endFloor: 30, maxSeconds: 7200});
  // written back normalized: the end floor is the one that protects the machine
  assert.deepEqual(awake.config(),
    {lowPowerFloor: 31, endFloor: 30, maxSeconds: 7200, thermalRules: true});
  assert.equal(fs.statSync(awake.configFile()).mode & 0o777, 0o600);
});

test('every file the store writes is owner-only', (t) => {
  const {awake} = world(t);
  const session = awake.newSession({seconds: 3600});
  awake.writeSession(session);
  awake.writeJournal(awake.newJournal({endsAt: session.endsAt}));
  for (const f of [awake.sessionFile(), awake.journalFile()])
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
});

test('the lock is exclusive, and a dead holder is taken over', (t) => {
  const {awake} = world(t);
  const nested = awake.withLock(() => awake.withLock(() => 'inner'));
  assert.equal(nested.ok, true);
  assert.deepEqual(nested.value, {ok: false, reason: 'busy'}, 'a second taker waits, then gives up');
  assert.equal(fs.existsSync(awake.lockFile()), false, 'released on the way out');

  fs.mkdirSync(path.dirname(awake.lockFile()), {recursive: true});
  fs.writeFileSync(awake.lockFile(), '999999\n');
  assert.deepEqual(awake.withLock(() => 'mine'), {ok: true, value: 'mine'});
});

test('lid mode is read back: a bit that does not stick is a failure, not a hold', (t) => {
  const stuck = world(t, {answers: {'/usr/bin/pmset -g': 'SleepDisabled 0\n'}});
  const bad = stuck.awake.setLidDisabled(true, {settleMs: 0});
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'reverted');
  assert.match(bad.message, /still sleep this Mac/);

  const mute = world(t, {answers: {'/usr/bin/pmset -g': 'hibernatemode 3\n'}});
  assert.equal(mute.awake.setLidDisabled(true, {settleMs: 0}).reason, 'unreadable');

  const good = world(t);
  assert.deepEqual(good.awake.setLidDisabled(true, {settleMs: 0}), {ok: true});
  assert.equal(good.state.sleepDisabled, true);
});

test('a sudo that is not permitted fails fast with its own last line', (t) => {
  const e = new Error('spawn failed');
  e.stderr = 'sudo: a password is required\n';
  const {awake} = world(t, {
    answers: {'/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1': e},
  });
  const r = awake.setLidDisabled(true, {settleMs: 0});
  assert.equal(r.ok, false);
  assert.match(r.message, /a password is required/);
});

test('recover undoes the journal in order and clears each flag only once it took', (t) => {
  const {awake, calls, state} = world(t);
  state.sleepDisabled = true;
  state.lowPower = true;
  awake.writeJournal(awake.newJournal({
    endsAt: NOW - 10 * 60_000, sleepDisabled: true, lowPower: true,
  }));
  awake.writeSession(awake.newSession({seconds: 60}));
  calls.length = 0;

  const result = awake.recover({force: true});
  assert.deepEqual(result.undone, ['sleepDisabled', 'lowPower']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(calls.filter((c) => c.includes('sudo')), [
    '/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0',
    '/usr/bin/sudo -n /usr/bin/pmset -b lowpowermode 0',
  ]);
  assert.equal(state.sleepDisabled, false);
  assert.equal(state.lowPower, false);
  assert.equal(fs.existsSync(awake.sessionFile()), false, 'the session file is history');
});

test('an undo that fails keeps the claim so the next run retries it', (t) => {
  const e = new Error('nope');
  e.stderr = 'sudo: a password is required';
  const {awake} = world(t, {
    answers: {'/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0': e},
  });
  awake.writeJournal(awake.newJournal({endsAt: NOW - 10 * 60_000, sleepDisabled: true}));
  const result = awake.recover({force: true});
  assert.deepEqual(result.failed, ['sleepDisabled']);
  assert.equal(awake.readJournal().sleepDisabled, true, 'still owed');
});

test('recover refuses to cut a running session short without --force', (t) => {
  const {awake, calls} = world(t);
  awake.writeJournal(awake.newJournal({endsAt: NOW + 3_600_000, sleepDisabled: true}));
  calls.length = 0;
  const result = awake.recover();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'session-still-running');
  assert.deepEqual(calls.filter((c) => c.includes('sudo')), [], 'nothing privileged ran');
});

test('a dirty journal past its deadline is what the dropdown warns about', (t) => {
  const {awake} = world(t);
  awake.writeJournal(awake.newJournal({endsAt: NOW - 12 * 60_000, sleepDisabled: true}));
  const state = awake.status();
  assert.deepEqual(state.recovery.codes, ['sleepDisabled']);
  assert.equal(state.recovery.endedAgo, '12m');
});

test('the battery and thermal readings come from the platform the io names', (t) => {
  const mac = world(t, {
    answers: {
      '/usr/bin/pmset -g batt':
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t35%; discharging; present: true\n",
      '/usr/bin/pmset -g therm': 'CPU_Speed_Limit = 60\n',
    },
  });
  assert.deepEqual(mac.awake.readBattery(), {percent: 35, charging: false, hasBattery: true});
  assert.equal(mac.awake.readThermal(), 'serious');

  const linux = world(t, {platform: 'linux'});
  const supply = path.join(linux.io.home, 'power');
  fs.mkdirSync(path.join(supply, 'BAT0'), {recursive: true});
  fs.writeFileSync(path.join(supply, 'BAT0', 'capacity'), '8\n');
  fs.writeFileSync(path.join(supply, 'BAT0', 'status'), 'Discharging\n');
  const thermal = path.join(linux.io.home, 'thermal');
  fs.mkdirSync(path.join(thermal, 'thermal_zone0'), {recursive: true});
  fs.writeFileSync(path.join(thermal, 'thermal_zone0', 'temp'), '96000\n');
  const lin = openAwake({...linux.io, powerSupplyDir: supply, thermalDir: thermal});
  assert.deepEqual(lin.readBattery(), {percent: 8, charging: false, hasBattery: true});
  assert.equal(lin.readThermal(), 'critical');
  // no /sys at all is a desktop, not a flat battery
  assert.deepEqual(openAwake({...linux.io, powerSupplyDir: path.join(linux.io.home, 'nope')})
    .readBattery(), {percent: null, charging: true, hasBattery: false});
});

// ── the holder ──────────────────────────────────────────────────────────────

test('parseWorkerArgs reads the three flags, and nothing else', () => {
  assert.deepEqual(parseWorkerArgs([]), {seconds: null, whileSessions: false, lid: false});
  assert.deepEqual(parseWorkerArgs(['--seconds', '7200', '--lid']),
    {seconds: 7200, whileSessions: false, lid: true});
  assert.deepEqual(parseWorkerArgs(['--seconds', 'none', '--while-sessions']),
    {seconds: null, whileSessions: true, lid: false});
  assert.deepEqual(parseWorkerArgs(['--seconds', 'junk']),
    {seconds: null, whileSessions: false, lid: false});
});

/** A `spawn` that records and hands back a child nothing ever kills early. */
function fakeSpawn(record) {
  return (file, args) => {
    record.push([file, ...args].join(' '));
    return {on: () => {}, kill: () => record.push(`kill ${file}`), exitCode: null};
  };
}

test('the holder takes the hold, writes the journal first, and releases on the timer', async (t) => {
  const {io, awake, state} = world(t, {platform: 'linux'});
  const spawned = [];
  const seen = [];
  const code = await hold({seconds: 3600, whileSessions: false, lid: false}, {
    ...io,
    spawn: fakeSpawn(spawned),
    sleep: async () => {
      // one cycle, then the deadline has passed
      state.now += 3_600_000;
    },
    pollSeconds: 0,
    onCycle: (c) => seen.push(c.stopping),
  });
  assert.equal(code, 0);
  assert.match(spawned[0], /^systemd-inhibit --what=idle:sleep --mode=block/);
  assert.match(spawned[0], /sleep 3600$/);
  assert.deepEqual(seen, [null, 'timer']);
  assert.ok(spawned.includes('kill systemd-inhibit'), 'the child is what held it, so it is killed');
  assert.equal(fs.existsSync(awake.sessionFile()), false);
  assert.equal(awake.readJournal().sleepDisabled, false, 'nothing persistent was ever owned');
});

test('a second holder refuses rather than double-holding', async (t) => {
  const {io, awake} = world(t, {platform: 'linux'});
  awake.writeSession({
    ...awake.newSession({seconds: 3600}),
    owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  const code = await hold({seconds: 3600}, {...io, spawn: fakeSpawn([]), sleep: async () => {}});
  assert.equal(code, 3);
});

test('a --while-sessions hold ends when the last session goes away', async (t) => {
  const {io} = world(t, {platform: 'linux'});
  let sessions = 2;
  const seen = [];
  const code = await hold({seconds: null, whileSessions: true}, {
    ...io,
    spawn: fakeSpawn([]),
    sleep: async () => { sessions = 0; },
    pollSeconds: 0,
    liveSessions: () => sessions,
    onCycle: (c) => seen.push([c.sessions, c.stopping]),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [[2, null], [0, 'sessions']]);
});

test('the battery floor ends the hold, and the machine is given back', async (t) => {
  const {io, awake, state, calls} = world(t, {
    answers: {
      '/usr/bin/pmset -g batt':
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t4%; discharging; present: true\n",
    },
  });
  const spawned = [];
  const seen = [];
  const code = await hold({seconds: 3600, lid: true}, {
    ...io,
    spawn: fakeSpawn(spawned),
    sleep: async () => {},
    pollSeconds: 0,
    onCycle: (c) => seen.push(c.stopping),
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, ['battery']);
  assert.equal(state.sleepDisabled, false, 'lid mode was given back');
  assert.ok(calls.includes('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0'));
  assert.equal(awake.readJournal().sleepDisabled, false);
  assert.ok(spawned.includes('kill /usr/bin/caffeinate'));
});

test('lid mode that cannot be proven on leaves nothing claimed', async (t) => {
  const {io, awake, state} = world(t, {answers: {'/usr/bin/pmset -g': 'SleepDisabled 0\n'}});
  const code = await hold({seconds: 3600, lid: true}, {
    ...io,
    spawn: fakeSpawn([]),
    sleep: async () => { state.now += 3_600_000; },
    pollSeconds: 0,
  });
  assert.equal(code, 0);
  assert.equal(awake.readJournal().sleepDisabled, false, 'the claim was dropped again');
});
