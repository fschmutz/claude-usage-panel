// `claudectl session pause | resume | report | pause-status` and the reopen
// prompt of a session paused with a checkpoint, against a throwaway HOME
// with a fake registry and /proc. No terminal is opened: launches are dry
// runs or go to a recording exec.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {main} from '../claude-code/session-cli.js';
import {openPause} from '../claude-code/pause.js';
import {pauseDir, tabsDir} from '../claude-code/paths.js';
import {transcriptPath} from '../claude-code/tabs.js';
import {A, B, pauseWorld} from './pause-world.js';

const SESSIONS = [{pid: 11, name: 'API', id: A}, {pid: 12, name: 'WEB', id: B}];

function cli(io) {
    let text = '';
    return {
        run: (...argv) => main(argv, {...io, stdout: (s) => (text += s)}),
        out: () => text,
        reset: () => (text = ''),
    };
}

const request = (io) => JSON.parse(fs.readFileSync(path.join(pauseDir(io), 'request.json'), 'utf8'));

test('pause --all --no-wait sends one request to every live session and prints the rows', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    assert.equal(await c.run('pause', '--all', '--no-wait'), 0);
    const req = request(io);
    assert.deepEqual([req.kind, req.from, req.targets], ['pause', 'cli', [A, B]]);
    assert.match(c.out(), new RegExp(`^pause ${req.id} sent to API, WEB\\n`));
    assert.match(c.out(), /0\/2 safe/);
    assert.match(c.out(), /API +aaaa1111 +no waiter yet/);
});

test('pause --all skips the session it runs from; --include-self keeps it', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    io.env = {...io.env, CLAUDE_PID: '11'};
    const c = cli(io);
    await c.run('pause', '--all', '--no-wait');
    assert.deepEqual(request(io).targets, [B]);
    await c.run('pause', '--all', '--no-wait', '--include-self');
    assert.deepEqual(request(io).targets, [A, B]);
});

test('pause --wait follows the rows and exits 0 when every session answers SAFE', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    let step = 0;
    io.sleep = async () => {
        const req = pause.readRequest();
        io.tick(1000);
        if (step++ === 0) pause.claim(A, req, 'rewake');
        else pause.report({sessionId: A, requestId: req.id, verdict: 'SAFE', checkpoint: pause.checkpointPath(A)});
    };
    const c = cli(io);
    assert.equal(await c.run('pause', 'API', '--wait=30'), 0);
    assert.match(c.out(), /API: no waiter yet[\s\S]*API: delivered \(woken\), working through the protocol[\s\S]*API: SAFE/);
    assert.match(c.out(), /1\/1 safe/);
});

test('pause --wait exits 3 on NOT SAFE, and on a timeout with the follow-up hint', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    io.sleep = async () => {
        io.tick(1000);
        const req = pause.readRequest();
        pause.claim(B, req, 'pretooluse');
        pause.report({sessionId: B, requestId: req.id, verdict: 'NOT_SAFE', reason: 'deploy 7'});
    };
    const c = cli(io);
    assert.equal(await c.run('pause', 'WEB'), 3);
    assert.match(c.out(), /WEB: NOT SAFE: deploy 7/);

    io.sleep = async () => io.tick(1000);
    c.reset();
    assert.equal(await c.run('pause', 'API', '--wait=3'), 3);
    assert.match(c.out(), /still open after 3s/);
});

test('pause --wait stops with exit 4 when a newer request replaces it', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    let step = 0;
    io.sleep = async () => {
        io.tick(1000);
        if (step++) return;
        // a panel click for WEB lands, is delivered and answered SAFE
        const newer = pause.sendRequest({kind: 'pause', rows: pause.tabs.liveSessions().filter((r) => r.pid === 12), from: 'gnome'});
        pause.claim(B, newer, 'rewake');
        pause.report({sessionId: B, requestId: newer.id, verdict: 'SAFE'});
    };
    const c = cli(io);
    assert.equal(await c.run('pause', 'WEB', '--wait=5'), 4);
    assert.match(c.out(), /superseded by pause [a-z0-9]+-[0-9a-f]{6} from gnome/);
    assert.match(c.out(), /WEB +bbbb2222 +superseded/);
    assert.doesNotMatch(c.out(), /still open after/);
});

