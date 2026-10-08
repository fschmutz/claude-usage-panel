// Pause / resume: the shared contract (lib/pure/pause.js against
// tests/fixtures/pause.json, which the Swift PauseParityTests assert too),
// the protocol texts, the hook JSON, and the store in a throwaway state dir:
// 0600 files, exactly-once delivery, the waiter lock and the verdict.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {spawn} from 'node:child_process';

import {openPause, takeOverStale} from '../claude-code/pause.js';
import {pauseDir, projectsDir} from '../claude-code/paths.js';
import {transcriptPath} from '../claude-code/tabs.js';
import {A, B, pauseWorld} from './pause-world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pause.json'), 'utf8'));
const NOW = fix.nowMs;

test('pause constants match the fixture', () => {
    assert.equal(pure.PAUSE_VERSION, fix.version);
    assert.deepEqual([...pure.PAUSE_KINDS], fix.kinds);
    assert.deepEqual([...pure.PAUSE_VERDICTS], fix.verdicts);
    assert.deepEqual([...pure.PAUSE_SOURCES], fix.sources);
    assert.deepEqual([...pure.PAUSE_VIAS], fix.vias);
    assert.equal(pure.PAUSE_REQUEST_TTL_MS, fix.requestTtlMs);
    assert.equal(pure.PAUSE_HOOK_TIMEOUT_S, fix.hookTimeoutS);
    assert.equal(pure.PAUSE_CONSUMED_GRACE_MS, fix.pauseOwedGraceMs);
    assert.equal(pure.PAUSE_OWED_MAX_AGE_MS, fix.pauseOwedMaxAgeMs);
    assert.equal(pure.PAUSE_REASON_MAX, fix.reasonMax);
});

for (const c of fix.fileNames) {
    test(`pauseFileNames - ${c.sessionId}`, () => assert.deepEqual(pure.pauseFileNames(c.sessionId), c.expected));
}
for (const c of fix.isSessionId) {
    test(`isPauseSessionId - ${JSON.stringify(c.id.slice(0, 12))}`, () => assert.equal(pure.isPauseSessionId(c.id), c.expected));
}
for (const [kind, fn] of [['parseRequest', pure.parsePauseRequest], ['parseDelivered', pure.parsePauseDelivered],
    ['parseVerdict', pure.parsePauseVerdict]]) {
    for (const [i, c] of fix[kind].entries()) test(`${kind} - ${i}`, () => assert.deepEqual(fn(c.raw), c.expected));
}
for (const c of fix.shouldDeliver) {
    test(`shouldDeliver - ${c.name}`, () => {
        assert.equal(pure.shouldDeliver(c.request, c.sessionId, c.delivered, NOW), c.expected);
    });
}
for (const [i, c] of fix.pretoolEligible.entries()) {
    test(`pretoolEligible - ${i}`, () => assert.equal(pure.pretoolEligible(c.payload), c.expected));
}
for (const c of fix.pauseOwed) {
    test(`pauseOwed - ${c.name}`, () => assert.equal(pure.pauseOwed({...c.input, nowMs: NOW}), c.expected));
}
for (const [i, c] of fix.clean.entries()) {
    test(`cleanPauseText - ${i}`, () => assert.equal(pure.cleanPauseText(c.text, c.max), c.expected));
}
for (const c of fix.bindingOk) {
    test(`pauseBindingOk - ${c.name}`, () => assert.equal(pure.pauseBindingOk(c.request, c.sessionId, c.current), c.expected));
}
for (const [i, c] of fix.rowName.entries()) {
    test(`pauseRowName - ${i}`, () => assert.equal(pure.pauseRowName(c.sessionId, c.live, c.meta), c.expected));
}
for (const c of fix.rows) {
    test(`pauseRows - ${c.name}`, () => assert.deepEqual(pure.pauseRows({...c.input, nowMs: NOW}), c.expected));
}

