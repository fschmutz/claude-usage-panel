#!/usr/bin/env node
// Claude Code status line: a condensed, one-line view of your Claude plan
// usage, rendered just under the prompt input. Mirrors the data layer of the
// GNOME extension (lib/claudeUsage.js) and the macOS app — read-only, talks
// only to api.anthropic.com, and never writes your credentials back.
//
// Claude Code runs this on every status-line refresh and passes a session JSON
// on stdin, from which we read the context-window usage. Output is left-aligned
// (Claude Code anchors the status line to the left; use the settings `padding`
// field to indent it). To avoid hammering the usage endpoint, successful
// responses are cached on disk for CACHE_TTL_MS.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_PATH = path.join(os.tmpdir(), 'claude-usage-statusline.json');
const CACHE_TTL_MS = 120_000; // the usage endpoint is rate-limited; don't poll it hard
const FETCH_TIMEOUT_MS = 4_000;

// Short labels + ordering for the limit kinds the endpoint returns. Kept
// terse because the status line has little horizontal room.
const KIND_LABELS = {
  session: 'Session',
  weekly_all: 'Week',
  weekly_scoped: 'Week',
  weekly_oauth_apps: 'Apps',
};
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped', 'weekly_oauth_apps'];

// ANSI palette. The status line renders ANSI, so we color each gauge by the
// API's own severity — green while healthy, yellow warning, red critical.
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

function tokenFromJSON(text) {
  try {
    const json = JSON.parse(text);
    const oauth = json.claudeAiOauth ?? json;
    return oauth.accessToken ?? oauth.access_token ?? oauth.token ?? null;
  } catch {
    return null;
  }
}

// On macOS, Claude Code stores its credentials JSON as a generic-password
// Keychain item instead of a file. Mirrors the macOS app's lookup.
function tokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  for (const service of ['Claude Code-credentials', 'Claude Code', 'claude']) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const token = tokenFromJSON(raw);
      if (token) return token;
    } catch {
      // Item not found under this service name; try the next.
    }
  }
  return null;
}

// On Linux the token lives in ~/.claude/.credentials.json; on macOS it lives
// in the login Keychain. Try the file first, then fall back to the Keychain.
function readAccessToken() {
  try {
    const token = tokenFromJSON(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    if (token) return token;
  } catch {
    // No file (typical on macOS) — fall through to the Keychain.
  }
  return tokenFromKeychain();
}

function normalizeLimit(entry) {
  const model = entry.scope?.model?.display_name;
  // For per-model limits the model name alone is the most informative and
  // compact label; otherwise use the short kind label.
  const label = model ?? KIND_LABELS[entry.kind] ?? entry.kind;
  return {
    kind: entry.kind,
    label,
    percent: Math.max(0, Math.min(100, Math.round(Number(entry.percent) || 0))),
    severity: entry.severity ?? 'normal',
    resetsAt: entry.resets_at ?? null,
    active: Boolean(entry.is_active),
  };
}

export function normalizeUsage(payload) {
  if (Array.isArray(payload?.limits) && payload.limits.length) {
    return payload.limits.map(normalizeLimit).sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.kind);
      const bi = KIND_ORDER.indexOf(b.kind);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  const cards = [];
  if (Number.isFinite(Number(payload?.five_hour?.utilization))) {
    cards.push({
      kind: 'session',
      label: KIND_LABELS.session,
      percent: Math.round(payload.five_hour.utilization),
      severity: 'normal',
      resetsAt: payload.five_hour.resets_at ?? null,
      active: true,
    });
  }
  if (Number.isFinite(Number(payload?.seven_day?.utilization))) {
    cards.push({
      kind: 'weekly_all',
      label: KIND_LABELS.weekly_all,
      percent: Math.round(payload.seven_day.utilization),
      severity: 'normal',
      resetsAt: payload.seven_day.resets_at ?? null,
      active: false,
    });
  }
  return cards;
}

// Returns {raw, fresh}: raw is the last cached payload (even when stale); fresh
// says whether it's within the TTL. null when there's no cache at all.
function readCache() {
  try {
    const stat = fs.statSync(CACHE_PATH);
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    return {raw, fresh: Date.now() - stat.mtimeMs <= CACHE_TTL_MS};
  } catch {
    return null;
  }
}

// Bump the cache mtime so a failed fetch backs off for another TTL instead of
// re-hitting (and re-triggering) a rate-limited endpoint on every refresh.
function touchCache() {
  try {
    const now = Date.now() / 1000;
    fs.utimesSync(CACHE_PATH, now, now);
  } catch {}
}

function writeCache(raw) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(raw), {mode: 0o600});
  } catch {
    // A read-only tmp dir just means no cache; not fatal.
  }
}

async function fetchUsage(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return {error: 'session expired'};
    if (!res.ok) return {error: `HTTP ${res.status}`};
    return {raw: await res.json()};
  } catch {
    return {error: 'offline'};
  } finally {
    clearTimeout(timer);
  }
}

