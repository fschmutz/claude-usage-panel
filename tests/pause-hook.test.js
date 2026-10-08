// The pause hook: the asyncRewake waiter (in process, then as the real
// `node pause-hook.js wait` Claude Code starts) and the PreToolUse backstop.
// Everything runs in a throwaway HOME / state dir; the only processes
// started or signalled are the hooks this file spawns itself.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {handlePretool, startWaiter} from '../claude-code/pause-hook.js';
import {openPause} from '../claude-code/pause.js';
import {pauseDir} from '../claude-code/paths.js';
import {A, B, pauseWorld, realProcStart} from './pause-world.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-code', 'pause-hook.js');
const payload = (sid, extra = {}) => ({session_id: sid, hook_event_name: 'Stop', cwd: '/w', ...extra});

// The waiter runs on the real clock: requests are stamped now.
function liveWorld(t, sessions = [{pid: 11, name: 'API', id: A}]) {
    const io = pauseWorld(t, sessions);
    io.nowMs = () => Date.now();
    // the waiter lock names this test process: alive, deterministic, ours
    io.pid = process.pid;
    return io;
}

const send = (io, kind = 'pause') => {
    const pause = openPause(io);
    return pause.sendRequest({kind, rows: pause.tabs.liveSessions()});
};

test('waiter: idle until a request names its session, then exit 2 with the protocol, exactly once', async (t) => {
    const io = liveWorld(t);
    const w = startWaiter(payload(A), {...io, pollMs: 50, maxMs: 10_000});
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fs.existsSync(path.join(pauseDir(io), `${A}.waiter`)), 'the lock is held while waiting');
    const req = send(io);
    const {code, text} = await w.done;
    assert.equal(code, 2);
    assert.match(text, new RegExp(`^\\[claudectl pause request ${req.id}\\]`));
    assert.match(text, /PAUSE PROTOCOL/);
    assert.equal(fs.existsSync(path.join(pauseDir(io), `${A}.waiter`)), false, 'the lock goes with the waiter');
    const rec = JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${A}.delivered.json`), 'utf8'));
    assert.deepEqual([rec.requestId, rec.via], [req.id, 'rewake']);

    // the Stop after the woken turn arms a fresh waiter: it must not fire again
    const again = startWaiter(payload(A), {...io, pollMs: 20, maxMs: 200});
    assert.deepEqual(await again.done, {code: 0, text: ''});
});

test('waiter: a second waiter for the same session leaves at once', async (t) => {
    const io = liveWorld(t);
    const first = startWaiter(payload(A), {...io, pollMs: 50, maxMs: 5000});
    const second = startWaiter(payload(A), {...io, pid: 777_777, pollMs: 50, maxMs: 5000});
    assert.deepEqual(await second.done, {code: 0, text: ''});
    first.stop();
    assert.deepEqual(await first.done, {code: 0, text: ''});
    assert.equal(fs.existsSync(path.join(pauseDir(io), `${A}.waiter`)), false);
});

test('waiter: a request for another session, a subagent payload or no session id never fire', async (t) => {
    const io = liveWorld(t, [{pid: 11, name: 'API', id: A}, {pid: 12, name: 'WEB', id: B}]);
    const pause = openPause(io);
    pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions().filter((r) => r.session_id === B)});
    assert.equal((await startWaiter(payload(A), {...io, pollMs: 20, maxMs: 150}).done).code, 0);
    assert.equal((await startWaiter(payload(B, {agent_id: 'x'}), {...io, maxMs: 150}).done).code, 0);
    assert.equal((await startWaiter({}, io).done).code, 0);
});

test('waiter: leaves when its claude dies, and after /clear moved the session id', async (t) => {
    const io = liveWorld(t);
    // CLAUDE_PID 11 is the registered session A: alive in the fake /proc
    let alive = true;
    const dead = startWaiter(payload(A), {
        ...io, env: {...io.env, CLAUDE_PID: '11'}, pidAlive: () => alive, pollMs: 20, maxMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 60));
    fs.rmSync(path.join(io.procDir, '11'), {recursive: true});
    alive = false;
    assert.deepEqual(await dead.done, {code: 0, text: ''});

    const io2 = liveWorld(t);
    const reg = path.join(io2.home, '.claude', 'sessions', '11.json');
    const cleared = startWaiter(payload(A), {...io2, env: {...io2.env, CLAUDE_PID: '11'}, pollMs: 20, maxMs: 5000});
    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(reg, JSON.stringify({...JSON.parse(fs.readFileSync(reg, 'utf8')), sessionId: B}));
    send(io2); // a pause for A: the old waiter must not deliver it into the new conversation
    assert.deepEqual(await cleared.done, {code: 0, text: ''});
    assert.equal(fs.existsSync(path.join(pauseDir(io2), `${A}.delivered.json`)), false);
});

test('waiter: an expired request is never delivered', async (t) => {
    const io = liveWorld(t);
    const pause = openPause(io);
    io.nowMs = () => Date.now() - 2 * 3_600_000;
    pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    io.nowMs = () => Date.now();
    assert.equal((await startWaiter(payload(A), {...io, pollMs: 20, maxMs: 150}).done).code, 0);
});

test('pretool: denies one call with the protocol, never a second; skips subagents', (t) => {
    const io = liveWorld(t);
    assert.equal(handlePretool(payload(A, {hook_event_name: 'PreToolUse'}), io), null, 'no request: fast path');
    const req = send(io);
    assert.equal(handlePretool(payload(A, {agent_id: 'sub-1'}), io), null, 'a subagent never spends the delivery');
    const out = handlePretool(payload(A, {hook_event_name: 'PreToolUse', tool_name: 'Bash'}), io);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`request ${req.id}\\].*held back on purpose`));
    assert.equal(handlePretool(payload(A, {hook_event_name: 'PreToolUse'}), io), null, 'once per request');
    assert.equal(JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${A}.delivered.json`), 'utf8')).via, 'pretooluse');
});

