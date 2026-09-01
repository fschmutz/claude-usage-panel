#!/usr/bin/env node
// Claude Usage MCP server: exposes the same plan-usage data as the desktop
// panels through one Model Context Protocol tool (`get_usage`), so any MCP
// client - Claude Code, Cursor, Claude Desktop… - can ask "how much of my plan
// have I used?" in-conversation. Zero dependencies, stdio transport, read-only:
// it reads the OAuth token Claude Code already stores locally and calls the
// official usage endpoint, exactly like the GNOME extension and the macOS app.
//
// This is the fourth port of the shared normalization contract (see CLAUDE.md
// "one contract, N ports"): lib/pure.js (GNOME) · Model.swift (macOS) ·
// statusline.js (terminal) · this file. tests/parity.test.js keeps them in sync.

import fs from 'node:fs';
import os from 'node:os';
import {Buffer} from 'node:buffer';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Bumped by scripts/bump-version.sh - keep in sync with package.json.
export const VERSION = '1.8.0';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;

// Newest first; initialize echoes the client's requested version when we
// support it, otherwise answers with our newest (per the MCP spec).
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ── Shared normalization contract (mirrors lib/pure.js) ─────────────────────────

const KIND_LABELS = {
  session: 'Current session',
  weekly_all: 'Weekly · all models',
  weekly_scoped: 'Weekly',
  weekly_oauth_apps: 'Weekly · apps',
};
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped', 'weekly_oauth_apps'];

export function clampPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// Which pool a limit draws from. The API sends `group` ("session" / "weekly");
// payloads that predate it are grouped by the kind prefix instead.
function groupOf(kind, group) {
  if (group) return group;
  return String(kind).startsWith('weekly') ? 'weekly' : String(kind);
}

function normalizeLimit(entry) {
  let label = KIND_LABELS[entry.kind] ?? entry.kind;
  const model = entry.scope?.model?.display_name;
  if (model) label = `${label} · ${model}`;
  return {
    key: entry.kind + (model ? `:${model}` : ''),
    label,
    group: groupOf(entry.kind, entry.group),
    scoped: Boolean(model),
    percent: clampPercent(entry.percent),
    severity: entry.severity ?? 'normal',
    resetsAt: entry.resets_at ?? null,
    active: Boolean(entry.is_active),
  };
}

// A scoped (per-model) limit is a sub-cap ON its group's pooled limit, not a
// pool of its own: Fable usage counts toward `weekly_all` and shares its reset.
// The API leaves the scoped `resets_at` null until that model is used in the
// window, so borrow the pooled reset.
function inheritPooledResets(cards) {
  for (const card of cards) {
    if (!card.scoped || card.resetsAt) continue;
    const pooled = cards.find((o) => !o.scoped && o.group === card.group && o.resetsAt);
    if (pooled) card.resetsAt = pooled.resetsAt;
  }
  return cards;
}

