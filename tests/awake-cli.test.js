// `claudectl awake` over a fake machine: the duration flag, what each command
// prints, and the refusals that matter (a hold someone else owns, a session
// that left a setting behind). The store itself is tests/awake-store.test.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {openAwake} from '../claude-code/awake.js';
import {durationFlag, main, statusLines} from '../claude-code/awake-cli.js';
import {main as claudectl} from '../claude-code/claudectl.js';
import {sandboxHome} from './helpers.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function world(t, {platform = 'linux', sessions = 0} = {}) {
  const io = sandboxHome(t, {prefix: 'cup-awakecli-'});
  const out = [];
  const spawned = [];
  const full = {
    ...io,
    platform,
    nowMs: () => NOW,
    hostname: 'box',
    liveSessions: () => sessions,
    settleMs: 0,
    pidAlive: (pid) => pid === process.pid,
    exec: () => '',
    stdout: (s) => out.push(s),
    // No real holder: the CLI's `start` waits for session.json, so the stub
    // writes it the way the holder would.
    spawn: (file, args) => {
      spawned.push([file, ...args].join(' '));
      return {unref: () => {}};
    },
  };
  return {io: full, out, spawned, awake: openAwake(full), text: () => out.join('')};
}

test('durationFlag takes both forms, and refuses what it cannot read', () => {
  assert.equal(durationFlag(['on', '--for', '2h']), 7200);
  assert.equal(durationFlag(['on', '--for=90m']), 5400);
  assert.equal(durationFlag(['on']), null);
  assert.throws(() => durationFlag(['on', '--for', 'soon']), /want 2h, 90m/);
  assert.throws(() => durationFlag(['on', '--for']), /want 2h, 90m/);
});

test('status reads "not awake" on a machine that has never held anything', async (t) => {
  const {io, text} = world(t);
  assert.equal(await main(['status'], io), 0);
  assert.match(text(), /^Not awake/);
});

