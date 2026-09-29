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
 * Atomic, private write: a tmp file in the same directory, 0600, renamed over
 * `file`. The rename swaps the inode, so the result is 0600 even when the file
 * it replaces was not. The explicit chmod covers a tmp left behind by an
 * earlier process with the same pid, whose mode `writeFileSync` would keep.
 */
export function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, {mode: 0o600});
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
