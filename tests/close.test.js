// claudectl session close (claude-code/close.js + session-cli.js): the plan
// read from a process table, the refusals, and the signal sequence. ps and
// kill are faked: no real process is ever signalled.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {closeBlocker, closePlan, openClose, parsePsTable} from '../claude-code/close.js';
import {main} from '../claude-code/session-cli.js';
import {openTabs} from '../claude-code/tabs.js';
import {world} from './session-world.js';

const A = {pid: 101, name: 'API', id: 'aaaa1111-0000-0000-0000-000000000000', start: 500};
const B = {pid: 202, name: 'WEB', id: 'bbbb2222-0000-0000-0000-000000000000', start: 600};

// A gnome-terminal tab running `bash -lc 'claude "$0"; exec bash'` (A), an
// interactive shell tab (B) that also runs a dev server, and tmux.
const PS = `
    1     0 ?        systemd
  900     1 ?        gnome-terminal-server
  100   900 pts/1    bash
  101   100 pts/1    claude
  110   101 ?        sh
  111   101 pts/1    node
  112   111 pts/1    node
  200   900 pts/2    -bash
  202   200 pts/2    claude
  210   200 pts/2    vite
  300     1 ?        tmux: server
  301   300 pts/3    zsh
  302   301 pts/3    claude
  400     1 ?        sshd
  401   400 pts/4    sshd
  402   401 pts/4    claude
  500     1 ?        claude
`;
const TABLE = parsePsTable(PS);

test('parsePsTable: pid, ppid, tty, comm without the login dash or path', () => {
    assert.deepEqual(TABLE.find((r) => r.pid === 200), {pid: 200, ppid: 900, tty: 'pts/2', comm: 'bash'});
    assert.equal(TABLE.find((r) => r.pid === 300).comm, 'tmux: server');
    assert.deepEqual(parsePsTable('  7 1 ttys001 /bin/zsh\n'), [{pid: 7, ppid: 1, tty: 'ttys001', comm: 'zsh'}]);
});

test('closePlan: the tab shell is ended, claude\'s own children are not foreign', () => {
    assert.deepEqual(closePlan(TABLE, 101), {tty: 'pts/1', shells: [100], foreign: []});
});

test('closePlan: another job in the same tab is foreign', () => {
    assert.deepEqual(closePlan(TABLE, 202), {tty: 'pts/2', shells: [200], foreign: [{pid: 210, comm: 'vite'}]});
});

test('closePlan: the walk stops at the first non-shell (tmux, sshd, the terminal)', () => {
    assert.deepEqual(closePlan(TABLE, 302).shells, [301]);
    assert.deepEqual(closePlan(TABLE, 402), {tty: 'pts/4', shells: [], foreign: [{pid: 401, comm: 'sshd'}]});
});

test('closePlan: no tty or unknown pid -> nothing beyond claude', () => {
    assert.deepEqual(closePlan(TABLE, 500), {tty: null, shells: [], foreign: []});
    assert.deepEqual(closePlan(TABLE, 999), {tty: null, shells: [], foreign: []});
});

test('closeBlocker: self, busy, foreign work', () => {
    const plan = {shells: [100], foreign: []};
    assert.equal(closeBlocker({pid: 101, status: 'idle'}, plan, {self: 101}), 'the session you are in');
    assert.equal(closeBlocker({pid: 101, status: 'busy'}, plan, {self: 1}), 'busy (mid-turn)');
    assert.match(closeBlocker({pid: 202, status: 'idle'}, closePlan(TABLE, 202), {self: 1}), /vite 210/);
    assert.equal(closeBlocker({pid: 101, status: 'idle'}, plan, {self: 1}), null);
});

// kill(pid, sig): records every signal; `dies` says which signal ends a pid.
function fakeKill(dies = {}) {
    const sent = [];
    const dead = new Set();
    const kill = (pid, sig) => {
        if (sig === 0) {
            if (dead.has(pid)) throw Object.assign(new Error('ESRCH'), {code: 'ESRCH'});
            return true;
        }
        sent.push([pid, sig]);
        if ((dies[pid] ?? ['SIGTERM', 'SIGKILL', 'SIGHUP']).includes(sig)) dead.add(pid);
        return true;
    };
    // what identifies a pid (procs.js processIdentity): gone once it died,
    // another value once `recycle(pid)` handed the number to a new process
    const recycled = new Set();
    const identity = (pid) => (dead.has(pid) ? null : `${pid}@${recycled.has(pid) ? 'new' : 'old'}`);
    return {kill, sent, identity, recycle: (pid) => recycled.add(pid)};
}
const noSleep = async () => {};

async function closeWith(opts, pid, flags) {
    const closer = openClose({sleep: noSleep, ...opts});
    return closer.closeOne({pid}, closer.pin({pid}, closePlan(TABLE, pid)), flags);
}

test('closeOne: SIGTERM claude, then SIGHUP the tab shell', async () => {
    const {kill, sent, identity} = fakeKill();
    const r = await closeWith({kill, identity}, 101);
    assert.deepEqual(r, {closed: true, tab: true, how: 'SIGTERM'});
    assert.deepEqual(sent, [[101, 'SIGTERM'], [100, 'SIGHUP']]);
});

test('closeOne: a claude that ignores SIGTERM is left, tab untouched, without --force', async () => {
    const {kill, sent, identity} = fakeKill({101: ['SIGKILL']});
    const r = await closeWith({kill, identity, graceMs: 1000}, 101);
    assert.equal(r.closed, false);
    assert.deepEqual(sent, [[101, 'SIGTERM']]);
});