test('status fixture: the pause-status --json rows are pauseRows targets plus their label', () => {
    const {targets, summary} = pure.pauseRows({...fix.rows[0].input, nowMs: NOW});
    assert.deepEqual(fix.status.json.rows, targets.map((r) => ({...r, label: pure.pauseRowLabel(r)})));
    assert.deepEqual(fix.status.json.summary, summary);
    assert.deepEqual(fix.status.json.request, pure.parsePauseRequest(fix.rows[0].input.request));
});
for (const c of fix.rowState) {
    test(`pauseRowState - ${c.name}`, () => assert.deepEqual(pure.pauseRowState({...c.input, nowMs: NOW}), c.expected));
}
for (const c of fix.summary) {
    test(`pauseSummary - ${c.kind} ${c.states.join(',')}`, () => {
        assert.deepEqual(pure.pauseSummary(c.states.map((state) => ({state})), c.kind), c.expected);
    });
}
for (const c of fix.exitCode) {
    test(`pauseExitCode - ${c.expected}`, () => assert.equal(pure.pauseExitCode(c.summary), c.expected));
}

test('every row state has a label, and none is empty', () => {
    for (const state of ['safe', 'not-safe', 'resumed', 'delivered', 'pending', 'unarmed', 'lost', 'expired', 'gone']) {
        assert.ok(pure.pauseRowLabel({state, via: 'rewake'}).length > 2, state);
    }
    assert.equal(pure.pauseRowLabel({state: 'not-safe', reason: 'CI 4'}), 'NOT SAFE: CI 4');
    assert.match(pure.pauseRowLabel({state: 'superseded'}), /superseded/);
    assert.match(pure.pauseRowLabel({state: 'expired', via: 'rewake'}), /no verdict within the hour/);
});

// ── the texts ───────────────────────────────────────────────────────────────
const REQ = fix.parseRequest[0].raw;
const textOf = (over = {}) => pure.pauseDeliveryText({
    request: REQ, sentAt: '14:05', checkpoint: '/st/pause/checkpoints/A.md', report: "'/n' '/c.js' session report --session A --request R",
    verdictFile: '/st/pause/A.verdict.json', reasonFile: '/st/pause/A.reason.txt', via: 'rewake', ...over,
});

