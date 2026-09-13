// Session pings and today's sessions for the MCP server (mirrors lib/pure.js).
// scripts/session-ping.sh writes its last successful ping here; the panels and
// the status line read the same file. The session index is likewise shared with
// the desktop clients - one machine, one set of transcripts, one incremental
// index - so whichever client runs keeps it warm for the others.

import fs from 'node:fs';
import os from 'node:os';
import {Buffer} from 'node:buffer';
import path from 'node:path';

const STATE_DIR = process.env.XDG_STATE_HOME
  ? path.join(process.env.XDG_STATE_HOME, 'claude-usage-panel')
  : path.join(os.homedir(), '.local', 'state', 'claude-usage-panel');
const LAST_PING_PATH = path.join(STATE_DIR, 'last-ping');
const SESSION_INDEX_PATH = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
  'claude-usage-panel', 'sessions.json');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const INDEX_VERSION = 1;
const SESSION_BUDGET_BYTES = 16 << 20; // per call: a cold index warms over a few
const SEEN_IDS_MAX = 32;
const SESSION_LIMIT = 5;

const STAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseStamp(text) {
  const m = STAMP_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, zone] = m;
  if (!zone) {
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
      .getTime();
  }
  let offsetMin = 0;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offsetMin = (zone[0] === '-' ? -1 : 1) *
      (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) -
    offsetMin * 60_000;
}

export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`;
}

export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatLastPing(text, nowMs) {
  const at = parseStamp(text);
  if (at === null) return '';
  const clock = formatClock(at);
  const day = localDay(at);
  if (day === localDay(nowMs)) return clock;
  if (day === localDay(nowMs - 86_400_000)) return `yesterday ${clock}`;
  if (nowMs - at < 6 * 86_400_000) return `${DAY_NAMES[(new Date(at).getDay() + 6) % 7]} ${clock}`;
  return `${day} ${clock}`;
}

/** Tokens billed for one assistant turn - cache READS excluded, they bill at a
 *  fraction and would rank every long session first. */
export function turnTokens(usage) {
  if (!usage) return 0;
  return (Number(usage.input_tokens) || 0) +
    (Number(usage.output_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0);
}

export function newSessionAcc() {
  return {sessionId: null, cwd: null, title: null, lastMs: 0, byDay: {}, ids: []};
}

export function foldSessionLine(line, acc, defaultDay) {
  if (!line) return acc;
  const hasUsage = line.indexOf('"usage"') >= 0;
  if (!hasUsage && acc.sessionId && acc.cwd && acc.title) return acc;
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

export function pruneByDay(byDay, nowMs) {
  const keep = new Set([localDay(nowMs), localDay(nowMs - 86_400_000)]);
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
        if (st.mtimeMs >= cutoff) out.push({path: file, size: st.size, mtimeMs: st.mtimeMs});
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
    if (lastNewline < 0) return 0; // no complete line yet
    consumed = lastNewline + 1;
    const day = localDay(nowMs);
    for (const line of buf.subarray(0, consumed).toString('utf8').split('\n')) {
      foldSessionLine(line, entry, day);
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
  entry.carry = '';
  entry.byDay = pruneByDay(entry.byDay, nowMs);
  return consumed;
}

/**
 * Update the shared session index and return today's sessions, biggest token
 * spender first. Never throws: a missing ~/.claude/projects just yields [].
 */
export function refreshSessions({
  nowMs = Date.now(),
  limit = SESSION_LIMIT,
  budgetBytes = SESSION_BUDGET_BYTES,
  projectsDir = PROJECTS_DIR,
  indexPath = SESSION_INDEX_PATH,
} = {}) {
  const index = readIndex(indexPath);
  const files = sessionCandidates(projectsDir, nowMs);
  let budget = budgetBytes;
  let dirty = false;

  for (const file of files) {
    let entry = index.files[file.path];
    // Shrunk below what we already folded: the file was replaced, not appended
    // to. Start it over rather than folding from a stale offset.
    if (!entry || (entry.offset ?? 0) > file.size) {
      entry = Object.assign(newSessionAcc(), {offset: 0, carry: ''});
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
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(indexPath), {recursive: true, mode: 0o700});
      fs.writeFileSync(indexPath, JSON.stringify(index), {mode: 0o600});
    } catch {
      // A read-only cache dir means no cache, not a broken tool call.
    }
  }
  return rankSessions(Object.values(index.files), {nowMs, limit});
}

/** The last scheduled ping, or null when pings were never set up. */
export function readLastPing({pingPath = LAST_PING_PATH, nowMs = Date.now()} = {}) {
  let raw;
  try {
    raw = fs.readFileSync(pingPath, 'utf8').trim();
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