// ── the real process, as Claude Code starts it ─────────────────────────────
function hookEnv(io) {
    return {
        PATH: process.env.PATH, HOME: io.home, XDG_STATE_HOME: path.join(io.home, 'state'),
        CLAUDE_CONFIG_DIR: path.join(io.home, '.claude'), CLAUDE_PID: String(process.pid),
    };
}

// The spawned hook sees CLAUDE_PID = this test process: the session is
// registered under it, with its real start time, as Claude Code would.
const SELF = (id, name) => [{pid: process.pid, procStart: realProcStart(), name, id}];

test('`pause-hook.js wait` wakes with exit 2 and the protocol on stderr; pretool prints the deny', async (t) => {
    const io = liveWorld(t, SELF(A, 'API'));
    const child = spawn(process.execPath, [HOOK, 'wait'], {env: hookEnv(io), stdio: ['pipe', 'pipe', 'pipe']});
    t.after(() => child.exitCode === null && child.kill('SIGKILL'));
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.on('data', (d) => (stdout += d));
    child.stdin.end(JSON.stringify(payload(A)));
    const lock = path.join(pauseDir(io), `${A}.waiter`);
    for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(lock), 'the waiter armed');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, child.pid);
    const req = send(io);
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 2, stderr);
    assert.match(stderr, new RegExp(`claudectl pause request ${req.id}`));
    assert.equal(stdout, '', 'stderr only: Claude Code shows stderr when it is not empty');

    // B never got it: its backstop answers once, then stays silent
    const io2 = liveWorld(t, SELF(B, 'WEB'));
    send(io2);
    const pre = (sid) => spawnSync(process.execPath, [HOOK, 'pretool'], {
        env: hookEnv(io2), input: JSON.stringify(payload(sid, {hook_event_name: 'PreToolUse'})), encoding: 'utf8',
    });
    const first = pre(B);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(pre(B).stdout, '');
});

test('`pause-hook.js wait` leaves on SIGTERM with exit 0 and its lock removed', async (t) => {
    const io = liveWorld(t);
    const child = spawn(process.execPath, [HOOK, 'wait'], {env: hookEnv(io), stdio: ['pipe', 'ignore', 'ignore']});
    t.after(() => child.exitCode === null && child.kill('SIGKILL'));
    child.stdin.end(JSON.stringify(payload(A)));
    const lock = path.join(pauseDir(io), `${A}.waiter`);
    for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(lock));
    child.kill('SIGTERM');
    assert.equal(await new Promise((r) => child.on('exit', r)), 0);
    assert.equal(fs.existsSync(lock), false);
});