test('the pause text names its origin, the checkpoint, the report command and the fallback file', () => {
    const t = textOf();
    assert.match(t, /^\[claudectl pause request mf3k2a-1a2b3c\] The user clicked Pause in the GNOME panel at 14:05;/);
    assert.doesNotMatch(t, /third party/, 'nothing it cannot back up');
    assert.match(t, /PAUSE PROTOCOL/);
    assert.match(t, /\n {6}\/st\/pause\/checkpoints\/A\.md\n/, 'step 3b names the fixed path');
    assert.match(t, /session report --session A --request R --verdict SAFE --checkpoint '\/st\/pause\/checkpoints\/A\.md'/);
    assert.match(t, /--verdict NOT_SAFE --checkpoint '\/st\/pause\/checkpoints\/A\.md' --reason-file '\/st\/pause\/A\.reason\.txt'/);
    assert.match(t, /\/st\/pause\/A\.reason\.txt with your file-writing tool/);
    assert.doesNotMatch(t, /--reason '/, 'a model-written reason never goes through shell quotes');
    assert.match(t, /write this JSON to \/st\/pause\/A\.verdict\.json/);
    assert.match(t, /"requestId": "mf3k2a-1a2b3c"/);
    assert.match(t, /^ {3}SAFE TO CLOSE$/m);
    assert.doesNotMatch(t, /held back/);
    assert.doesNotMatch(t, /\u2014/, 'no em-dash');
    assert.doesNotMatch(t, /PAUSE-CHECKPOINT\.md/, 'the request path replaces the generic one');
});

test('a PreToolUse delivery says the held-back call was on purpose', () => {
    assert.match(textOf({via: 'pretooluse'}), /held back on purpose[^\n]*not an error/);
});

test('the resume text carries the checkpoint, or says it is missing', () => {
    const r = {...REQ, id: 'r-1', kind: 'resume', from: 'cli'};
    const yes = textOf({request: r, checkpointExists: true});
    assert.match(yes, /^\[claudectl resume request r-1\] The user typed `claudectl session resume`/);
    assert.match(yes, /RESUME PROTOCOL\nYour checkpoint: \/st\/pause\/checkpoints\/A\.md\n1\. Read the checkpoint/);
    assert.doesNotMatch(yes, /PAUSE PROTOCOL/);
    assert.match(textOf({request: r}), /No checkpoint was found at \/st\/pause\/checkpoints\/A\.md/);
    assert.ok(yes.trimEnd().endsWith(pure.PAUSE_RESUME_GUARD), 'a resume keeps the approval rule');
    assert.match(pure.PAUSE_RESUME_GUARD, /nothing destructive, outward-facing or still waiting on the user's answer/);
});

test('a request sent from inside a Claude Code session says so and asks the user first', () => {
    const s = {...REQ, from: 'session', origin: 'cccc3333-0000-4000-8000-000000000003'};
    const t = textOf({request: s});
    assert.match(t, /^\[claudectl pause request mf3k2a-1a2b3c\] Sent at 14:05 from inside Claude Code session cccc3333, not typed by the user\./);
    assert.match(t, /ask the user whether they want this session paused; run the protocol below only if they say so/);
    assert.doesNotMatch(t, /The user (clicked|typed)/);
    const r = textOf({request: {...s, kind: 'resume'}});
    assert.match(r, /ask the user whether they want it resumed/);
    assert.match(textOf({request: {...s, origin: null}}), /from inside another Claude Code session/);
    assert.equal(pure.pauseDeliveryText({request: {kind: 'x'}}), '');
});

test('the deny output is the PreToolUse hookSpecificOutput shape', () => {
    assert.deepEqual(pure.pauseDenyOutput('T'), {hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'T',
    }});
});

test('the hooks: SessionStart + Stop asyncRewake waiters, a PreToolUse backstop (the probed JSON)', () => {
    assert.deepEqual(pure.pauseHookEntries('node "/t/pause-hook.js"'), [
        {event: 'SessionStart', hook: {type: 'command', command: 'node "/t/pause-hook.js" wait', asyncRewake: true, timeout: 86400}},
        {event: 'Stop', hook: {type: 'command', command: 'node "/t/pause-hook.js" wait', asyncRewake: true, timeout: 86400}},
        {event: 'PreToolUse', matcher: '*', hook: {type: 'command', command: 'node "/t/pause-hook.js" pretool', timeout: 10}},
    ]);
});

// ── the store ───────────────────────────────────────────────────────────────

const mode = (f) => fs.statSync(f).mode & 0o777;

test('sendRequest writes one 0600 request in a 0700 dir; a newer one supersedes it', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const live = pause.tabs.liveSessions();
    const r1 = pause.sendRequest({kind: 'pause', rows: live, from: 'gnome'});
    assert.match(r1.id, /^[a-z0-9]+-[0-9a-f]{6}$/);
    assert.deepEqual(r1.targets, [A]);
    assert.deepEqual(r1.sessions, [{sessionId: A, name: 'API', cwd: live[0].cwd, pid: 11, procStart: '110'}],
        'each target is bound to the process it was sent to');
    assert.equal(r1.origin, null);
    const file = path.join(pauseDir(io), 'request.json');
    assert.equal(mode(file), 0o600);
    assert.equal(mode(pauseDir(io)), 0o700);
    io.tick(1000);
    const r2 = pause.sendRequest({kind: 'resume', rows: live});
    assert.equal(pause.readRequest().id, r2.id);
    assert.notEqual(r2.id, r1.id);
    assert.throws(() => pause.sendRequest({kind: 'pause', rows: [{session_id: '../x', name: 'x', cwd: '/'}]}), /no valid session id/);
    assert.deepEqual(pause.readKnown().get(A), {name: 'API', cwd: live[0].cwd, at: NOW + 1000}, 'known.json keeps the name and cwd');
    assert.equal(mode(path.join(pauseDir(io), 'known.json')), 0o600);
});

test('a session id never reaches a path unvalidated', (t) => {
    const pause = openPause(pauseWorld(t));
    assert.throws(() => pause.checkpointPath('../etc'), /bad session id/);
    assert.equal(pause.waiterLive('../etc'), false);
    assert.equal(pause.isPaused('a/b'), false);
});

