// Waiting-on-you list: hook semantics, marker shape, age, joining live
// registry rows to markers (dead pids dropped), and the focus plan.
//
// The one JS copy - lib/pure/waiting.js - is asserted here against
// tests/fixtures/waiting.json; the Swift copy asserts the same file in
// macos/Tests/ClaudeUsageCoreTests/WaitingParityTests.swift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {handleHook, listWaiting, focusWaiting, writeWaitingMarker} from '../claude-code/waiting.js';
import {sessionRegistryDir} from '../claude-code/paths.js';
import {main as waitingMain} from '../claude-code/waiting-cli.js';
import {waitingSegment} from '../claude-code/statusline.js';
import {handleRequest} from '../mcp/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'waiting.json'), 'utf8'));
const NOW = fix.nowMs;

test('WAITING_REASONS and hook events match the fixture', () => {
    assert.deepEqual([...pure.WAITING_REASONS], fix.reasons);
    assert.deepEqual([...pure.WAITING_HOOK_EVENTS], fix.hookEvents);
});

for (const c of fix.markerName) {
    test(`waitingMarkerName - ${c.pid}`, () => {
        assert.equal(pure.waitingMarkerName(c.pid), c.name);
    });
}

for (const c of fix.pidFromName) {
    test(`pidFromWaitingMarkerName - ${c.name}`, () => {
        assert.equal(pure.pidFromWaitingMarkerName(c.name), c.pid);
    });
}

for (const c of fix.reasonFromNotification) {
    test(`reasonFromNotification - ${JSON.stringify(c.payload)}`, () => {
        assert.equal(pure.reasonFromNotification(c.payload), c.reason);
    });
}

for (const c of fix.applyHookEvent) {
    test(`applyHookEvent - ${c.name}`, () => {
        const got = pure.applyHookEvent(c.name, c.payload, NOW);
        if (c.expected.action === 'mark') {
            assert.deepEqual(got, {action: 'mark', reason: c.expected.reason, at: NOW});
        } else {
            assert.deepEqual(got, {action: c.expected.action});
        }
    });
}

for (const [i, c] of fix.parse.entries()) {
    test(`parseWaitingMarker - ${i}`, () => {
        assert.deepEqual(pure.parseWaitingMarker(c.raw), c.expected);
    });
}

for (const c of fix.age) {
    test(`waitingAge - ${c.expected}`, () => {
        assert.equal(pure.waitingAge(c.atMs, NOW), c.expected);
    });
}

test('waitingList joins live sessions, drops dead pids, oldest first', () => {
    assert.deepEqual(pure.waitingList(fix.list.sessions, fix.list.markers, NOW), fix.list.expected);
});

for (const c of fix.focusPlan) {
    test(`focusPlan - ${c.expected.how}`, () => {
        assert.deepEqual(pure.focusPlan(c.row), c.expected);
    });
}

for (const c of fix.focusArgv) {
    test(`focusArgv - ${c.plan.how}`, () => {
        assert.deepEqual(pure.focusArgv(c.plan), c.expected);
    });
}

// ── I/O: markers next to the registry, stale pids ignored ───────────────────

function world(t, {live = [], markers = [], nowMs = NOW} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-wait-'));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    const claude = path.join(home, '.claude');
    const sessions = path.join(claude, 'sessions');
    fs.mkdirSync(sessions, {recursive: true});
    const procDir = path.join(home, 'proc');
    fs.mkdirSync(procDir);
    for (const s of live) {
        fs.writeFileSync(path.join(sessions, `${s.pid}.json`), `${JSON.stringify({
            kind: 'interactive',
            pid: s.pid,
            sessionId: s.sessionId,
            cwd: s.cwd,
            name: s.name,
            procStart: String(s.procStart ?? 99),
            startedAt: s.startedAt ?? 1,
            status: 'running',
        })}\n`);
        const dir = path.join(procDir, String(s.pid));
        fs.mkdirSync(dir);
        // comm is (claude); field 22 (0-based 19 after the last ')') is start time
        fs.writeFileSync(path.join(dir, 'stat'),
            `${s.pid} (claude) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${s.procStart ?? 99} 0\n`);
    }
    for (const m of markers) {
        const pid = m.pid;
        fs.writeFileSync(path.join(sessions, `${pid}.waiting.json`), `${JSON.stringify(m)}\n`);
    }
    return {
        homedir: home,
        env: {HOME: home, CLAUDE_CONFIG_DIR: claude},
        platform: 'linux',
        procDir,
        nowMs: () => nowMs,
    };
}

test('listWaiting ignores a marker whose pid is dead', (t) => {
    const io = world(t, {
        live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}],
        markers: [
            {sessionId: 's1', pid: 11, reason: 'permission', at: NOW - 300_000},
            {sessionId: 'gone', pid: 99, reason: 'idle', at: NOW - 9_000_000},
        ],
    });
    const rows = listWaiting(io);
    assert.deepEqual(rows.map((r) => r.pid), [11]);
    assert.equal(rows[0].reason, 'permission');
    assert.equal(rows[0].age, '5m');
});

test('handleHook Notification writes an atomic marker next to the registry', (t) => {
    const io = world(t, {live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}]});
    const file = path.join(sessionRegistryDir(io), '11.waiting.json');
    handleHook({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        session_id: 's1',
    }, {...io, env: {...io.env, CLAUDE_PID: '11'}});
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(marker.sessionId, 's1');
    assert.equal(marker.pid, 11);
    assert.equal(marker.reason, 'permission');
    assert.equal(marker.at, NOW);
    assert.equal(marker.version, 1);
});

