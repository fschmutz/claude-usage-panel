// Today's sessions and the last session ping for the MCP server.
// scripts/session-ping.sh writes its last successful ping under the state
// dir; the panels and the status line read the same file. The session index
// is likewise shared with the desktop clients - one machine, one set of
// transcripts, one incremental index - so whichever client runs keeps it warm
// for the others. The folding, ranking and resume rules are
// lib/pure/sessions.js, the one JavaScript copy GNOME's lib/sessionIndex.js
// uses too (tests/fixtures/sessions.json); this file is the Node I/O around it.

import fs from 'node:fs';
import {Buffer} from 'node:buffer';
import path from 'node:path';

import {formatLastPing, localDay, parseStamp} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pings.js';
import {
  foldSessionLine, indexMtime, newSessionAcc, pruneByDay, rankSessions, resumeCommand,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {lastPingPath, projectsDir, sessionIndexPath} from '../claude-code/paths.js';

const INDEX_VERSION = 1;
const SESSION_BUDGET_BYTES = 16 << 20; // per call: a cold index warms over a few
// A newline-less run this long is not a line (lib/sessionIndex.js CARRY_MAX):
// it is skipped, not re-read on every call with the offset stuck before it.
const CARRY_MAX = 1 << 20;
const SESSION_LIMIT = 5;

function readIndex(indexPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed?.version !== INDEX_VERSION || typeof parsed.files !== 'object') {
      return {version: INDEX_VERSION, files: {}};
    }
    return parsed;
  } catch {
    return {version: INDEX_VERSION, files: {}};
  }
}

// Transcripts touched in the last two days, the only ones that can carry tokens
// spent today.
function sessionCandidates(projectsDir, nowMs) {
  const cutoff = nowMs - 2 * 86_400_000;
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs >= cutoff) out.push({path: file, size: st.size, mtimeMs: indexMtime(st.mtimeMs)});
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out;
}

// Fold the appended tail of one transcript. Files are append-only, so this only
// ever reads the bytes added since the last call - which is what makes indexing
// hundreds of megabytes of transcripts affordable to repeat.
//
// The read window is cut at the last newline and the offset advances only that
// far: a window can end mid-line (and mid-UTF-8 sequence), and decoding that
// tail would both corrupt a character and risk folding a half-written turn.
// Whatever follows the last newline is simply read again next time.
function foldTail(file, entry, budget, nowMs) {
  const start = entry.offset ?? 0;
  if (file.size <= start) return 0;
  const want = Math.min(budget, file.size - start);
  let fd;
  try {
    fd = fs.openSync(file.path, 'r');
  } catch {
    return 0;
  }
  let consumed = 0;
  try {
    const buf = Buffer.allocUnsafe(want);
    const read = fs.readSync(fd, buf, 0, want, start);
    const lastNewline = buf.subarray(0, read).lastIndexOf(0x0a);
    if (lastNewline >= 0) {
      consumed = lastNewline + 1;
      const day = localDay(nowMs);
      for (const line of buf.subarray(0, consumed).toString('utf8').split('\n')) {
        foldSessionLine(line, entry, day);
      }
    } else if (read >= CARRY_MAX) {
      // No complete line, and the window is already past what a line can
      // be: consume it so the index moves on. The rest of that "line" then
      // fails to parse, like any fragment.
      consumed = read;
    }
  } catch {
    consumed = 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // best effort
    }
  }
  entry.offset = start + consumed;
  entry.byDay = pruneByDay(entry.byDay, nowMs);
  return consumed;
}

// Atomic, like the GNOME port's saveIndex: every client reads this file, and a
// torn read (or a crash mid-write) would hand them all an empty index to
// re-fold from scratch. The temp name carries the pid - several MCP servers
// can run at once.
function writeIndex(indexPath, index) {
  const tmp = `${indexPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(indexPath), {recursive: true, mode: 0o700});
    fs.writeFileSync(tmp, JSON.stringify(index), {mode: 0o600});
    fs.renameSync(tmp, indexPath);
  } catch {
    // A read-only cache dir means no cache, not a broken tool call.
    fs.rmSync(tmp, {force: true});
  }
}

/**
 * Update the shared session index and return today's sessions, biggest token
 * spender first. Never throws: a missing ~/.claude/projects just yields [].
 * `io` picks the home / env (see paths.js) and may override `projects`,
 * `indexPath`, `limit`, `budgetBytes` directly.
 */
export function refreshSessions(io = {}) {
  const nowMs = io.nowMs ?? Date.now();
  const limit = io.limit ?? SESSION_LIMIT;
  const indexPath = io.indexPath ?? sessionIndexPath(io);
  const index = readIndex(indexPath);
  const files = sessionCandidates(io.projects ?? projectsDir(io), nowMs);
  let budget = io.budgetBytes ?? SESSION_BUDGET_BYTES;
  let dirty = false;

  for (const file of files) {
    let entry = index.files[file.path];
    // Shrunk below what we already folded: the file was replaced, not appended
    // to. Start it over rather than folding from a stale offset.
    if (!entry || (entry.offset ?? 0) > file.size) {
      entry = Object.assign(newSessionAcc(), {offset: 0});
    }
    index.files[file.path] = entry;
    if (entry.size === file.size && entry.mtimeMs === file.mtimeMs) continue;
    if (budget <= 0) continue;
    budget -= foldTail(file, entry, budget, nowMs);
    dirty = true;
    if (entry.offset >= file.size) {
      entry.size = file.size;
      entry.mtimeMs = file.mtimeMs;
    }
  }

  const live = new Set(files.map((f) => f.path));
  for (const p of Object.keys(index.files)) {
    if (!live.has(p)) {
      delete index.files[p];
      dirty = true;
    }
  }
  if (dirty) writeIndex(indexPath, index);
  // The tool prints the command itself, so each row carries it.
  return rankSessions(Object.values(index.files), {nowMs, limit})
    .map((e) => ({...e, resumeCommand: resumeCommand(e)}));
}

/** The last scheduled ping, or null when pings were never set up. */
export function readLastPing(io = {}) {
  const nowMs = io.nowMs ?? Date.now();
  let raw;
  try {
    raw = fs.readFileSync(io.pingPath ?? lastPingPath(io), 'utf8').trim();
  } catch {
    return null;
  }
  const at = parseStamp(raw);
  if (at === null) return null;
  return {at: new Date(at).toISOString(), label: formatLastPing(raw, nowMs)};
}

export function renderPing(lastPing) {
  return lastPing ? `Last scheduled session ping: ${lastPing.label}` : '';
}

// Tokens here are reconstructed from the local transcripts, unlike the limit
// percentages above - say so, the same way the panels label them "est.".
export function renderSessions(sessions) {
  if (!sessions?.length) return '';
  return ["Today's sessions by tokens spent (est., local transcripts):"]
    .concat(sessions.map(s =>
      `- **${s.label}** - ${s.tokens} tokens${s.when ? `, last turn ${s.when}` : ''} · ` +
      `resume: \`${s.resumeCommand}\``))
    .join('\n');
}