test('claim delivers exactly once per (session, request), whichever hook asks first', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    assert.equal(pause.claim(A, req, 'rewake'), true);
    assert.equal(pause.claim(A, req, 'pretooluse'), false, 'the backstop never blocks a second time');
    assert.equal(pause.claim(B, req, 'rewake'), false, 'not targeted');
    const rec = JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${A}.delivered.json`), 'utf8'));
    assert.deepEqual(rec, {requestId: req.id, at: NOW, via: 'rewake'});
    assert.equal(mode(path.join(pauseDir(io), `${A}.delivered.json`)), 0o600);
    io.tick(1000);
    const next = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    assert.equal(pause.claim(A, next, 'pretooluse'), true, 'a newer request is owed again');
});

test('a claim held by a live hook blocks; a stale one (by its real mtime) is taken over', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    io.nowMs = () => Date.now();
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    const lock = path.join(pauseDir(io), `${A}.claim`);
    fs.writeFileSync(lock, 'other:1\n');
    assert.equal(pause.claim(A, req, 'rewake'), false);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(pause.claim(A, req, 'rewake'), true);
    assert.equal(fs.existsSync(lock), false);
    assert.deepEqual(fs.readdirSync(pauseDir(io)).filter((f) => f.endsWith('.stale')), [], 'no tombstone left');
});

test('takeOverStale: only the caller that moves the stale lock wins; a fresh lock moved by mistake goes back', (t) => {
    const io = pauseWorld(t);
    fs.mkdirSync(pauseDir(io), {recursive: true});
    const lock = path.join(pauseDir(io), `${A}.claim`);
    fs.writeFileSync(lock, 'crashed:1\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const seen = fs.statSync(lock); // both callers judged THIS file stale
    assert.equal(takeOverStale(lock, seen), true, 'the first one moves it');
    fs.writeFileSync(lock, 'winner:2\n', {flag: 'wx'}); // and creates its own
    assert.equal(takeOverStale(lock, seen), false, 'the second one moved a fresh lock');
    assert.equal(fs.readFileSync(lock, 'utf8'), 'winner:2\n', 'it is back, untouched');
    fs.rmSync(lock);
    assert.equal(takeOverStale(lock, seen), false, 'nothing to move');
    assert.deepEqual(fs.readdirSync(pauseDir(io)).filter((f) => f.endsWith('.stale')), []);
});

test('claims racing in separate processes over a stale lock deliver exactly once', async (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    io.nowMs = () => Date.now();
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    const lock = path.join(pauseDir(io), `${A}.claim`);
    fs.writeFileSync(lock, 'crashed:1\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const mod = pathToFileURL(path.join(here, '..', 'claude-code', 'pause.js')).href;
    const ioJson = JSON.stringify({home: io.home, homedir: io.homedir, procDir: io.procDir, env: io.env, platform: io.platform});
    const script = `const {openPause} = await import(${JSON.stringify(mod)});
        const io = JSON.parse(process.argv[1]);
        const req = JSON.parse(process.argv[2]);
        const go = Date.now() + 300; while (Date.now() < go) { /* start together */ }
        process.stdout.write(String(openPause(io).claim(${JSON.stringify(A)}, req, 'rewake')));`;
    const runs = Array.from({length: 6}, () => new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, ioJson, JSON.stringify(req)],
            {stdio: ['ignore', 'pipe', 'inherit']});
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('exit', () => resolve(out));
    }));
    const results = await Promise.all(runs);
    assert.equal(results.filter((r) => r === 'true').length, 1, results.join(','));
    assert.equal(JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${A}.delivered.json`), 'utf8')).requestId, req.id);
});

test('a request is taken only by the process it was sent to: a reopened session is not paused by it', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    // closed before delivery, reopened with `claude --resume A` as pid 21
    fs.rmSync(path.join(io.procDir, '11'), {recursive: true});
    fs.rmSync(path.join(io.home, '.claude', 'sessions', '11.json'));
    const world2 = pauseWorld(t, [{pid: 21, name: 'API', id: A}]);
    for (const d of ['21']) fs.cpSync(path.join(world2.procDir, d), path.join(io.procDir, d), {recursive: true});
    fs.cpSync(path.join(world2.home, '.claude', 'sessions', '21.json'), path.join(io.home, '.claude', 'sessions', '21.json'));
    assert.equal(pause.claim(A, req, 'rewake', {pid: 21}), false, 'the waiter of the new process');
    assert.equal(pause.claim(A, req, 'pretooluse'), false, 'the backstop, looked up by session id');
    assert.equal(fs.existsSync(path.join(pauseDir(io), `${A}.delivered.json`)), false);
    io.tick(1000);
    const next = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    assert.equal(pause.claim(A, next, 'rewake', {pid: 21}), true, 'a request sent to it is delivered');
});

