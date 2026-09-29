// Dev-cache reclaim, the I/O half: measure the catalog, and - only when asked
// - move an entry to the trash and write down that it happened. The catalog
// and every rule about what may be moved are in reclaim-contract.js.
//
// The one hard rule: nothing here unlinks anything. An entry is MOVED into the
// desktop's trash, where the desktop's own "put back" undoes it. On Linux that
// is the freedesktop trash spec (a file in ~/.local/share/Trash/files and a
// .trashinfo beside it recording where it came from); on macOS it is ~/.Trash.
// A cross-filesystem move falls back to a copy-then-remove, which is still a
// move to the trash and never a delete in place.
//
// The second hard rule: scanning never writes. `scan()` is a stat walk and
// nothing else, so a panel can show the numbers on every visit without ever
// having decided anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {formatBytes, reclaimCatalog, reclaimPlan} from './reclaim-contract.js';
import {claudeDir, codexHome, stateDir} from './paths.js';

/** What was moved, and when. Append-only, under the panel's state dir. */
const LOG_FILE = 'reclaim.log.jsonl';

/** Recursive size of a directory or file; null when it is not there. Symlinks
 *  are counted as their own (tiny) size and never followed, so a link into
 *  somewhere huge cannot make a cache look enormous - or be moved as one. */
function sizeOf(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(target, {withFileTypes: true});
  } catch {
    return total;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const n = sizeOf(child);
    if (n !== null) total += n;
  }
  return total;
}

/** `name`, `name.2`, `name.3` … - a free name inside `dir`. */
function freeName(dir, name) {
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${name}.${n}`;
  return candidate;
}

/**
 * Bind reclaim to one environment. `io` overrides, all optional: homedir, env,
 * platform, nowMs, trashDir. Defaults are the real process - the same shape
 * every other store here takes.
 */
export function openReclaim(io = {}) {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const home = io.homedir ?? os.homedir();
  const now = () => io.nowMs ?? Date.now();

  const dirs = {
    home,
    claudeHome: claudeDir(io),
    codexHome: codexHome(io),
    xdgCache: env.XDG_CACHE_HOME || path.join(home, '.cache'),
    xdgConfig: env.XDG_CONFIG_HOME || path.join(home, '.config'),
  };
  const catalog = reclaimCatalog(dirs, platform);
  const logPath = path.join(stateDir(io), LOG_FILE);

  /**
   * The trash directory an entry would move into. macOS has exactly one;
   * Linux follows the freedesktop spec's home trash. Both are created on
   * demand - only by a move, never by a scan.
   */
  function trashDir() {
    if (io.trashDir) return io.trashDir;
    if (platform === 'darwin') return path.join(home, '.Trash');
    return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Trash');
  }

  /** The catalog with a size on every entry. Read-only: no directory is
   *  created, nothing is written, nothing is removed. */
  function scan() {
    return catalog.map((entry) => {
      const bytes = sizeOf(entry.path);
      return {...entry, bytes, exists: bytes !== null, human: formatBytes(bytes ?? 0)};
    });
  }

  /** What a run WOULD do, from a fresh scan. This is what a UI shows before
   *  anything is offered, and what `--dry-run` prints. */
  function plan(ids = null, opts = {}) {
    return {...reclaimPlan(scan(), ids, opts), scanned: scan()};
  }

  // Move, never unlink. rename() when the trash is on the same filesystem;
  // otherwise copy the tree over and remove the original - still a move into
  // the trash, and the original only goes once the copy is complete.
  function moveToTrash(target) {
    const root = trashDir();
    const files = platform === 'darwin' ? root : path.join(root, 'files');
    fs.mkdirSync(files, {recursive: true});
    const name = freeName(files, path.basename(target));
    const destination = path.join(files, name);
    try {
      fs.renameSync(target, destination);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(target, destination, {recursive: true, force: false, errorOnExist: true});
      fs.rmSync(target, {recursive: true, force: true});
    }
    // The freedesktop spec's half of the move: without this record the file is
    // in the trash but the desktop cannot put it back where it came from.
    if (platform !== 'darwin') {
      const info = path.join(root, 'info');
      fs.mkdirSync(info, {recursive: true});
      const stamp = new Date(now()).toISOString().replace(/\.\d+Z$/, '');
      fs.writeFileSync(path.join(info, `${name}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(target)}\nDeletionDate=${stamp}\n`);
    }
    return destination;
  }

  /**
   * Move the chosen entries to the trash. Refuses to do anything at all
   * without `confirm: true` - the caller has to have shown the plan and been
   * answered, and a missing flag is a programming mistake, not a default.
   *
   * @returns {{moved: Array<{id, path, bytes, trashedTo}>, failed: Array<{id, error}>,
   *            refused: Array<object>, freedBytes: number}}
   */
  function reclaim(ids = null, {confirm = false, includeHistory = false} = {}) {
    if (confirm !== true) {
      throw new Error('reclaim needs an explicit confirmation - show the plan first');
    }
    const {targets, refused} = reclaimPlan(scan(), ids, {includeHistory});
    const moved = [];
    const failed = [];
    for (const entry of targets) {
      try {
        moved.push({
          id: entry.id, path: entry.path, bytes: entry.bytes,
          trashedTo: moveToTrash(entry.path),
        });
      } catch (e) {
        // One unwritable cache must not stop the rest.
        failed.push({id: entry.id, error: e.message});
      }
    }
    const result = {moved, failed, refused, freedBytes: moved.reduce((n, m) => n + m.bytes, 0)};
    if (moved.length) appendLog(result);
    return result;
  }

  // What was moved, where it went, and when - so "where did my transcripts
  // go?" has an answer that does not depend on remembering.
  function appendLog({moved, freedBytes}) {
    const line = JSON.stringify({
      at: new Date(now()).toISOString(),
      freedBytes,
      moved: moved.map(({id, path: from, bytes, trashedTo}) => ({id, from, bytes, trashedTo})),
    });
    try {
      fs.mkdirSync(path.dirname(logPath), {recursive: true, mode: 0o700});
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // A state dir we cannot write is not a reason to have not moved anything
    }
  }

  /** Every run so far, oldest first. */
  function readLog() {
    let text;
    try {
      text = fs.readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  return {catalog, logPath, trashDir, scan, plan, reclaim, readLog};
}
