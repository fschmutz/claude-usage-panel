// `claudectl session send | inbox | peers`: the mailbox (mail.js), its
// delivery by the pause waiter, and its reach into the config dirs
// `claudectl account exec` makes. Everything runs in a throwaway HOME with a
// fake /proc; nothing touches the real state dir or a running Claude process.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {EXEC_PREFIX} from '../claude-code/account-exec.js';
import {MAIL_TEXT_MAX, cleanMailText, mailDeliveryText, openMail} from '../claude-code/mail.js';
import {runMail} from '../claude-code/mail-cli.js';
import {startWaiter} from '../claude-code/pause-hook.js';
import {WAITER_REV, openPause} from '../claude-code/pause.js';
import {mailDir} from '../claude-code/paths.js';
import {A, B, pauseWorld} from './pause-world.js';

const C = 'cccc3333-0000-4000-8000-000000000003';
const modeOf = (p) => fs.statSync(p).mode & 0o777;

/** A world with live session A (API) and an exec dir running C as PERSO. */
function world(t, {exec = true} = {}) {
    const io = pauseWorld(t, [{pid: 11, name: 'API', id: A}, {pid: 12, name: 'WEB', id: B}]);
    if (exec) {
        const dir = path.join(io.tmpdir, `${EXEC_PREFIX}99-abc123`);
        fs.mkdirSync(path.join(dir, 'sessions'), {recursive: true});
        fs.writeFileSync(path.join(dir, '.exec-profile'), 'PERSO\n');
        fs.writeFileSync(path.join(dir, 'sessions', '13.json'), JSON.stringify({
            pid: 13, sessionId: C, cwd: io.home, name: 'SIDE', kind: 'interactive', procStart: '130', startedAt: 13,
        }));
        const proc = path.join(io.procDir, '13');
        fs.mkdirSync(proc, {recursive: true});
        const fields = Array.from({length: 50}, (_, i) => (i === 19 ? '130' : '0'));
        fs.writeFileSync(path.join(proc, 'stat'), `13 (claude) ${fields.join(' ')}`);
        fs.writeFileSync(path.join(proc, 'status'), 'Name:\tclaude\nPPid:\t1\n');
        io.execDir = dir;
    }
    return io;
}

const capture = () => {
    const lines = [];
    return {out: (s) => lines.push(s), text: () => lines.join('')};
};

test('mail: a message is queued 0600 in a 0700 box and taken exactly once', (t) => {
    const io = world(t);
    const mail = openMail(io);
    const m = mail.send(B, '  hello\r\nthere  ', {sessionId: A, name: 'API', account: null});
    assert.equal(m.text, 'hello\nthere');
    const file = path.join(mailDir(io), B, `${m.id}.json`);
    assert.equal(modeOf(file), 0o600);
    assert.equal(modeOf(path.join(mailDir(io), B)), 0o700);
    assert.deepEqual(mail.pending(B).map((x) => x.id), [m.id]);
    assert.deepEqual(mail.take(B).map((x) => x.id), [m.id]);
    assert.deepEqual(mail.take(B), [], 'a second taker gets nothing');
    assert.deepEqual(mail.pending(B), []);
    assert.ok(fs.existsSync(path.join(mailDir(io), B, 'delivered', `${m.id}.json`)));
});

test('mail: empty, oversized text and a bad recipient id are refused', (t) => {
    const mail = openMail(world(t));
    assert.throws(() => cleanMailText('   '), /nothing to send/);
    assert.throws(() => cleanMailText('x'.repeat(MAIL_TEXT_MAX + 1)), /over 16384 bytes/);
    assert.throws(() => mail.send('../etc', 'x'), /not a session id/);
});

test('mail: peers spans the live registry and every account exec dir, with each login', (t) => {
    const io = world(t);
    const rows = openMail(io).peers();
    assert.deepEqual(rows.map((r) => [r.session_id, r.name, r.configDir]), [
        [A, 'API', null], [B, 'WEB', null], [C, 'SIDE', io.execDir],
    ]);
    assert.equal(rows[2].account, 'PERSO');
});

test('mail: inside an exec session the sender is that session, under its login', (t) => {
    const io = world(t);
    const inside = openMail({...io, env: {...io.env, CLAUDE_CONFIG_DIR: io.execDir, CLAUDE_CODE_SESSION_ID: C}});
    assert.deepEqual(inside.sender(), {sessionId: C, name: 'SIDE', account: 'PERSO'});
    assert.equal(inside.peers().length, 3, 'an exec session still sees the live login\'s sessions');
});

