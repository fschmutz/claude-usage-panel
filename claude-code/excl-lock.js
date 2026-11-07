// The one lock-file mutex of the Node port: the Awake hold (.hold.lock, which
// scripts/awake-backstop.sh takes too), the per-login refresh lock, the pause
// delivery claim and the pause waiter lock. Every one used to carry its own
// copy, and the copies disagreed on the two things that make a lock a lock:
//
//   - Ownership. A holder writes a body nobody else writes (a random token in
//     it) and removes the lock only while that exact body is still there, so
//     a holder that overran its stale window never removes the lock of the
//     caller that took over from it.
//   - Takeover. A stale lock (crashed holder) is removed only under a
//     second, short-lived O_EXCL guard (`<lock>.takeover`): holding it, the
//     taker re-reads the lock and removes it only if it is still exactly the
//     one it judged (same inode, same mtime, same body). Takeovers are thus
//     one at a time, and a lock created since the judgement is never touched.
//     Removing in place without the guard let two takers both delete, then
//     both create; moving it aside and linking a mistaken move back still
//     left a window where a third caller's create made the link-back fail:
//     two holders either way.
//
// The body is created complete: written to a private tmp, then hard-linked
// into place (link(2) fails with EEXIST like O_EXCL), so a waiter never
// judges a half-written lock. A filesystem without hard links falls back to
// O_EXCL create + write.

import fs from 'node:fs';
import {randomBytes} from 'node:crypto';

import {TAKEOVER_STALE_MS} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accountStore.js';

/** A fresh owner token: unique per acquisition, not just per process. */
function lockToken() {
  return randomBytes(8).toString('hex');
}

/** The lock as a caller judged it: {text, ino, mtimeMs}, or null once it
 *  is gone. */
export function lockSnapshot(file) {
  try {
    const st = fs.statSync(file);
    return {text: fs.readFileSync(file, 'utf8'), ino: st.ino, mtimeMs: st.mtimeMs};
  } catch {
    return null;
  }
}

// A takeover guard older than TAKEOVER_STALE_MS was left by a crashed taker:
// one constant for every port (the pure account store owns it), and the
// window scripts/awake-backstop.sh uses (`find -mmin +1`).
export {TAKEOVER_STALE_MS};

/**
 * Take over a lock judged stale from `judged` (its lockSnapshot at that
 * moment): true when this call removed exactly that lock. False when
 * another takeover holds the guard (a guard left by a crash is cleared for
 * the next round) or the lock changed since it was judged. Either way the
 * caller retries its exclusive create, which only one can win.
 */
export function takeOverStale(file, judged) {
  const guard = `${file}.takeover`;
  let fd;
  try {
    fd = fs.openSync(guard, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > TAKEOVER_STALE_MS) fs.rmSync(guard, {force: true});
    } catch {
      // gone meanwhile: the next round takes it
    }
    return false;
  }
  fs.closeSync(fd);
  try {
    const now = lockSnapshot(file);
    const same = Boolean(now && now.ino === judged.ino && now.mtimeMs === judged.mtimeMs &&
      (judged.text === undefined || now.text === judged.text));
    if (same) fs.rmSync(file, {force: true});
    return same;
  } finally {
    fs.rmSync(guard, {force: true});
  }
}

function createExclusive(file, text, mode) {
  const tmp = `${file}.${process.pid}-${lockToken()}.new`;
  try {
    fs.writeFileSync(tmp, text, {mode, flag: 'wx'});
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    if (e.code !== 'EPERM' && e.code !== 'ENOTSUP' && e.code !== 'EOPNOTSUPP') throw e;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
  // no hard links here: O_EXCL create, then the body
  let fd;
  try {
    fd = fs.openSync(file, 'wx', mode);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * One attempt at the lock (a stale holder taken over on the way): the held
 * lock {file, text}, or null while a live holder has it.
 *
 *   body(token)  the lock's content; must embed the token (default: the pid
 *                on the first line, the token on the second - the shape the
 *                awake backstop reads)
 *   stale(snap)  true when the holder seen in `snap` is gone (crashed, dead
 *                pid, past its stale window)
 */
export function tryLock(file, {body = defaultBody, stale = () => false, mode = 0o600, attempts = 4} = {}) {
  const text = body(lockToken());
  for (let i = 0; i < attempts; i++) {
    if (createExclusive(file, text, mode)) return {file, text};
    const judged = lockSnapshot(file);
    if (!judged) continue; // released between the two calls: try again at once
    if (!stale(judged)) return null;
    takeOverStale(file, judged);
  }
  return null;
}

/** Remove the lock only while it is still ours. True when it was. */
export function releaseLock(lock) {
  if (!lock) return false;
  try {
    if (fs.readFileSync(lock.file, 'utf8') !== lock.text) return false;
    fs.rmSync(lock.file, {force: true});
    return true;
  } catch {
    return false; // already gone
  }
}

/** Poll tryLock until it holds or `waitMs` (wall clock) has passed: the
 *  lock, or null. Blocking: for short-lived single-purpose processes. */
export function waitLockSync(file, opts = {}, {waitMs = 5_000, pollMs = 50} = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = tryLock(file, opts);
    if (lock || Date.now() >= deadline) return lock;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

function defaultBody(token) {
  return `${process.pid}\n${token}\n`;
}

/** A lock judged stale by age alone: untouched for more than `ms`. */
export const olderThan = (ms) => (snap) => Date.now() - snap.mtimeMs > ms;
