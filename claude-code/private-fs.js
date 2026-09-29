// The two file primitives every credential store in the Node port needs: read
// a JSON file without throwing, and write one atomically with owner-only
// permissions. One copy, so a hardening lands in every store at once.

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
 * Atomic, private write: a tmp file in the same directory, renamed over
 * `file`. The tmp is CREATED 0600 (O_CREAT|O_EXCL, flag 'wx'), so the secret
 * never sits in a wider-moded file, not even for an instant, and a tmp path
 * someone else pre-created (or a symlink planted there) fails the write
 * instead of receiving it. A stale tmp from an earlier process with the same
 * pid is removed first. The rename swaps the inode, so the result is 0600
 * even when the file it replaces was not.
 */
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, {force: true});
  fs.writeFileSync(tmp, text, {mode: 0o600, flag: 'wx'});
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, {force: true});
    throw e;
  }
}