test('one live waiter per session; a dead holder is stale', (t) => {
    const io = pauseWorld(t);
    const alive = new Set([100]);
    io.pidAlive = (pid) => alive.has(pid);
    const pause = openPause(io);
    const release = pause.acquireWaiter(A, 100);
    assert.equal(typeof release, 'function');
    assert.equal(mode(path.join(pauseDir(io), `${A}.waiter`)), 0o600);
    assert.equal(pause.waiterLive(A), true);
    assert.equal(pause.acquireWaiter(A, 101), null, 'the second waiter leaves');
    alive.delete(100);
    assert.equal(pause.waiterLive(A), false);
    const r2 = pause.acquireWaiter(A, 101);
    assert.ok(r2, 'a crashed waiter does not block the next one');
    release(); // the old holder's release must not remove the new lock
    assert.ok(fs.existsSync(path.join(pauseDir(io), `${A}.waiter`)));
    r2();
    assert.equal(fs.existsSync(path.join(pauseDir(io), `${A}.waiter`)), false);
});

test('report writes a 0600 verdict; status joins requests, deliveries, verdicts and liveness', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}, {pid: 12, name: 'WEB', id: B}]);
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    let st = pause.status();
    assert.deepEqual(st.rows.map((r) => [r.name, r.state]), [['API', 'unarmed'], ['WEB', 'unarmed']]);
    assert.equal(st.summary.label, '0/2 safe');
    pause.claim(A, req, 'rewake');
    pause.claim(B, req, 'pretooluse');
    // the model writes these with its own tool, under its umask
    fs.mkdirSync(path.dirname(pause.checkpointPath(A)), {recursive: true});
    fs.writeFileSync(pause.checkpointPath(A), '# checkpoint\n', {mode: 0o664});
    fs.chmodSync(pause.checkpointPath(A), 0o664);
    const outside = path.join(pauseDir(io), '..', 'outside.txt');
    fs.writeFileSync(outside, 'x', {mode: 0o644});
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(pauseDir(io), `${A}.reason.txt`));
    pause.report({sessionId: A, requestId: req.id, verdict: 'SAFE', checkpoint: pause.checkpointPath(A)});
    assert.equal(mode(pause.checkpointPath(A)), 0o600);
    assert.equal(mode(outside), 0o644, 'a symlinked reason file is never followed');
    pause.report({sessionId: B, requestId: req.id, verdict: 'NOT_SAFE', reason: 'deploy 7'});
    assert.equal(mode(path.join(pauseDir(io), `${A}.verdict.json`)), 0o600);
    st = pause.status();
    assert.deepEqual(st.rows.map((r) => [r.name, r.state, r.via]), [['API', 'safe', 'rewake'], ['WEB', 'not-safe', 'pretooluse']]);
    assert.equal(st.rows[1].label, 'NOT SAFE: deploy 7');
    assert.deepEqual([st.summary.label, st.summary.done, st.summary.ok], ['1/2 safe', true, false]);
    assert.throws(() => pause.report({sessionId: A, requestId: req.id, verdict: 'MAYBE'}), /SAFE\|NOT_SAFE/);
    assert.throws(() => pause.report({sessionId: '../a', requestId: req.id, verdict: 'SAFE'}), /bad session id/);
});

test('status: the real pause-status --json shape is the one the fixture pins for the Swift reader', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    pause.claim(A, req, 'rewake');
    pause.report({sessionId: A, requestId: req.id, verdict: 'NOT_SAFE', reason: 'deploy\u001b[2J 7'});
    const st = JSON.parse(JSON.stringify(pause.status()));
    assert.deepEqual(Object.keys(st), Object.keys(fix.status.json));
    assert.deepEqual(Object.keys(st.rows[0]), Object.keys(fix.status.json.rows[0]));
    assert.deepEqual(Object.keys(st.request).sort(), Object.keys(fix.status.json.request).sort());
    assert.deepEqual(Object.keys(st.summary), Object.keys(fix.status.json.summary));
    assert.equal(st.rows[0].label, 'NOT SAFE: deploy [2J 7', 'control characters never reach the terminal');
});

