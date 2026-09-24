// Today's sessions and the last session ping for the MCP server (mirrors
// lib/pure.js; tests/fixtures/sessions.json). scripts/session-ping.sh writes
// its last successful ping under the state dir; the panels and the status line
// read the same file. The session index is likewise shared with the desktop
// clients - one machine, one set of transcripts, one incremental index - so
// whichever client runs keeps it warm for the others.

import fs from 'node:fs';
import {Buffer} from 'node:buffer';
import path from 'node:path';

import {
  formatClock, formatLastPing, localDay, parseStamp, shiftLocalDay,
} from '../claude-code/stamps.js';
import {lastPingPath, projectsDir, sessionIndexPath} from '../claude-code/paths.js';
import {turnTokens} from '../claude-code/transcript-tokens.js';

const INDEX_VERSION = 1;
const SESSION_BUDGET_BYTES = 16 << 20; // per call: a cold index warms over a few
// A newline-less run this long is not a line (lib/sessionIndex.js CARRY_MAX):
// it is skipped, not re-read on every call with the offset stuck before it.
const CARRY_MAX = 1 << 20;
const SEEN_IDS_MAX = 32;
const SESSION_LIMIT = 5;

/** Tokens billed for one assistant turn - cache READS excluded, they bill at a
 *  fraction and would rank every long session first. */
// One per-turn token rule for every Node reader (claude-code/transcript-tokens.js).
export {turnTokens};

export function newSessionAcc() {
  return {sessionId: null, cwd: null, title: null, lastMs: 0, byDay: {}, ids: []};
}

export function foldSessionLine(line, acc, defaultDay) {
  if (!line) return acc;
  // skip the parse unless the line can change something: a usage turn, or a
  // rename (the LAST custom title wins)
  const hasUsage = line.indexOf('"usage"') >= 0;
  const hasTitle = line.indexOf('"customTitle"') >= 0;
  if (!hasUsage && !hasTitle && acc.sessionId && acc.cwd) return acc;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return acc;
  }
  if (!acc.sessionId && typeof o.sessionId === 'string') acc.sessionId = o.sessionId;
  if (!acc.cwd && typeof o.cwd === 'string') acc.cwd = o.cwd;
  if (typeof o.customTitle === 'string' && o.customTitle) acc.title = o.customTitle;
  const usage = o.message?.usage;
  if (!usage) return acc;
  const id = o.message?.id;
  if (id) {
    if (acc.ids.includes(id)) return acc;
    acc.ids.push(id);
    if (acc.ids.length > SEEN_IDS_MAX) acc.ids.shift();
  }
  const at = o.timestamp ? parseStamp(o.timestamp) : null;
  if (at !== null && at > acc.lastMs) acc.lastMs = at;
  const day = at !== null ? localDay(at) : defaultDay;
  acc.byDay[day] = (acc.byDay[day] ?? 0) + turnTokens(usage);
  return acc;
}

/** The mtime an index entry records: whole seconds, in ms - the precision
 *  every port can stat (GIO gives seconds), so an entry one port wrote
 *  compares equal to another port's stat of the same file. */
export function indexMtime(ms) {
  return Math.floor(Number(ms) / 1000) * 1000;
}

export function pruneByDay(byDay, nowMs) {
  const keep = new Set([localDay(nowMs), localDay(shiftLocalDay(nowMs, -1).getTime())]);
  const out = {};
  for (const [day, n] of Object.entries(byDay ?? {})) if (keep.has(day)) out[day] = n;
  return out;
}

export function sessionTitle(entry) {
  if (entry.title) return entry.title;
  const base = (entry.cwd ?? '').replace(/\/+$/, '').split('/').pop();
  return base || (entry.sessionId ?? '').slice(0, 8) || 'session';
}

export function rankSessions(entries, {nowMs = Date.now(), limit = SESSION_LIMIT} = {}) {
  const today = localDay(nowMs);
  return (entries ?? [])
    .filter((e) => e.sessionId)
    .map((e) => ({
      sessionId: e.sessionId,
      cwd: e.cwd ?? '',
      title: e.title ?? null,
      lastMs: e.lastMs ?? 0,
      tokens: (e.byDay ?? {})[today] ?? 0,
    }))
    .filter((e) => e.tokens > 0 || (e.lastMs > 0 && localDay(e.lastMs) === today))
    .sort((a, b) => b.tokens - a.tokens || b.lastMs - a.lastMs)
    .slice(0, Math.max(0, limit))
    .map((e) => ({
      ...e,
      label: sessionTitle(e),
      when: e.lastMs ? formatClock(e.lastMs) : '',
      resumeCommand: resumeCommand(e),
    }));
}

export function shellQuote(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

/** The command that resumes one session where it was left. */
export function resumeCommand(entry, {claudeBin = 'claude'} = {}) {
  const cd = entry.cwd ? `cd ${shellQuote(entry.cwd)} && ` : '';
  return `${cd}${claudeBin} --resume ${shellQuote(entry.sessionId)}`;
}

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
  return rankSessions(Object.values(index.files), {nowMs, limit});
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