test('closeOne: --force sends SIGKILL after the grace, then closes the tab', async () => {
    const {kill, sent, identity} = fakeKill({101: ['SIGKILL']});
    const r = await closeWith({kill, identity, graceMs: 1000}, 101, {force: true});
    assert.deepEqual(r, {closed: true, tab: true, how: 'SIGKILL'});
    assert.deepEqual(sent, [[101, 'SIGTERM'], [101, 'SIGKILL'], [100, 'SIGHUP']]);
});

// The pid was checked when the plan was made; the user then took their time
// over the confirm. A number handed to another process meanwhile is never
// signalled - not claude's, not a shell's.
test('closeOne: a pid recycled since the plan is never signalled', async () => {
    const f = fakeKill();
    const closer = openClose({kill: f.kill, identity: f.identity, sleep: noSleep});
    const plan = closer.pin({pid: 101}, closePlan(TABLE, 101));
    f.recycle(101);
    const r = await closer.closeOne({pid: 101}, plan);
    assert.equal(r.closed, false);
    assert.match(r.how, /no longer the process/);
    assert.deepEqual(f.sent, []);

    const g = fakeKill();
    const closer2 = openClose({kill: g.kill, identity: g.identity, sleep: noSleep});
    const plan2 = closer2.pin({pid: 101}, closePlan(TABLE, 101));
    g.recycle(100); // the tab shell's number went to another process
    assert.deepEqual(await closer2.closeOne({pid: 101}, plan2), {closed: true, tab: false, how: 'SIGTERM'});
    assert.deepEqual(g.sent, [[101, 'SIGTERM']], 'the recycled shell pid is left alone');
});

test('closeOne: a claude that ignores SIGTERM and whose pid is then recycled is not SIGKILLed', async () => {
    const f = fakeKill({101: []});
    const closer = openClose({kill: f.kill, identity: f.identity, graceMs: 1000,
        sleep: async () => f.recycle(101)});
    const plan = closer.pin({pid: 101}, closePlan(TABLE, 101));
    const r = await closer.closeOne({pid: 101}, plan, {force: true});
    assert.equal(r.how, 'SIGTERM', 'it left: the pid is someone else now');
    assert.deepEqual(f.sent.filter(([, sig]) => sig === 'SIGKILL'), []);
});

// The CLI over a fake registry: A in a bash -lc tab, B with a dev server in
// its tab; the test process (9999) runs under neither.
function cli(t) {
    const io = world(t, [A, B]);
    const {kill, sent, identity, recycle} = fakeKill();
    let text = '';
    Object.assign(io, {
        kill, identity, sleep: noSleep, stdout: (x) => { text += x; },
        exec: (cmd) => {
            if (cmd === 'ps') return PS;
            throw new Error(`unexpected ${cmd}`);
        },
    });
    return {io, sent, recycle, text: () => text};
}

test('session close --dry-run prints the plan and signals nothing', async (t) => {
    const {io, sent, text} = cli(t);
    assert.equal(await main(['close', 'API', '--dry-run'], io), 0);
    assert.match(text(), /close API .* pid 101 {2}tab pts\/1, shells 100/);
    assert.deepEqual(sent, []);
    assert.equal(openTabs(io).snapshots().length, 0);
});

test('session close: snapshot of the closed ones first, then the signals', async (t) => {
    const {io, sent, text} = cli(t);
    assert.equal(await main(['close', 'API', '--yes'], io), 0);
    const [snap] = openTabs(io).snapshots();
    assert.match(snap.label, /^auto-closed-/);
    assert.deepEqual(snap.sessions.map((s) => s.session_id), [A.id]);
    assert.deepEqual(sent, [[101, 'SIGTERM'], [100, 'SIGHUP']]);
    assert.match(text(), /closed API: SIGTERM, tab closed/);
});

test('session close: foreign work in the tab refuses without --force', async (t) => {
    const {io, sent, text} = cli(t);
    assert.equal(await main(['close', 'WEB', '--yes'], io), 1);
    assert.match(text(), /skip {2}WEB: other processes on its tab: vite 210 \(--force/);
    assert.deepEqual(sent, []);
    assert.equal(await main(['close', 'WEB', '--yes', '--force'], io), 0);
    assert.deepEqual(sent, [[202, 'SIGTERM'], [200, 'SIGHUP']]);
});

test('session close: asks unless --yes; no answer closes nothing', async (t) => {
    const {io, sent} = cli(t);
    const asked = [];
    assert.equal(await main(['close', 'API'], {...io, confirm: async (q) => { asked.push(q); return false; }}), 1);
    assert.deepEqual(asked, ['close 1 session(s)? [y/N] ']);
    assert.deepEqual(sent, []);
});

test('session close: a pid recycled while the confirm waited is not signalled', async (t) => {
    const {io, sent, recycle, text} = cli(t);
    const confirm = async () => {
        recycle(101); // API exited and its number was reused before the "y"
        return true;
    };
    assert.equal(await main(['close', 'API'], {...io, confirm}), 1);
    assert.deepEqual(sent, []);
    assert.match(text(), /FAILED API: pid no longer the process/);
});

test('session close: the session you are in is refused, even with --force', async (t) => {
    const {io, sent, text} = cli(t);
    io.env = {...io.env, CLAUDE_PID: '101'};
    assert.equal(await main(['close', 'API', '--yes', '--force'], io), 1);
    assert.match(text(), /skip {2}API: the session you are in\n/);
    assert.deepEqual(sent, []);
});

test('session close: needs a target', async (t) => {
    const {io} = cli(t);
    await assert.rejects(main(['close'], io), /close needs/);
});
