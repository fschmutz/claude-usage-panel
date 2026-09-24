#!/usr/bin/env node
// Claude Code status line: a condensed, one-line view of your Claude plan usage,
// rendered just under the prompt input. It reads ONLY what Claude Code pipes on
// stdin - the context window, the account Session (5 h) / Week (7 d) rate limits,
// and the session transcript for a token total - so it needs no credentials and
// no network (the opt-in account segment reads ~/.claude.json and the saved
// profiles, never a token; the only writes are small caches under the tmp
// dir). This is deliberately the cheap terminal projection: per-model
// (e.g. Fable) weekly limits and API severity are API-only and shown only by the
// GNOME extension and the macOS app, never here. Output is left-aligned (Claude
// Code anchors the line to the left; use the settings `padding` field to indent).
//
// The contract pieces it renders - the burn-rate forecast and clock pace
// (pace.js), the ping stamps (stamps.js), the account rule (accounts-contract.js)
// - are the same modules the MCP server uses; this file is only the rendering.

import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

import {openStore} from './accounts.js';
import {accountKey, activeAccountName, autoSwitchTarget, usageSeverity, worstFromCache, worstPercent} from './accounts-contract.js';
import {clampPercent} from './normalize.js';
import {clockPace, forecastMap} from './pace.js';
import {lastPingPath, sessionIndexPath, tokensCachePath} from './paths.js';
import {formatLastPing, localDay, resetHint} from './stamps.js';

// Short labels for the two rate-limit windows stdin exposes. Terse because the
// status line has little horizontal room.
const KIND_LABELS = {session: 'Session', weekly_all: 'Week'};