test('mail: the delivery text names the sender, the reply and that it is not the user', () => {
    const text = mailDeliveryText([{at: 0, text: 'ping', from: {sessionId: A, name: 'API', account: 'PRO'}}],
        {claudectl: 'claudectl'});
    assert.match(text, /^Message from API as PRO \(session aaaa1111/);
    assert.match(text, new RegExp(`Reply: claudectl session send ${A} -- "<text>"`));
    assert.match(text, /not from the user/);
});

test('mail: the pause waiter wakes its session with the message, once; a pause request goes first', async (t) => {
    const io = world(t);
    io.nowMs = () => Date.now();
    io.pid = process.pid;
    const mail = openMail(io);
    const w = startWaiter({session_id: C, hook_event_name: 'Stop'}, {...io, pollMs: 50, maxMs: 10_000});
    await new Promise((r) => setTimeout(r, 100));
    mail.send(C, 'from the panel session', {sessionId: A, name: 'API', account: 'PRO'});
    const {code, text} = await w.done;
    assert.equal(code, 2);
    assert.match(text, /Message from API as PRO/);
    assert.match(text, /from the panel session/);
    assert.equal((await startWaiter({session_id: C}, {...io, pollMs: 20, maxMs: 150}).done).code, 0, 'delivered once');

    mail.send(A, 'later');
    const pause = openPause(io);
    pause.sendRequest({kind: 'pause', rows: pause.registry.liveSessions().filter((r) => r.session_id === A)});
    const first = await startWaiter({session_id: A}, {...io, pollMs: 20, maxMs: 2000}).done;
    assert.match(first.text, /PAUSE PROTOCOL/);
    const second = await startWaiter({session_id: A}, {...io, pollMs: 20, maxMs: 2000}).done;
    assert.match(second.text, /later/);
});

test('mail CLI: send resolves a name across logins and keeps everything after -- as text', async (t) => {
    const io = world(t);
    const c = capture();
    assert.equal(await runMail('send', ['SIDE', '--', 'run', '--help', 'now'], {...io, stdout: c.out}), 0);
    assert.match(c.text(), /queued for SIDE \(PERSO\): no live waiter/);
    assert.equal(openMail(io).pending(C)[0].text, 'run --help now');
    await assert.rejects(runMail('send', ['SIDE', 'no-separator'], io), /usage: claudectl session send/);
    await assert.rejects(runMail('send', ['NOPE', '--', 'x'], io), /no running session named NOPE/);
});

test('mail CLI: peers and inbox list what they should', async (t) => {
    const io = world(t);
    openMail(io).send(B, 'one\nline', {sessionId: A, name: 'API'});
    const p = capture();
    await runMail('peers', [], {...io, stdout: p.out, env: {...io.env, CLAUDE_CODE_SESSION_ID: A}});
    assert.match(p.text(), /^1\* +API/m);
    assert.match(p.text(), /^3 +SIDE +PERSO/m);
    const i = capture();
    await runMail('inbox', ['--all'], {...io, stdout: i.out});
    assert.match(i.text(), new RegExp(`${B} from API: one line`));
    await assert.rejects(runMail('inbox', [], {...io, env: {}}), /needs a session ID/);
});

test('waiter: a live waiter of an older revision is asked to leave and replaced; a current one is kept', async (t) => {
    const io = world(t);
    // a stand-in for an old waiter: our own child, which leaves on SIGTERM
    const {spawn} = await import('node:child_process');
    const child = spawn(process.execPath,
        ['-e', 'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1e3)'],
        {stdio: ['ignore', 'pipe', 'ignore']});
    t.after(() => child.kill('SIGKILL'));
    await new Promise((r) => child.stdout.once('data', r));
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({code, sig})));
    const proc = path.join(io.procDir, String(child.pid));
    fs.mkdirSync(proc, {recursive: true});
    const fields = Array.from({length: 50}, (_, i) => (i === 19 ? '777' : '0'));
    fs.writeFileSync(path.join(proc, 'stat'), `${child.pid} (node) ${fields.join(' ')}`);
    const pause = openPause(io);
    const lockFile = path.join(pause.dir(), `${C}.waiter`);
    fs.mkdirSync(pause.dir(), {recursive: true});
    fs.writeFileSync(lockFile, JSON.stringify({pid: child.pid, at: 0, procStart: '777', token: 'old'}));

    const release = pause.acquireWaiter(C, process.pid);
    assert.ok(release, 'the new waiter holds the lock');
    assert.deepEqual(await exited, {code: 0, sig: null}, 'the old waiter was asked to leave');
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).rev, WAITER_REV);
    assert.equal(pause.acquireWaiter(C, 777_777), null, 'a waiter of the current revision is not replaced');
    release();
});