// Extract normalized limit cards from the raw usage payload. Prefers the modern
// `limits[]` array; falls back to legacy five_hour / seven_day fields.
export function normalizeUsage(payload) {
  if (Array.isArray(payload?.limits) && payload.limits.length) {
    return inheritPooledResets(payload.limits.map(normalizeLimit)).sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.key.split(':')[0]);
      const bi = KIND_ORDER.indexOf(b.key.split(':')[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  const cards = [];
  if (Number.isFinite(Number(payload?.five_hour?.utilization))) {
    cards.push({
      key: 'session', label: KIND_LABELS.session,
      group: 'session', scoped: false,
      percent: clampPercent(payload.five_hour.utilization),
      severity: 'normal', resetsAt: payload.five_hour.resets_at ?? null, active: true,
    });
  }
  if (Number.isFinite(Number(payload?.seven_day?.utilization))) {
    cards.push({
      key: 'weekly_all', label: KIND_LABELS.weekly_all,
      group: 'weekly', scoped: false,
      percent: clampPercent(payload.seven_day.utilization),
      severity: 'normal', resetsAt: payload.seven_day.resets_at ?? null, active: false,
    });
  }
  return cards;
}

// Note for a scoped (per-model) card: its percent is a *share* of the weekly
// pool (on Max, up to 50 % of the weekly allowance may go to Fable), never
// extra headroom - every Fable token also moves `weekly_all`.
export function poolNote(card) {
  return card?.scoped && card.group === 'weekly' ? 'share of the weekly all-models limit' : '';
}

// ── Burn-rate forecast (mirrors lib/pure.js; tests/fixtures/forecast.json) ──────

const FORECAST_WINDOW_MS = 6 * 3600_000;
const FORECAST_MIN_SAMPLES = 3;
const FORECAST_MIN_SPAN_MS = 30 * 60_000;
const FORECAST_MIN_PACE = 0.2;

// Timestamped percent samples per limit, SHARED with the status line (both
// write the same tmp file, best-effort) so each invocation densifies the
// other's history.
const HISTORY_PATH = path.join(os.tmpdir(), 'claude-usage-history.json');

// Project when a limit hits 100% at the current pace - see pure.js for the
// full contract; the three JS copies + Swift are pinned by one fixture.
export function forecast(samples, resetsAt, nowMs) {
  if (!Array.isArray(samples) || !samples.length) return null;
  let start = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i - 1][1] > samples[i][1] + 1) {
      start = i;
      break;
    }
  }
  const win = samples
    .slice(start)
    .filter(([t]) => Number.isFinite(t) && t > nowMs - FORECAST_WINDOW_MS && t <= nowMs);
  if (win.length < FORECAST_MIN_SAMPLES) return null;
  const [t0] = win[0];
  const [tLast, pLast] = win[win.length - 1];
  if (tLast - t0 < FORECAST_MIN_SPAN_MS || pLast >= 100) return null;
  let sw = 0, swt = 0, swp = 0, swtt = 0, swtp = 0;
  win.forEach(([t, p], i) => {
    const w = i + 1;
    const th = (t - t0) / 3600_000;
    sw += w;
    swt += w * th;
    swp += w * p;
    swtt += w * th * th;
    swtp += w * th * p;
  });
  const denom = sw * swtt - swt * swt;
  if (denom === 0) return null;
  const slope = (sw * swtp - swt * swp) / denom;
  if (!Number.isFinite(slope) || slope < FORECAST_MIN_PACE) return null;
  const fullMs = tLast + ((100 - pLast) / slope) * 3600_000;
  const projected = Math.round(fullMs / 60_000) * 60_000;
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  const margin = Number.isFinite(resetMs)
    ? Math.round(((projected - resetMs) / 3600_000) * 10) / 10
    : null;
  return {
    pctPerHour: Math.round(slope * 100) / 100,
    projectedFullAt: new Date(projected).toISOString(),
    exhaustsBeforeReset: margin !== null && margin < 0,
    marginHours: margin,
  };
}

// Append this call's samples to the shared history and return the updated map.
// Keyed by the card key (so scoped limits like weekly_scoped:Fable track too).
export function recordHistory(cards, {nowMs = Date.now(), historyPath = HISTORY_PATH} = {}) {
  let hist = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (parsed && typeof parsed === 'object') hist = parsed;
  } catch {
    // no history yet
  }
  for (const c of cards) {
    const list = Array.isArray(hist[c.key]) ? hist[c.key] : [];
    list.push([nowMs, c.percent]);
    hist[c.key] = list.slice(-200);
  }
  try {
    fs.writeFileSync(historyPath, JSON.stringify(hist), {mode: 0o600});
  } catch {
    // read-only tmp dir just means no pace fields; not fatal
  }
  return hist;
}

// Attach a `pace` object to every card whose history supports an honest
// projection. Pooled limits share their key ("session" / "weekly_all") with the
// status line's records, so either client's samples feed the other's forecast.
export function withPace(cards, {nowMs = Date.now(), historyPath = HISTORY_PATH} = {}) {
  const hist = recordHistory(cards, {nowMs, historyPath});
  return cards.map((c) => {
    const fc = forecast(hist[c.key] ?? [], c.resetsAt, nowMs);
    return fc ? {...c, pace: fc} : c;
  });
}