test('status of a request a newer one replaced: unanswered rows are superseded', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}, {pid: 12, name: 'WEB', id: B}]);
    const pause = openPause(io);
    const old = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    pause.claim(A, old, 'rewake');
    pause.report({sessionId: A, requestId: old.id, verdict: 'SAFE'});
    io.tick(1000);
    pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions().filter((r) => r.session_id === B)});
    const st = pause.status(old);
    assert.deepEqual(st.rows.map((r) => r.state), ['safe', 'superseded']);
    assert.equal(st.summary.done, true);
});

test('a session that ended keeps its recorded name in the rows', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    fs.rmSync(path.join(io.procDir, '11'), {recursive: true});
    const [row] = pause.status().rows;
    assert.deepEqual([row.name, row.state, row.label], ['API', 'gone', 'not running']);
});

test('a checkpoint is pending until a resume, then again once rewritten', (t) => {
    const io = pauseWorld(t);
    const pause = openPause(io);
    assert.equal(pause.pendingCheckpoint(A), null);
    const cp = pause.checkpointPath(A);
    fs.mkdirSync(path.dirname(cp), {recursive: true});
    fs.writeFileSync(cp, '# checkpoint\n');
    const written = fs.statSync(cp).mtimeMs;
    io.nowMs = () => written - 1;
    assert.equal(pause.pendingCheckpoint(A), cp);
    io.nowMs = () => written + 1;
    pause.markResumed(A);
    assert.equal(pause.pendingCheckpoint(A), null);
    fs.utimesSync(cp, new Date(written + 5000), new Date(written + 5000));
    assert.equal(pause.pendingCheckpoint(A), cp);
    assert.equal(pause.pendingCheckpoint('../etc'), null);
});

test('a checkpoint the session worked past is no longer pending; nor is a too old one', (t) => {
    const io = pauseWorld(t);
    const pause = openPause(io);
    const cwd = path.join(io.home, 'repos', 'API');
    const cp = pause.checkpointPath(A);
    fs.mkdirSync(path.dirname(cp), {recursive: true});
    fs.writeFileSync(cp, '# checkpoint\n');
    const written = fs.statSync(cp).mtimeMs;
    io.nowMs = () => written + 1000;
    const tp = transcriptPath(projectsDir(io), cwd, A);
    fs.mkdirSync(path.dirname(tp), {recursive: true});
    fs.writeFileSync(tp, '{}\n');
    const at = (ms) => fs.utimesSync(tp, new Date(ms), new Date(ms));
    at(written + 60_000); // the protocol's own reply, a minute later
    assert.equal(pause.pendingCheckpoint(A, cwd), cp);
    assert.equal(pause.pendingCheckpoint(A), cp, 'found without the cwd too');
    at(written + 3_600_000); // the user carried on in that session an hour later
    assert.equal(pause.pendingCheckpoint(A, cwd), null);
    assert.equal(pause.pendingCheckpoint(A), null);
    assert.equal(pause.isPaused(A), false);
    at(written);
    io.nowMs = () => written + 15 * 86_400_000;
    assert.equal(pause.pendingCheckpoint(A, cwd), null, 'two weeks on, never replayed');
});

test('a delivered resume marks the checkpoint resumed', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const cp = pause.checkpointPath(A);
    fs.mkdirSync(path.dirname(cp), {recursive: true});
    fs.writeFileSync(cp, 'x');
    io.nowMs = () => fs.statSync(cp).mtimeMs + 1;
    const req = pause.sendRequest({kind: 'resume', rows: pause.tabs.liveSessions()});
    assert.equal(pause.claim(A, req, 'rewake'), true);
    assert.equal(pause.pendingCheckpoint(A), null);
    assert.match(pause.deliveryText(A, req, 'rewake'), /Your checkpoint: .*checkpoints\/aaaa1111/);
});

test('deliveryText points the report at this checkout\'s claudectl with node, by absolute path', (t) => {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}]);
    const pause = openPause(io);
    const req = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions()});
    const text = pause.deliveryText(A, req, 'pretooluse');
    const cli = path.join(here, '..', 'claude-code', 'claudectl.js');
    assert.ok(text.includes(`'${process.execPath}' '${path.resolve(cli)}' session report --session ${A} --request ${req.id} --verdict SAFE`));
    assert.ok(text.includes(path.join(pauseDir(io), `${A}.verdict.json`)));
});