// ANSI palette. Each gauge is colored by severity - green healthy, yellow
// warning, red critical.
const SEV_COLOR = {
  normal: '\x1b[32m', // green
  warning: '\x1b[33m', // yellow
  critical: '\x1b[1;31m', // bold red
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// Gauge glyphs: a full block, eighth-block fractions for sub-cell precision so
// even a few percent shows a sliver, and a light shade for the empty remainder.
const FULL = '█';
const FRACTIONS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const EMPTY = '░';
const GAUGE_WIDTH = 6;

// A compact fixed-width bar whose fill (colored by severity) tracks the
// percentage down to 1/8 of a cell, with the remainder dimmed. The percent is
// clamped to [0,100] here so no caller can overflow the width or (with a
// negative value) drive FULL.repeat() to throw - the line must never crash.
export function gauge(percent, color) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const eighths = Math.round((p / 100) * GAUGE_WIDTH * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const bar = FULL.repeat(full) + (rem ? FRACTIONS[rem] : '');
  const empty = EMPTY.repeat(Math.max(0, GAUGE_WIDTH - full - (rem ? 1 : 0)));
  return `${color}${bar}${DIM}${empty}${RESET}`;
}

// A "Context" card for the context-window usage Claude Code passes on stdin,
// rendered in the same gauge format as the plan limits. Returns '' when the
// field is absent (older Claude Code) or stdin isn't valid JSON.
export function contextSegment(stdinText) {
  let pct;
  try {
    pct = JSON.parse(stdinText)?.context_window?.used_percentage;
  } catch {
    return '';
  }
  if (!Number.isFinite(Number(pct))) return '';
  const p = clampPercent(pct);
  const color = SEV_COLOR[usageSeverity(p)];
  return `Context ${gauge(p, color)} ${color}${p}%${RESET}`;
}

// The Session (five_hour) and Week (seven_day) rate limits Claude Code passes on
// stdin, as cards keyed like every other port's (`key` = kind: no per-model
// card exists here). No API severity, so colors use the local thresholds;
// resets_at is epoch seconds and converted to ISO.
export function cardsFromStdin(stdinText) {
  let rl;
  try {
    rl = JSON.parse(stdinText)?.rate_limits;
  } catch {
    return [];
  }
  const cards = [];
  const add = (win, kind, label) => {
    const pct = Number(win?.used_percentage);
    if (!Number.isFinite(pct)) return;
    const p = clampPercent(pct);
    const secs = Number(win.resets_at);
    cards.push({
      key: kind,
      kind,
      label,
      group: kind === 'session' ? 'session' : 'weekly',
      percent: p,
      severity: usageSeverity(p),
      resetsAt: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null,
      active: true,
    });
  };
  add(rl?.five_hour, 'session', KIND_LABELS.session);
  add(rl?.seven_day, 'weekly_all', KIND_LABELS.weekly_all);
  return cards;
}

// "⚠full Sun03:40" appended to the gauge of every limit projected to run out
// before its reset. Silent in the good case - the line stays short.
export function exhaustionMarker(fc) {
  if (!fc?.exhaustsBeforeReset) return '';
  const d = new Date(fc.projectedFullAt);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return ` ${SEV_COLOR.warning}⚠full ${day}${hm}${RESET}`;
}

// "↑18" after a gauge: 18 points more of the quota is gone than of the window
// it lives in. Silent unless the card is actually ahead - the line stays short.
export function paceMarker(pace) {
  if (pace?.state !== 'ahead') return '';
  return ` ${SEV_COLOR.warning}↑${pace.deltaPoints}${RESET}`;
}

export function render(cards, {forecasts = new Map(), nowMs = Date.now()} = {}) {
  const active = cards.filter((c) => c.active || c.percent > 0);
  const shown = active.length ? active : cards;
  if (!shown.length) return '';

  // A reset countdown is shown once, after the LAST limit that displays the same
  // value - so a weekly reset shared by several cards isn't repeated.
  const hints = shown.map((c) => resetHint(c.resetsAt, nowMs));
  const lastWithHint = new Map();
  hints.forEach((h, i) => {
    if (h) lastWithHint.set(h, i);
  });

  return shown
    .map((c, i) => {
      const color = SEV_COLOR[c.severity] ?? SEV_COLOR.normal;
      const reset = lastWithHint.get(hints[i]) === i ? ` ${DIM}${hints[i]}${RESET}` : '';
      const marker = exhaustionMarker(forecasts.get(c.key));
      const clock = paceMarker(clockPace(c, nowMs));
      return `${c.label} ${gauge(c.percent, color)} ${color}${c.percent}%${RESET}${reset}${clock}${marker}`;
    })
    .join('  ');
}

// Compact token count: 847 → "847", 16_700 → "16.7k", 1_240_000 → "1.2M". Guards
// the unit boundary so 999_999 promotes to "1.0M" rather than "1000.0k".
export function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) {
    const k = (n / 1e3).toFixed(1);
    return k === '1000.0' ? '1.0M' : `${k}k`;
  }
  return String(n);
}

// Fold the complete JSONL lines of `text` into `acc` ({all, fresh, ids}),
// deduping by message id against `ids` (mutated). Unparseable lines (a partial
// last line while Claude Code is writing) are skipped.
function foldTokens(text, acc) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (!u) continue;
    const id = o.message?.id;
    if (id) {
      if (acc.ids.has(id)) continue;
      acc.ids.add(id);
    }
    const turn = (Number(u.input_tokens) || 0) +
      (Number(u.output_tokens) || 0) +
      (Number(u.cache_creation_input_tokens) || 0);
    acc.fresh += turn;
    acc.all += turn + (Number(u.cache_read_input_tokens) || 0);
  }
  return acc;
}

/**
 * Every token each assistant turn consumed, in one pass over the session
 * transcript (a JSONL, one message per line): `all` counts prompt, cache
 * writes, cache reads and completion; `fresh` leaves the cache reads out.
 * Deduped by message id so a replayed line isn't counted twice. Cache reads
 * dominate a long session, so `all` is the true throughput.
 */
export function transcriptTokens(jsonlText) {
  const {all, fresh} = foldTokens(jsonlText, {all: 0, fresh: 0, ids: new Set()});
  return {all, fresh};
}