// "Resets in 3h06m" / "4d2h" — compact, only the two most significant units.
export function resetHint(resetsAt) {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return ` ${d}d${h}h`;
  if (h > 0) return ` ${h}h${String(m).padStart(2, '0')}m`;
  return ` ${m}m`;
}

// A compact fixed-width bar whose fill (colored by severity) tracks the
// percentage down to 1/8 of a cell, with the remainder dimmed.
export function gauge(percent, color) {
  const eighths = Math.round((percent / 100) * GAUGE_WIDTH * 8);
  const full = Math.floor(eighths / 8);
  const rem = eighths % 8;
  const bar = FULL.repeat(full) + (rem ? FRACTIONS[rem] : '');
  const empty = EMPTY.repeat(Math.max(0, GAUGE_WIDTH - full - (rem ? 1 : 0)));
  return `${color}${bar}${DIM}${empty}${RESET}`;
}

export function render(cards) {
  const active = cards.filter((c) => c.active || c.percent > 0);
  const shown = active.length ? active : cards;
  if (!shown.length) return '';

  // A reset countdown is shown once, after the LAST limit that displays the same
  // value — so a weekly reset shared by Week and each per-model card (whose raw
  // timestamps differ by microseconds but render identically) isn't repeated.
  const hints = shown.map((c) => resetHint(c.resetsAt));
  const lastWithHint = new Map();
  hints.forEach((h, i) => {
    if (h) lastWithHint.set(h, i);
  });

  return shown
    .map((c, i) => {
      const color = SEV_COLOR[c.severity] ?? SEV_COLOR.normal;
      const reset = lastWithHint.get(hints[i]) === i ? `${DIM}${hints[i]}${RESET}` : '';
      return `${c.label} ${gauge(c.percent, color)} ${color}${c.percent}%${RESET}${reset}`;
    })
    .join('  ');
}

// Severity for values that carry no API severity (context, stdin fallback):
// green under 70 %, yellow up to 90 %, red above.
const thresholdSeverity = (p) => (p >= 90 ? 'critical' : p >= 70 ? 'warning' : 'normal');

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
  const p = Math.round(Number(pct));
  const color = SEV_COLOR[thresholdSeverity(p)];
  return `Context ${gauge(p, color)} ${color}${p}%${RESET}`;
}

// Fallback source: the Session (five_hour) and Week (seven_day) rate limits
// Claude Code passes on stdin. No per-model (Fable) and no severity, so colors
// use a local threshold; resets_at is epoch seconds and converted to ISO.
export function cardsFromStdin(stdinText) {
  let rl;
  try {
    rl = JSON.parse(stdinText)?.rate_limits;
  } catch {
    return [];
  }
  const cards = [];
  const add = (win, kind, label) => {
    const pct = Math.round(Number(win?.used_percentage));
    if (!Number.isFinite(pct)) return;
    const p = Math.max(0, Math.min(100, pct));
    const secs = Number(win.resets_at);
    cards.push({
      kind,
      label,
      percent: p,
      severity: thresholdSeverity(p),
      resetsAt: Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null,
      active: true,
    });
  };
  add(rl?.five_hour, 'session', KIND_LABELS.session);
  add(rl?.seven_day, 'weekly_all', KIND_LABELS.weekly_all);
  return cards;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8'); // fd 0; Claude Code always pipes JSON here
  } catch {
    return '';
  }
}

async function main() {
  const stdin = readStdin();
  const ctx = contextSegment(stdin);
  // Claude Code left-anchors the status line (indent is controlled by the
  // settings `padding` field, not by us), so we just emit left-aligned content.
  const emit = (body) => process.stdout.write([ctx, body].filter(Boolean).join('  '));

  const token = readAccessToken();
  const cached = readCache();
  let raw = cached?.fresh ? cached.raw : null;

  if (!raw && token) {
    const result = await fetchUsage(token);
    if (result.raw) {
      raw = result.raw;
      writeCache(raw);
    } else if (cached) {
      // Fetch failed (e.g. HTTP 429): keep showing the last good data and back
      // off, so we don't re-hit the endpoint — and re-trigger the limit — on
      // every refresh.
      raw = cached.raw;
      touchCache();
    }
  }

  if (raw) {
    emit(render(normalizeUsage(raw)));
    return;
  }

  // No usable API data (first run while offline, or signed out) — fall back to
  // the Session/Week rate limits Claude Code passes on stdin. Fable is API-only.
  const fromStdin = render(cardsFromStdin(stdin));
  emit(fromStdin || `${DIM}usage: ${token ? 'unavailable' : 'sign in to Claude Code'}${RESET}`);
}

// Only fetch/render when run directly; importing (e.g. from tests) is side-effect free.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // A status line must never crash if the reader closes the pipe early.
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
  main();
}