test('handleHook Stop marks idle; UserPromptSubmit clears', (t) => {
    const io = world(t, {live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}]});
    const file = path.join(sessionRegistryDir(io), '11.waiting.json');
    handleHook({hook_event_name: 'Stop', session_id: 's1'},
        {...io, env: {...io.env, CLAUDE_PID: '11'}});
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'idle');
    handleHook({hook_event_name: 'UserPromptSubmit', session_id: 's1'},
        {...io, env: {...io.env, CLAUDE_PID: '11'}});
    assert.equal(fs.existsSync(file), false);
});

test('handleHook SessionEnd and PreToolUse clear; unknown events leave the marker', (t) => {
    const io = world(t, {live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}]});
    const env = {...io.env, CLAUDE_PID: '11'};
    handleHook({hook_event_name: 'Notification', session_id: 's1'}, {...io, env});
    handleHook({hook_event_name: 'SessionStart', session_id: 's1'}, {...io, env});
    assert.equal(listWaiting(io).length, 1);
    handleHook({hook_event_name: 'PreToolUse', session_id: 's1'}, {...io, env});
    assert.equal(listWaiting(io).length, 0);
    handleHook({hook_event_name: 'Stop', session_id: 's1'}, {...io, env});
    handleHook({hook_event_name: 'SessionEnd', session_id: 's1'}, {...io, env});
    assert.equal(listWaiting(io).length, 0);
});

test('writeWaitingMarker is atomic and 0600', (t) => {
    const io = world(t);
    const file = path.join(sessionRegistryDir(io), '11.waiting.json');
    writeWaitingMarker(file, {version: 1, sessionId: 's1', pid: 11, reason: 'idle', at: NOW});
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'idle');
});

test('focusWaiting runs the kitty pid match when nothing is placed', (t) => {
    const io = world(t, {live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}]});
    const ran = [];
    io.exec = (cmd, args) => {
        ran.push([cmd, ...args]);
        return '';
    };
    assert.equal(focusWaiting({pid: 11, sessionId: 's1', name: 'API'}, io), true);
    assert.ok(ran.some((a) => a.join(' ') === 'kitty @ focus-window --match pid:11'));
});

// ── claudectl waiting / status line / MCP ───────────────────────────────────

async function cli(io, ...argv) {
    let text = '';
    const code = await waitingMain(argv, {...io, stdout: (s) => { text += s; }});
    return {code, text};
}

test('claudectl waiting lists oldest first and --json is the structured rows', async (t) => {
    const io = world(t, {
        live: [
            {pid: 11, sessionId: 's1', name: 'API', cwd: '/a'},
            {pid: 22, sessionId: 's2', name: 'WEB', cwd: '/b'},
        ],
        markers: [
            {sessionId: 's2', pid: 22, reason: 'question', at: NOW - 100_000},
            {sessionId: 's1', pid: 11, reason: 'permission', at: NOW - 300_000},
        ],
    });
    const table = await cli(io);
    assert.equal(table.code, 0);
    assert.match(table.text, /Waiting on you/);
    assert.match(table.text, /API/);
    assert.ok(table.text.indexOf('API') < table.text.indexOf('WEB'));
    const json = await cli(io, '--json');
    const rows = JSON.parse(json.text);
    assert.deepEqual(rows.map((r) => r.name), ['API', 'WEB']);
});

test('claudectl waiting with nothing waiting says so', async (t) => {
    const io = world(t, {live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}]});
    const r = await cli(io);
    assert.match(r.text, /nothing waiting/);
});

test('statusline waiting segment is silent at 0 and compact at N', (t) => {
    const io = world(t, {
        live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}],
        markers: [{sessionId: 's1', pid: 11, reason: 'idle', at: NOW - 1000}],
    });
    const empty = world(t);
    assert.equal(waitingSegment({io: empty}), '');
    assert.match(waitingSegment({io}), /wait 1/);
});

test('MCP waiting tool returns the list', async (t) => {
    const io = world(t, {
        live: [{pid: 11, sessionId: 's1', name: 'API', cwd: '/a'}],
        markers: [{sessionId: 's1', pid: 11, reason: 'permission', at: NOW - 300_000}],
    });
    const listed = await handleRequest({method: 'tools/list'});
    assert.ok(listed.tools.some((tool) => tool.name === 'waiting'));
    const r = await handleRequest({method: 'tools/call', params: {name: 'waiting'}}, io);
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.count, 1);
    assert.equal(r.structuredContent.sessions[0].reason, 'permission');
    assert.match(r.content[0].text, /API/);
});

test('hooks-edit adds our waiting hooks without clobbering a foreign one', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-hooks-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, `${JSON.stringify({
        hooks: {Stop: [{hooks: [{type: 'command', command: 'echo mine'}]}]},
    }, null, 2)}\n`);
    const cmd = 'node "/tmp/waiting-hook.js"';
    const edit = path.join(here, '..', 'scripts', 'install', 'hooks-edit.mjs');
    const add = spawnSync(process.execPath, [edit, 'add', file, cmd], {encoding: 'utf8'});
    assert.equal(add.status, 0, add.stderr);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo mine');
    assert.ok(after.hooks.Stop.some((g) => g.hooks?.some((h) => h.command === cmd)));
    assert.ok(after.hooks.Notification.some((g) => g.hooks?.some((h) => h.command === cmd)));
    const rm = spawnSync(process.execPath, [edit, 'remove', file, cmd], {encoding: 'utf8'});
    assert.equal(rm.status, 0, rm.stderr);
    const gone = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(gone.hooks.Stop[0].hooks[0].command, 'echo mine');
    assert.equal(gone.hooks.Notification, undefined);
});
