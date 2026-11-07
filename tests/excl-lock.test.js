// claude-code/excl-lock.js - the one lock-file mutex behind the Awake hold,
// the refresh lock, the pause claim and the pause waiter - plus a real race
// of separate processes over a stale Awake lock: exactly one holder at a time.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {
    lockSnapshot, olderThan, releaseLock, TAKEOVER_STALE_MS, takeOverStale, tryLock, waitLockSync,
} from '../claude-code/excl-lock.js';
import {awakeDir} from '../claude-code/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function tmpDir(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-excl-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    return d;
}

test('tryLock is exclusive, 0600, and its body names the pid then the token', (t) => {
    const f = path.join(tmpDir(t), '.x.lock');
    const a = tryLock(f);
    assert.ok(a);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    const [pid, token, rest] = fs.readFileSync(f, 'utf8').split('\n');
    assert.equal(pid, String(process.pid));
    assert.match(token, /^[0-9a-f]{16}$/);
    assert.equal(rest, '');
    assert.equal(tryLock(f), null, 'a live holder keeps it');
    assert.equal(releaseLock(a), true);
    assert.equal(fs.existsSync(f), false);
    assert.deepEqual(fs.readdirSync(path.dirname(f)), [], 'no tmp body left');
});

test('a release never removes a lock that is no longer ours', (t) => {
    const f = path.join(tmpDir(t), '.x.lock');
    const a = tryLock(f, {stale: () => false});
    fs.rmSync(f); // say it went stale and was taken over...
    const b = tryLock(f);
    assert.equal(releaseLock(a), false, 'the old holder leaves the new lock alone');
    assert.equal(lockSnapshot(f).text, b.text);
    assert.equal(releaseLock(b), true);
});

test('a stale lock is taken over; a live one is waited for, then given up on', (t) => {
    const f = path.join(tmpDir(t), '.x.lock');
    fs.writeFileSync(f, 'crashed\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(f, old, old);
    const a = tryLock(f, {stale: olderThan(30_000)});
    assert.ok(a, 'older than the window');
    const started = Date.now();
    assert.equal(waitLockSync(f, {stale: olderThan(30_000)}, {waitMs: 150, pollMs: 20}), null);
    assert.ok(Date.now() - started >= 150);
    releaseLock(a);
});

test('takeOverStale removes only the lock it judged; a lock created since is never touched', (t) => {
    const f = path.join(tmpDir(t), '.x.lock');
    fs.writeFileSync(f, 'crashed:1\n');
    const judged = lockSnapshot(f); // two callers judged THIS file stale
    assert.equal(takeOverStale(f, judged), true, 'the first one removes it');
    fs.writeFileSync(f, 'winner:2\n', {flag: 'wx'}); // and creates its own
    const ino = fs.statSync(f).ino;
    assert.equal(takeOverStale(f, judged), false, 'the second one finds a different lock');
    assert.equal(fs.readFileSync(f, 'utf8'), 'winner:2\n');
    assert.equal(fs.statSync(f).ino, ino, 'never moved, never recreated');
    fs.rmSync(f);
    assert.equal(takeOverStale(f, judged), false, 'nothing to remove');
    assert.deepEqual(fs.readdirSync(path.dirname(f)), [], 'no guard left behind');
});

test('takeOverStale goes one at a time: a held guard leaves the lock alone; a crashed guard is cleared', (t) => {
    const f = path.join(tmpDir(t), '.x.lock');
    fs.writeFileSync(f, 'crashed:1\n');
    const judged = lockSnapshot(f);
    const guard = `${f}.takeover`;
    fs.writeFileSync(guard, ''); // another taker is mid-takeover
    assert.equal(takeOverStale(f, judged), false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'crashed:1\n', 'untouched while the guard is held');
    assert.ok(fs.existsSync(guard), 'a live guard is not cleared');
    const old = new Date(Date.now() - TAKEOVER_STALE_MS - 1000);
    fs.utimesSync(guard, old, old); // its taker crashed
    assert.equal(takeOverStale(f, judged), false, 'this round only clears the guard');
    assert.equal(fs.existsSync(guard), false);
    assert.equal(takeOverStale(f, judged), true, 'the next round takes the lock over');
});

// The bug this module replaced: Awake removed a stale lock in place, so two
// waiters that both judged it stale both removed, both created, and two
// holders changed the machine at once. Six processes start together over a
// lock whose holder is dead; their critical sections must never overlap.
test('processes racing over a stale Awake lock hold it one at a time', async (t) => {
    const home = tmpDir(t);
    const io = {homedir: home, platform: 'linux', env: {XDG_STATE_HOME: path.join(home, 'state')}};
    const dir = awakeDir(io);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, '.hold.lock'), '999999\n'); // a dead holder
    const log = path.join(home, 'log');
    const mod = pathToFileURL(path.join(here, '..', 'claude-code', 'awake.js')).href;
    const script = `const {openAwake} = await import(${JSON.stringify(mod)});
        const fs = await import('node:fs');
        const io = JSON.parse(process.argv[1]);
        const go = Number(process.argv[2]); while (Date.now() < go) { /* start together */ }
        const r = openAwake(io).withLock(() => {
            fs.appendFileSync(${JSON.stringify(log)}, 'S' + process.pid + '\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
            fs.appendFileSync(${JSON.stringify(log)}, 'E' + process.pid + '\\n');
        });
        process.stdout.write(String(r.ok));`;
    const go = String(Date.now() + 400);
    const runs = Array.from({length: 6}, () => new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(io), go],
            {stdio: ['ignore', 'pipe', 'inherit']});
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('exit', () => resolve(out));
    }));
    const results = await Promise.all(runs);
    assert.deepEqual(results, Array(6).fill('true'), 'each one got its turn');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
    for (let i = 0; i < lines.length; i += 2) {
        assert.equal(lines[i][0], 'S', lines.join(' '));
        assert.equal(lines[i + 1], `E${lines[i].slice(1)}`, `overlap: ${lines.join(' ')}`);
    }
    assert.deepEqual(fs.readdirSync(dir), [], 'lock released, nothing moved aside left over');
});