test('--from is the panels\' internal flag: validated, and refused inside a Claude Code session', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    await c.run('pause', 'API', '--no-wait', '--from', 'macos');
    assert.equal(request(io).from, 'macos');
    await assert.rejects(c.run('pause', 'API', '--no-wait', '--from=gnone'), /--from takes cli, gnome, macos, not "gnone"/);
    await assert.rejects(c.run('pause', 'API', '--no-wait', '--from=session'), /--from takes/);
    io.env = {...io.env, CLAUDECODE: '1'};
    await assert.rejects(c.run('pause', '--all', '--no-wait', '--from=gnome'), /for the panels; this runs inside a Claude Code session/);
});

test('sent from inside a Claude Code session, the request says so and names it', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    io.env = {...io.env, CLAUDE_PID: '11'};
    await c.run('pause', '--all', '--no-wait');
    assert.deepEqual([request(io).from, request(io).origin], ['session', A]);
    io.env = {XDG_STATE_HOME: io.env.XDG_STATE_HOME, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: B};
    await c.run('pause', 'API', '--no-wait');
    assert.deepEqual([request(io).from, request(io).origin], ['session', B]);
    const pause = openPause(io);
    assert.match(pause.deliveryText(A, pause.readRequest(), 'rewake'), /not typed by the user/);
});