// "resets in 3h06m" / "4d2h" - the two most significant units, like the
// status line's resetHint.
export function resetHint(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

// ── Token + fetch (mirrors lib/claudeUsage.js / Usage.swift) ────────────────────

function tokenFromJSON(text) {
  try {
    const json = JSON.parse(text);
    const oauth = json.claudeAiOauth ?? json;
    return oauth.accessToken ?? oauth.access_token ?? oauth.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the OAuth access token. On Linux it lives in
 * ~/.claude/.credentials.json; on macOS, Claude Code stores it in the login
 * Keychain, so we fall back to `security find-generic-password`.
 */
export function readAccessToken({homedir = os.homedir(), platform = process.platform} = {}) {
  try {
    const raw = fs.readFileSync(path.join(homedir, '.claude', '.credentials.json'), 'utf8');
    const token = tokenFromJSON(raw);
    if (token) return token;
  } catch {
    // fall through to the Keychain on macOS
  }
  if (platform === 'darwin') {
    for (const service of ['Claude Code-credentials', 'Claude Code', 'claude']) {
      try {
        const raw = execFileSync('/usr/bin/security',
          ['find-generic-password', '-s', service, '-w'],
          {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
        const token = tokenFromJSON(raw);
        if (token) return token;
      } catch {
        // try the next service name
      }
    }
  }
  return null;
}

/**
 * Fetch and normalize usage.
 * @returns {Promise<{ok: true, cards: object[], raw: object}
 *                   | {ok: false, code: string, message: string}>}
 */
export async function fetchUsage({fetchImpl = fetch, token = readAccessToken()} = {}) {
  if (!token) {
    return {
      ok: false, code: 'no_token',
      message: 'No Claude credentials found. Sign in with Claude Code first.',
    };
  }
  let response;
  try {
    response = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return {ok: false, code: 'network_error', message: e.message};
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false, code: 'auth_expired',
      message: 'Claude session expired. Run any Claude Code command to refresh it.',
    };
  }
  if (!response.ok) return {ok: false, code: 'http_error', message: `HTTP ${response.status}`};
  try {
    const raw = await response.json();
    return {ok: true, cards: normalizeUsage(raw), raw};
  } catch (e) {
    return {ok: false, code: 'parse_error', message: e.message};
  }
}

// One markdown line per limit: label, percent, severity, reset countdown, and -
// when history supports a projection - the burn rate and whether it runs out
// before the reset.
export function renderCards(cards, now = Date.now()) {
  if (!cards.length) return 'No plan limits reported by the usage endpoint.';
  return cards.map(c => {
    const reset = resetHint(c.resetsAt, now);
    const parts = [`**${c.label}** - ${c.percent}%`];
    if (c.severity !== 'normal') parts.push(c.severity.toUpperCase());
    if (reset) parts.push(`resets in ${reset}`);
    const note = poolNote(c);
    if (note) parts.push(note);
    if (c.pace) {
      parts.push(c.pace.exhaustsBeforeReset
        ? `↗ ${c.pace.pctPerHour}%/h - ON PACE TO RUN OUT ${Math.abs(c.pace.marginHours)}h before reset (~${c.pace.projectedFullAt})`
        : `↗ ${c.pace.pctPerHour}%/h - lasts past reset`);
    }
    return `- ${parts.join(' · ')}`;
  }).join('\n');
}


// ── Session pings and today's sessions (mirrors lib/pure.js) ───────────────────
// scripts/session-ping.sh writes its last successful ping here; the panels and
// the status line read the same file. The session index is likewise shared with
// the desktop clients - one machine, one set of transcripts, one incremental
// index - so whichever client runs keeps it warm for the others.

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

// ── MCP plumbing (stdio JSON-RPC 2.0, newline-delimited) ────────────────────────

const GET_USAGE_TOOL = {
  name: 'get_usage',
  title: 'Claude plan usage',
  description:
    'Current Claude plan usage: session, weekly, and per-model limits - ' +
    'percent used, severity, and reset time for each, from the official ' +
    'Anthropic usage endpoint (same numbers as /usage). A per-model limit ' +
    '(scoped:true, e.g. Fable) caps a share of the weekly all-models pool and ' +
    'draws from it - it is not extra quota. When enough local history exists, ' +
    'each limit also carries a `pace` projection: %/hour burn rate, the ' +
    'projected 100% instant, and whether that lands before the reset. Also ' +
    'reports `lastPing` (when a scheduled session ping last opened a 5-hour ' +
    'window) and `sessions`: today\'s local Claude Code sessions ranked by the ' +
    'tokens they spent, each with the shell command that resumes it.',
  inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  outputSchema: {
    type: 'object',
    properties: {
      limits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: {type: 'string'},
            label: {type: 'string'},
            group: {type: 'string', description: 'pool this limit draws from: session | weekly'},
            scoped: {
              type: 'boolean',
              description: 'per-model sub-cap of the group pool, not a pool of its own',
            },
            percent: {type: 'integer', minimum: 0, maximum: 100},
            severity: {type: 'string', enum: ['normal', 'warning', 'critical']},
            resetsAt: {type: ['string', 'null']},
            active: {type: 'boolean'},
            pace: {
              type: 'object',
              description:
                'burn-rate projection from local sample history; absent when ' +
                'idle or too little history',
              properties: {
                pctPerHour: {type: 'number'},
                projectedFullAt: {type: 'string', description: 'instant the limit hits 100%'},
                exhaustsBeforeReset: {
                  type: 'boolean',
                  description: 'true when projected to run out BEFORE the reset',
                },
                marginHours: {
                  type: ['number', 'null'],
                  description: 'projectedFullAt − reset in hours; negative = runs out early',
                },
              },
              required: ['pctPerHour', 'projectedFullAt', 'exhaustsBeforeReset'],
            },
          },
          required: ['key', 'label', 'group', 'scoped', 'percent', 'severity'],
        },
      },
      lastPing: {
        type: ['object', 'null'],
        description:
          'last successful scheduled session ping (install.sh sessionping); ' +
          'null when pings were never scheduled',
        properties: {
          at: {type: 'string', description: 'ISO 8601 instant'},
          label: {type: 'string', description: 'short local form, e.g. "05:30"'},
        },
        required: ['at', 'label'],
      },
      sessions: {
        type: 'array',
        description:
          "today's local Claude Code sessions, biggest token spender first. " +
          'Token counts are ESTIMATED from the local transcripts (cache reads ' +
          'excluded), not reported by the API.',
        items: {
          type: 'object',
          properties: {
            sessionId: {type: 'string'},
            label: {type: 'string', description: 'session title, else project directory'},
            cwd: {type: 'string'},
            tokens: {type: 'integer', description: 'estimated tokens spent today'},
            when: {type: 'string', description: 'local HH:MM of its last turn'},
            resumeCommand: {type: 'string', description: 'shell command that resumes it'},
          },
          required: ['sessionId', 'label', 'cwd', 'tokens', 'resumeCommand'],
        },
      },
    },
    required: ['limits'],
  },
  annotations: {readOnlyHint: true, openWorldHint: true},
};

export async function handleRequest(msg, deps = {}) {
  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const protocolVersion =
        PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'claude-usage', title: 'Claude Usage Panel', version: VERSION},
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {tools: [GET_USAGE_TOOL]};
    case 'tools/call': {
      if (msg.params?.name !== 'get_usage')
        throw new RpcError(-32602, `Unknown tool: ${msg.params?.name}`);
      const result = await fetchUsage(deps);
      if (!result.ok)
        return {content: [{type: 'text', text: `${result.code}: ${result.message}`}], isError: true};
      const cards = withPace(result.cards, deps.paceOpts);
      const lastPing = readLastPing(deps.pingOpts);
      const sessions = refreshSessions(deps.sessionOpts);
      return {
        content: [{
          type: 'text',
          text: [renderCards(cards), renderPing(lastPing), renderSessions(sessions)]
            .filter(Boolean).join('\n\n'),
        }],
        structuredContent: {limits: cards, lastPing, sessions},
      };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${msg.method}`);
  }
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', id, ...body})}\n`);
}

export function main() {
  let buffer = '';
  // In-flight request count: on stdin EOF we must let pending async work
  // (a tools/call mid-fetch) answer before exiting, not die mid-request.
  let pending = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && pending === 0) process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        reply(null, {error: {code: -32700, message: 'Parse error'}});
        continue;
      }
      // Notifications (no id) expect no response; requests get exactly one.
      const isRequest = msg.id !== undefined && msg.id !== null;
      if (typeof msg.method !== 'string') {
        if (isRequest) reply(msg.id, {error: {code: -32600, message: 'Invalid request'}});
        continue;
      }
      if (!isRequest) continue;
      pending += 1;
      handleRequest(msg)
        .then(result => reply(msg.id, {result}))
        .catch(e => reply(msg.id, {
          error: {code: e instanceof RpcError ? e.code : -32603, message: e.message},
        }))
        .finally(() => {
          pending -= 1;
          maybeExit();
        });
    }
  });
  process.stdin.on('end', () => {
    ended = true;
    maybeExit();
  });
}

// Run when executed directly - including through the npm/npx bin shim, which
// invokes us via a node_modules/.bin symlink, so compare realpaths.
const invokedAs = (() => {
  try {
    return process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (invokedAs === import.meta.url) {
  main();
}
