// The file primitives every store in the Node port needs: read a JSON file
// without throwing, and write one atomically. One copy, so a hardening lands
// in every writer at once: the credential stores, the shared scratch files
// (pace history, token cache, session index), the tab snapshots and the
// install scripts' settings.json edits (scripts/lib/json-file.mjs).

import fs from 'node:fs';
import path from 'node:path';

/** The parsed JSON in `file`, or null when it is missing or not JSON. */
export function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic write: a tmp file in the same directory, renamed over `file`, so a
 * reader sees the old content or the new one and never half of either (a
 * torn read of a shared file is a lost file: its readers start over empty
 * and their next write erases everyone else's entries).
 *
 * The tmp is CREATED with `mode` (O_CREAT|O_EXCL, flag 'wx'), so the content
 * never sits in a wider-moded file, not even for an instant, and a tmp path
 * someone else pre-created (or a symlink planted there) fails the write
 * instead of receiving it. A stale tmp from an earlier process with the same
 * pid is removed first, and the tmp never outlives a failed write. The mode
 * is set again on the open descriptor, because the umask narrows the create
 * mode. The rename swaps the inode, so the result has `mode` even when the
 * file it replaces did not.
 *
 * `keepMode`: an existing file keeps the mode it had (a settings.json made
 * 0644 on purpose stays 0644); `mode` is then only the mode of a new file.
 * Missing parent directories are created with `dirMode`.
 */
export function writeAtomic(file, text, {mode = 0o600, keepMode = false, dirMode = 0o700} = {}) {
  let finalMode = mode;
  if (keepMode) {
    try {
      finalMode = fs.statSync(file).mode & 0o777;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: dirMode});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, {force: true});
  try {
    const fd = fs.openSync(tmp, 'wx', finalMode);
    try {
      fs.fchmodSync(fd, finalMode);
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, {force: true});
    throw e;
  }
}

/** Atomic, owner-only write (0600 file, 0700 directory): every credential
 *  and state file of the Node port. */
export function writePrivate(file, text) {
  writeAtomic(file, text, {mode: 0o600});
}