test('status --json carries the badge the panels draw', async (t) => {
  const {io, awake, text} = world(t, {sessions: 2});
  awake.writeSession({
    ...awake.newSession({seconds: 3600}), owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  assert.equal(await main(['status', '--json'], io), 0);
  const state = JSON.parse(text());
  assert.equal(state.active, true);
  assert.deepEqual(state.holds, ['timer']);
  assert.equal(state.badge, '1:00:00');
});

test('statusLines spell out the holds, the lid warning and an owed recovery', () => {
  const held = statusLines({
    active: true, holds: ['timer', 'sessions'], countdown: '0:30:00', sessions: 3,
    endsAt: NOW + 1_800_000, remainingMs: 1_800_000, lid: true, owner: {pid: 42},
  });
  assert.match(held[0], /Awake - timer 0:30:00 \+ 3 sessions/);
  assert.match(held[1], /30m left/);
  assert.ok(held.some((l) => /lid mode on \(experimental\)/.test(l)));
  assert.ok(held.some((l) => /held by pid 42/.test(l)));

  const owed = statusLines({
    active: false, holds: [], endReason: 'timer',
    recovery: {codes: ['sleepDisabled'], endedAgo: '12m'},
  });
  assert.match(owed[0], /Not awake \(last session ended: timer\)/);
  assert.match(owed[1], /RECOVERY OWED: sleepDisabled/);
});

test('`on` starts the detached holder and reports what it holds', async (t) => {
  const {io, spawned, awake, text} = world(t);
  // the holder, faked: it is the one that writes session.json under the lock
  io.spawn = (file, args) => {
    spawned.push([file, ...args].join(' '));
    awake.writeSession({
      ...awake.newSession({seconds: 7200}),
      owner: {pid: process.pid, host: 'box', kind: 'cli'},
    });
    return {unref: () => {}};
  };
  assert.equal(await main(['on', '--for', '2h'], io), 0);
  assert.match(spawned[0], /awake-worker\.js --seconds 7200$/);
  assert.match(text(), /Awake - timer 2:00:00/);
});

test('`on --while-sessions` asks the holder for no timer of its own', async (t) => {
  const {io, spawned, awake} = world(t);
  io.spawn = (file, args) => {
    spawned.push([file, ...args].join(' '));
    awake.writeSession({
      ...awake.newSession({seconds: null, whileSessions: true}),
      owner: {pid: process.pid, host: 'box', kind: 'cli'},
    });
    return {unref: () => {}};
  };
  assert.equal(await main(['on', '--while-sessions'], io), 0);
  assert.match(spawned[0], /--seconds none --while-sessions$/);
});

test('`on` refuses while someone else holds it, and says how to end it', async (t) => {
  const {io, awake} = world(t);
  awake.writeSession({
    ...awake.newSession({seconds: 3600}), owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  await assert.rejects(() => main(['on'], io), /already awake, held by pid/);
});

test('`on` refuses while a past session still owes the machine something', async (t) => {
  const {io, awake} = world(t, {platform: 'darwin'});
  awake.writeJournal(awake.newJournal({endsAt: NOW - 600_000, sleepDisabled: true}));
  await assert.rejects(() => main(['on'], io), /awake recover --force/);
});

test('`on` that never produces a holder is an error, not a silent success', async (t) => {
  const {io} = world(t);
  await assert.rejects(() => main(['on', '--for', '30m'], io), /the holder did not start/);
});

test('`off` with nothing held says so and leaves no files behind', async (t) => {
  const {io, text, awake} = world(t);
  assert.equal(await main(['off'], io), 0);
  assert.equal(text().trim(), 'nothing was holding it');
  assert.equal(fs.existsSync(awake.sessionFile()), false);
});

test('`extend` pushes the deadline out, and refuses with nothing to extend', async (t) => {
  const {io, awake, text} = world(t);
  await assert.rejects(() => main(['extend', '--for', '30m'], io), /nothing to extend/);
  awake.writeSession({
    ...awake.newSession({seconds: 1800}), owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  assert.equal(await main(['extend', '--for', '30m'], io), 0);
  assert.equal(awake.readSession().endsAt, NOW + 3_600_000);
  assert.match(text(), /Awake - timer 1:00:00/);
  await assert.rejects(() => main(['extend'], io), /needs --for/);
});

test('`recover` is the one path that gives a setting back by hand', async (t) => {
  const calls = [];
  const {io, awake, text} = world(t, {platform: 'darwin'});
  io.exec = (file, args) => {
    calls.push([file, ...args].join(' '));
    return 'SleepDisabled 0\n';
  };
  awake.writeJournal(awake.newJournal({endsAt: NOW - 600_000, sleepDisabled: true}));
  assert.equal(await main(['recover', '--force'], io), 0);
  assert.match(text(), /gave back sleepDisabled/);
  assert.ok(calls.includes('/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0'));
  // nothing owed the second time
  assert.equal(await main(['recover'], io), 0);
  assert.match(text(), /nothing owed/);
});

test('an unknown command and --help both answer without touching anything', async (t) => {
  const {io, text} = world(t);
  await assert.rejects(() => main(['sleep'], io), /unknown command sleep/);
  assert.equal(await main(['--help'], io), 0);
  assert.match(text(), /claudectl awake - keep this machine awake/);
});

test('the MCP tool reads the same state, and refuses what it must not do', async (t) => {
  const {io, awake} = world(t);
  const {callAwakeTool} = await import('../mcp/awake.js');
  const idle = callAwakeTool({}, io);
  assert.equal(idle.structuredContent.active, false);
  assert.match(idle.content[0].text, /\*\*Not awake\.\*\*/);

  awake.writeSession({
    ...awake.newSession({seconds: 3600}), owner: {pid: process.pid, host: 'box', kind: 'cli'},
  });
  const held = callAwakeTool({action: 'status'}, io);
  assert.equal(held.structuredContent.badge, '1:00:00');
  assert.match(held.content[0].text, /\*\*Awake\*\* - held by a timer \(1:00:00 left\)/);
  assert.throws(() => callAwakeTool({action: 'on'}, io), /already awake/);
  assert.throws(() => callAwakeTool({action: 'sleep'}, io), /unknown action/);
  assert.throws(() => callAwakeTool({action: 'on', duration: 'soon'}, io), /want "2h"/);
});

test('the MCP tool surfaces an owed recovery rather than starting over it', async (t) => {
  const {io, awake} = world(t, {platform: 'darwin'});
  const {callAwakeTool} = await import('../mcp/awake.js');
  awake.writeJournal(awake.newJournal({endsAt: NOW - 720_000, sleepDisabled: true}));
  const state = callAwakeTool({}, io);
  assert.deepEqual(state.structuredContent.recoveryOwed, ['sleepDisabled']);
  assert.match(state.content[0].text, /sleepDisabled was not given back/);
  assert.throws(() => callAwakeTool({action: 'on'}, io), /awake recover --force/);
});

test('claudectl dispatches the group and documents each command', async (t) => {
  const {io, text} = world(t);
  assert.equal(await claudectl(['awake', 'status'], io), 0);
  assert.match(text(), /Not awake/);
  const help = [];
  await claudectl(['--help'], {...io, stdout: (s) => help.push(s)});
  assert.match(help.join(''), /claudectl awake \.\.\./);
  const one = [];
  await claudectl(['awake', 'on', '--help'], {...io, stdout: (s) => one.push(s)});
  assert.match(one.join(''), /capped \(12h\)/);
});