/** The old two-call shape, for callers that want one figure. */
export function sumTranscriptTokens(jsonlText, includeCacheRead = true) {
  const t = transcriptTokens(jsonlText);
  return includeCacheRead ? t.all : t.fresh;
}

// How many transcripts the token cache remembers (parallel sessions each keep
// their own entry), and how many trailing message ids each entry keeps for
// dedupe across an incremental read. Claude Code writes the lines of one
// message back to back, so a short tail catches every replay.
const TOKENS_CACHE_ENTRIES = 16;
const TOKENS_SEEN_TAIL = 64;
const TOKENS_CACHE_VERSION = 2;

function readBytes(p, start, end) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function readTokensCache(cachePath) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c?.version === TOKENS_CACHE_VERSION && c.entries && typeof c.entries === 'object') return c.entries;
  } catch {
    // no cache, unreadable, or the pre-v2 single-slot shape - start empty.
  }
  return {};
}

function writeTokensCache(cachePath, entries) {
  const keep = Object.entries(entries)
    .sort((a, b) => (b[1].usedAt ?? 0) - (a[1].usedAt ?? 0))
    .slice(0, TOKENS_CACHE_ENTRIES);
  const tmp = `${cachePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({version: TOKENS_CACHE_VERSION, entries: Object.fromEntries(keep)}),
      {mode: 0o600});
    fs.renameSync(tmp, cachePath); // atomic: a parallel session never reads half a file
  } catch {
    // A read-only tmp dir just means no cache; not fatal.
    try {
      fs.rmSync(tmp, {force: true});
    } catch {
      // nothing to clean up
    }
  }
}

// {all, fresh} token totals for a transcript. Claude Code re-invokes this
// command on every refresh and a long transcript is tens of MB, so the totals
// are cached on disk per transcript path (the last TOKENS_CACHE_ENTRIES
// transcripts, so parallel sessions do not evict each other) together with the
// byte offset of the last complete line folded in. An unchanged file is served
// without a read; a grown one is read only past that offset; a shrunk or
// replaced one (size below the offset, other inode) is folded from scratch. A
// trailing line without its newline yet is counted in the result but not in the
// cached state, so it is re-read, not double-counted, once it completes.
// Returns null when the transcript isn't on disk yet. statFile/readFrom/
// cachePath/nowMs are injectable for tests.
export function transcriptTotals(p, {
  statFile = fs.statSync,
  readFrom = readBytes,
  cachePath = tokensCachePath(),
  nowMs = Date.now(),
} = {}) {
  let st;
  try {
    st = statFile(p);
  } catch {
    return null; // transcript not on disk yet, or not readable
  }
  const size = Number(st.size) || 0;
  const ino = st.ino ?? null;
  const entries = readTokensCache(cachePath);
  let e = entries[p];
  if (e && e.size === size && e.mtimeMs === st.mtimeMs && e.ino === ino) {
    // Refresh the LRU stamp at most once a minute: a hit stays read-only.
    if (nowMs - (e.usedAt ?? 0) > 60_000) {
      e.usedAt = nowMs;
      writeTokensCache(cachePath, entries);
    }
    return {all: e.all + e.tailAll, fresh: e.fresh + e.tailFresh};
  }
  if (!e || e.ino !== ino || size < e.offset) e = {offset: 0, all: 0, fresh: 0, ids: []};
  let chunk;
  try {
    chunk = readFrom(p, e.offset, size);
  } catch {
    return null;
  }
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const cut = buf.lastIndexOf(0x0a) + 1; // bytes up to and including the last newline
  const acc = foldTokens(buf.subarray(0, cut).toString('utf8'), {all: e.all, fresh: e.fresh, ids: new Set(e.ids)});
  const tail = foldTokens(buf.subarray(cut).toString('utf8'), {all: 0, fresh: 0, ids: new Set(acc.ids)});
  entries[p] = {
    size, mtimeMs: st.mtimeMs, ino, offset: e.offset + cut,
    all: acc.all, fresh: acc.fresh, tailAll: tail.all, tailFresh: tail.fresh,
    ids: [...acc.ids].slice(-TOKENS_SEEN_TAIL), usedAt: nowMs,
  };
  writeTokensCache(cachePath, entries);
  return {all: acc.all + tail.all, fresh: acc.fresh + tail.fresh};
}

// The "∑ N tok" card: cumulative tokens this window has consumed, from the
// transcript Claude Code points to on stdin (transcript_path). Returns '' when
// the path is absent (before the first turn) or unreadable.
export function tokensSegment(stdinText, {
  includeCacheRead = true,
  statFile,
  readFrom,
  cachePath,
} = {}) {
  let p;
  try {
    p = JSON.parse(stdinText)?.transcript_path;
  } catch {
    return '';
  }
  if (!p) return '';
  const totals = transcriptTotals(p, {statFile, readFrom, cachePath});
  if (!totals) return '';
  const total = includeCacheRead ? totals.all : totals.fresh;
  if (!total) return '';
  return `${DIM}∑ ${formatTokens(total)} tok${RESET}`;
}

// "ping 05:30": the last time a scheduled ping opened a session window. Silent
// for anyone who has not scheduled pings, which is why it can sit in the
// default segment list.
export function pingSegment({
  nowMs = Date.now(),
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  pingPath = lastPingPath(),
} = {}) {
  let raw;
  try {
    raw = readFile(pingPath);
  } catch {
    return '';
  }
  const label = formatLastPing(raw, nowMs);
  return label ? `${DIM}ping ${label}${RESET}` : '';
}

// "▸ my-app 412k": today's biggest token spender among the local sessions,
// read from the shared index (the MCP server / panels build it; the status
// line must stay a sub-100ms command, so it never folds a transcript itself).
// Opt-in (--segments=…,sessions) because the line has little horizontal room.
export function sessionsSegment({
  nowMs = Date.now(),
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  indexPath = sessionIndexPath(),
} = {}) {
  let index;
  try {
    index = JSON.parse(readFile(indexPath));
  } catch {
    return '';
  }
  const today = localDay(nowMs);
  const top = Object.values(index?.files ?? {})
    .map((e) => ({...e, tokens: (e.byDay ?? {})[today] ?? 0}))
    .filter((e) => e.sessionId && e.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)[0];
  if (!top) return '';
  const name = top.title || (top.cwd ?? '').replace(/\/+$/, '').split('/').pop() ||
    top.sessionId.slice(0, 8);
  return `${DIM}▸ ${name} ${formatTokens(top.tokens)}${RESET}`;
}

// "[PRO]": which saved account this session runs on - and, when the panels'
// last snapshot says another saved account has room while this one is at the
// auto-switch threshold, "[PRO ⇢ PERSO]" in yellow. No network and no token
// here: the name comes from ~/.claude.json against the saved profiles, the
// other accounts' usage from the cache the panels / MCP server keep, and this
// session's own usage from the stdin rate limits. Deliberately NOT
// store.liveAccountName(): that reads the live access token first, which on
// macOS forks `security` against the Keychain on every refresh and pulls the
// bearer token into this process. The account block alone names the login; it
// can only lag during a switch torn between its two writes, which the next
// switch or sync repairs. Never throws: a status line must render whatever the
// store looks like.
export function accountSegment(stdinText, {nowMs = Date.now(), io = {}} = {}) {
  try {
    const store = openStore({...io, nowMs});
    const active = activeAccountName(store.listProfiles(), store.readLiveAccount());
    if (!active) return '';
    const worst = worstFromCache(store.readUsageCache());
    // This session's own numbers are fresher than any cache entry.
    const own = worstPercent(cardsFromStdin(stdinText));
    if (own !== null) worst[active] = own;
    const target = autoSwitchTarget({active, worst, nowMs, lastSwitchMs: store.readLastSwitchMs()});
    if (target) return `${SEV_COLOR.warning}[${active} ⇢ ${target.to}]${RESET}`;
    return `${DIM}[${active}]${RESET}`;
  } catch {
    return '';
  }
}

// The limits segment: record this refresh's samples and project each limit's
// burn rate; the render appends a "⚠full …" marker only when one is on pace
// to run out before its reset, so the line stays short in the good case.
//
// The samples are filed under the live login (its oauthAccount uuid, else its
// email - the MCP server files under the same key): two logins are two quota
// pools, and one series across a switch reads a 10 % -> 60 % jump as a burn.
// Like accountSegment this reads only the account block, never a token.
export function limitsSegment(stdinText, {nowMs = Date.now(), historyPath, io = {}} = {}) {
  const cards = cardsFromStdin(stdinText);
  const forecasts = forecastMap(cards, {
    nowMs, account: liveAccountKey(io), ...(historyPath ? {historyPath} : {}),
  });
  return render(cards, {forecasts, nowMs});
}

/** The live login's history key (accountKey), or null without one. */
export function liveAccountKey(io = {}) {
  try {
    return accountKey(openStore(io).readLiveAccount());
  } catch {
    return null;
  }
}

// The segments the line can show, keyed by the name used in --segments. Each
// takes the stdin text and the parsed config and returns its rendered string.
const SEGMENTS = {
  account: (stdin) => accountSegment(stdin),
  context: (stdin) => contextSegment(stdin),
  limits: (stdin) => limitsSegment(stdin),
  tokens: (stdin, cfg) => tokensSegment(stdin, {includeCacheRead: cfg.includeCacheRead}),
  ping: () => pingSegment(),
  sessions: () => sessionsSegment(),
};
// `ping` is in the default list but renders nothing until session pings are
// scheduled, so it costs an unconfigured user no width. `account` and
// `sessions` are opt-in (--segments=account,…).
const DEFAULT_SEGMENTS = ['context', 'limits', 'tokens', 'ping'];

// Configure the line from the command's argv (install.sh bakes these into the
// settings.json command): `--segments=a,b,c` picks which segments to show and in
// what order; `--tokens=fresh` sums only new tokens (excludes cache reads).
// Unknown segment names are dropped; an empty/missing list falls back to
// DEFAULT_SEGMENTS (so `account` and `sessions` stay opt-in).
export function parseConfig(argv) {
  const cfg = {segments: DEFAULT_SEGMENTS, includeCacheRead: true};
  for (const arg of argv) {
    const seg = /^--segments=(.*)$/.exec(arg);
    if (seg) {
      const list = seg[1].split(',').map((s) => s.trim()).filter((s) => SEGMENTS[s]);
      if (list.length) cfg.segments = list;
    } else if (arg === '--tokens=fresh') {
      cfg.includeCacheRead = false;
    } else if (arg === '--tokens=all') {
      cfg.includeCacheRead = true;
    }
  }
  return cfg;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8'); // fd 0; Claude Code always pipes JSON here
  } catch {
    return '';
  }
}

// The whole line: the chosen segments in order, left-aligned (Claude Code
// left-anchors the status line; indent via the settings `padding` field).
// Each segment is rendered on its own: one that throws - a corrupt file, an
// unexpected stdin shape - drops only itself, never the rest of the line.
export function renderLine(stdin, cfg, segments = SEGMENTS) {
  const parts = [];
  for (const key of cfg.segments) {
    try {
      const text = segments[key]?.(stdin, cfg);
      if (text) parts.push(text);
    } catch {
      // this segment stays blank; the others still render
    }
  }
  return parts.join('  ');
}

function main() {
  const cfg = parseConfig(process.argv.slice(2));
  process.stdout.write(renderLine(readStdin(), cfg));
}

// Only render when run directly; importing (e.g. from tests) is side-effect free.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A status line must never crash if the reader closes the pipe early.
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main();
}