test('report --reason-file reads a reason with quotes, from a file or stdin, and cleans it', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    await c.run('pause', '--all', '--no-wait');
    const id = request(io).id;
    const f = path.join(io.home, 'reason.txt');
    fs.writeFileSync(f, "job 'nightly' can't stop yet\n");
    assert.equal(await c.run('report', '--session', A, '--request', id, '--verdict', 'NOT_SAFE', '--reason-file', f), 0);
    const read = (sid) => JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${sid}.verdict.json`), 'utf8'));
    assert.equal(read(A).reason, "job 'nightly' can't stop yet");
    io.readStdin = () => 'it\'s "deploy 7"\u001b]0;x\u0007';
    await c.run('report', '--session', B, '--request', id, '--verdict', 'NOT_SAFE', '--reason-file', '-');
    assert.equal(read(B).reason, 'it\'s "deploy 7" ]0;x ');
    await c.run('report', '--session', B, '--request', id, '--verdict', 'NOT_SAFE', '--reason', `x${'y'.repeat(400)}`);
    assert.equal([...read(B).reason].length, 300);
});

test('pause --json is the structured status; names resolve by pid, id prefix or name', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    assert.equal(await c.run('pause', '12', 'aaaa1111', '--no-wait', '--json'), 0);
    const st = JSON.parse(c.out());
    assert.deepEqual(st.rows.map((r) => r.name).sort(), ['API', 'WEB']);
    assert.equal(st.summary.label, '0/2 safe');
    await assert.rejects(c.run('pause', 'NOPE', '--no-wait'), /no running session named NOPE/);
    await assert.rejects(c.run('pause', '--no-wait'), /\(NAME\.\.\.\) or pass --all/);
    await assert.rejects(c.run('pause', 'API', '--wait=soon'), /whole seconds/);
});

test('report takes spaced values, falls back to CLAUDE_CODE_SESSION_ID, and flags an older request', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    await c.run('pause', '--all', '--no-wait');
    const id = request(io).id;
    c.reset();
    assert.equal(await c.run('report', '--session', A, '--request', id, '--verdict', 'NOT SAFE',
        '--reason', 'CI run 42 still running', '--checkpoint', '/cp.md'), 0);
    const v = JSON.parse(fs.readFileSync(path.join(pauseDir(io), `${A}.verdict.json`), 'utf8'));
    assert.deepEqual([v.verdict, v.reason, v.checkpoint, v.requestId], ['NOT_SAFE', 'CI run 42 still running', '/cp.md', id]);
    assert.match(c.out(), /recorded NOT_SAFE for aaaa1111/);

    io.env = {...io.env, CLAUDE_CODE_SESSION_ID: B};
    c.reset();
    assert.equal(await c.run('report', '--request=old-1', '--verdict=SAFE'), 0);
    assert.match(c.out(), /recorded SAFE for bbbb2222[\s\S]*this verdict answers an older one/);

    io.env = {XDG_STATE_HOME: io.env.XDG_STATE_HOME};
    await assert.rejects(c.run('report', '--request', id, '--verdict', 'SAFE'), /no session id/);
    await assert.rejects(c.run('report', '--session', A, '--verdict', 'SAFE'), /--request/);
});

test('pause-status: nothing yet, then the rows; --json', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    assert.equal(await c.run('pause-status'), 0);
    assert.match(c.out(), /no pause request yet/);
    await c.run('pause', '--all', '--no-wait');
    c.reset();
    await c.run('pause-status', '--json');
    assert.equal(JSON.parse(c.out()).rows.length, 2);
});

/** A checkpoint written now (and a transcript, so the session can be reopened). */
function checkpointed(io, pause, sid, name) {
    const cp = pause.checkpointPath(sid);
    fs.mkdirSync(path.dirname(cp), {recursive: true});
    fs.writeFileSync(cp, '# checkpoint\n');
    fs.mkdirSync(path.join(io.home, 'repos', name), {recursive: true});
    const tp = transcriptPath(path.join(io.home, '.claude', 'projects'), path.join(io.home, 'repos', name), sid);
    fs.mkdirSync(path.dirname(tp), {recursive: true});
    fs.writeFileSync(tp, '{}\n');
    return cp;
}

test('resume: a running session gets a resume request, a closed one is reopened with its checkpoint', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    const c = cli(io);
    await c.run('pause', '--all', '--no-wait');
    const cp = checkpointed(io, pause, B, 'WEB');
    io.nowMs = () => fs.statSync(cp).mtimeMs - 1; // the checkpoint is newer than any resume
    pause.report({sessionId: A, requestId: request(io).id, verdict: 'SAFE'}); // API paused, still open
    fs.rmSync(path.join(io.procDir, '12'), {recursive: true}); // WEB was closed after its pause
    c.reset();
    assert.equal(await c.run('resume', '--all', '--dry-run', '--terminal=tmux'), 0);
    assert.match(c.out(), /reopen WEB bbbb2222 with its checkpoint/);
    assert.match(c.out(), /this session was paused at/);
    assert.match(c.out(), /would send resume to API aaaa1111/, 'the dry run names the running targets too');
    assert.match(c.out(), /RESUME PROTOCOL/);
    assert.ok(c.out().includes(cp), 'the checkpoint path is in the prompt');
    assert.equal(request(io).kind, 'pause', 'a dry run sends nothing');
    assert.equal(pause.pendingCheckpoint(B), cp, 'and marks nothing resumed');

    const ran = [];
    io.exec = (cmd, args) => ran.push([cmd, ...args]);
    io.nowMs = () => fs.statSync(cp).mtimeMs + 1;
    c.reset();
    assert.equal(await c.run('resume', '--all', '--no-wait', '--terminal=tmux'), 0);
    assert.ok(ran.some((a) => a.join(' ').includes('RESUME PROTOCOL')));
    assert.equal(pause.pendingCheckpoint(B), null, 'reopened: no longer owed a resume');
    const req = request(io);
    assert.deepEqual([req.kind, req.targets], ['resume', [A]]);

    // delivered: a second Resume all has nothing left to do
    pause.claim(A, req, 'rewake');
    io.tick(1000);
    await assert.rejects(c.run('resume', '--all', '--no-wait', '--terminal=tmux'), /nothing to resume/);
});

test('pause all, then pause one, then resume all: every paused session comes back', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    const c = cli(io);
    await c.run('pause', '--all', '--no-wait');
    const all = request(io);
    pause.claim(A, all, 'rewake');
    pause.report({sessionId: A, requestId: all.id, verdict: 'SAFE'});
    io.tick(1000);
    await c.run('pause', 'WEB', '--no-wait'); // a per-row Pause replaces the Pause all request
    const one = request(io);
    pause.claim(B, one, 'pretooluse');
    pause.report({sessionId: B, requestId: one.id, verdict: 'SAFE'});
    io.tick(1000);
    assert.equal(await c.run('resume', '--all', '--no-wait'), 0);
    assert.deepEqual(request(io).targets.sort(), [A, B].sort(), 'A, paused by the older request, too');
    c.reset();
    assert.equal(await c.run('resume', 'API', '--no-wait'), 0, 'and by name');
});

test('resume reopens a closed session with the time of ITS pause, not of the last request', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const pause = openPause(io);
    const c = cli(io);
    const base = Date.now();
    io.nowMs = () => base;
    await c.run('pause', 'WEB', '--no-wait');
    const cp = checkpointed(io, pause, B, 'WEB');
    const pausedMs = fs.statSync(cp).mtimeMs;
    io.nowMs = () => pausedMs + 2 * 3_600_000;
    await c.run('pause', 'API', '--no-wait'); // a later, unrelated request
    fs.rmSync(path.join(io.procDir, '12'), {recursive: true});
    c.reset();
    await c.run('resume', 'WEB', '--dry-run', '--terminal=tmux');
    const clock = (ms) => new Date(ms).toTimeString().slice(0, 5);
    assert.match(c.out(), new RegExp(`paused at ${clock(pausedMs)} \\((1h59m|2h)`), 'not the API request two hours later');
});

test('resume skips a closed session without a checkpoint', async (t) => {
    const io = pauseWorld(t, SESSIONS);
    const c = cli(io);
    const pause = openPause(io);
    await c.run('pause', '--all', '--no-wait');
    pause.report({sessionId: B, requestId: request(io).id, verdict: 'SAFE'}); // answered, wrote no checkpoint
    fs.rmSync(path.join(io.procDir, '12'), {recursive: true});
    c.reset();
    assert.equal(await c.run('resume', 'WEB', 'API', '--no-wait'), 0);
    assert.match(c.out(), /skip bbbb2222: not running and no pending checkpoint/);
    await assert.rejects(c.run('resume', 'NOPE'), /no running or paused session named NOPE/);
});

test('session open: a session paused with a checkpoint gets the resume protocol, the others the usual prompt', async (t) => {
    const io = pauseWorld(t, []);
    const pause = openPause(io);
    const cp = checkpointed(io, pause, A, 'API');
    checkpointed(io, pause, B, 'WEB');
    fs.rmSync(pause.checkpointPath(B));
    io.nowMs = () => fs.statSync(cp).mtimeMs + 60_000;
    fs.mkdirSync(tabsDir(io), {recursive: true});
    fs.writeFileSync(path.join(tabsDir(io), 'snap.json'), JSON.stringify({version: 1, savedAt: io.nowMs() - 120_000, sessions: [
        {name: 'API', cwd: path.join(io.home, 'repos', 'API'), session_id: A},
        {name: 'WEB', cwd: path.join(io.home, 'repos', 'WEB'), session_id: B},
    ]}));
    const c = cli(io);
    assert.equal(await c.run('open', 'snap', '--dry-run', '--terminal=tmux'), 0);
    const [api, web] = c.out().split('\n').filter((l) => l.startsWith('tmux '));
    assert.match(api, /saved in snapshot snap[\s\S]*RESUME PROTOCOL/);
    assert.ok(api.includes(cp));
    assert.doesNotMatch(web, /RESUME PROTOCOL/);
    assert.match(web, /1\. Re-read the end of this conversation/);

    c.reset();
    await c.run('open', 'snap', '--dry-run', '--terminal=tmux', '--prompt=hello');
    assert.doesNotMatch(c.out(), /RESUME PROTOCOL/, '--prompt wins');

    io.exec = () => '';
    await c.run('open', 'snap', '--terminal=tmux');
    assert.equal(pause.pendingCheckpoint(A), null, 'opened with it: resumed');
});
