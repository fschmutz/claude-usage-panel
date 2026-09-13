#!/usr/bin/env node
// Claude Usage MCP server: exposes the same plan-usage data as the desktop
// panels through one Model Context Protocol tool (`get_usage`), so any MCP
// client - Claude Code, Cursor, Claude Desktop… - can ask "how much of my plan
// have I used?" in-conversation. Zero dependencies, stdio transport, read-only:
// it reads the OAuth token Claude Code already stores locally and calls the
// official usage endpoint, exactly like the GNOME extension and the macOS app.
//
// Layout: claude-code/normalize.js is the Node port of the shared
// normalization contract (lib/pure.js on GNOME, Model.swift on macOS -
// tests/parity.test.js keeps them in sync); tools.js holds the tool schemas,
// the renderers and the account tool calls; sessions.js the session/ping
// index. This file keeps the burn-rate / clock / warehouse contract copies,
// the token + fetch, and the JSON-RPC transport. The named-account tools are
// backed by claude-code/accounts.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

import {credentialsPath, openStore} from '../claude-code/accounts.js';
import {normalizeExtraUsage, normalizeUsage} from '../claude-code/normalize.js';
import {readLastPing, refreshSessions, renderPing, renderSessions} from './sessions.js';
import {
  ACCOUNT_TOOL_NAMES, ACCOUNT_TOOLS, GET_USAGE_TOOL, callAccountTool, currentAccount,
  renderAccount, renderCards, renderExtraUsage,
} from './tools.js';

// The contract pieces that moved out of this file, still reachable from here
// (tests/parity.test.js and tests/mcp.test.js import them from mcp/server.js).
export {clampPercent, kindLabel, formatMoney, normalizeExtraUsage, normalizeUsage, poolNote}
  from '../claude-code/normalize.js';
export * from './sessions.js';
export {renderAccount, renderAccounts, renderCards, renderExtraUsage, resetHint} from './tools.js';

// Bumped by scripts/bump-version.sh - keep in sync with package.json.
export const VERSION = '1.10.0';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;

// Newest first; initialize echoes the client's requested version when we
// support it, otherwise answers with our newest (per the MCP spec).
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ── Usage against the clock (mirrors lib/pure.js; tests/fixtures/pace.json) ────
// The payload dates the reset but never the window's start, so the length comes
// from the group: 5 h session, 7 d weekly. A card ahead of the clock is burning
// faster than the window it lives in - which a flat burn rate cannot show.

export const WINDOW_MS = {session: 5 * 3600_000, weekly: 7 * 86400_000};
export const PACE_TOLERANCE = 5;

export function elapsedPercent(card, nowMs = Date.now()) {
  const span = WINDOW_MS[card?.group];
  if (!span || !card?.resetsAt) return null;
  const reset = Date.parse(card.resetsAt);
  if (!Number.isFinite(reset)) return null;
  const ratio = 1 - (reset - nowMs) / span;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function clockPace(card, nowMs = Date.now()) {
  const elapsed = elapsedPercent(card, nowMs);
  if (elapsed === null) return null;
  const pct = Math.max(0, Math.min(100, Math.round(Number(card.percent) || 0)));
  const delta = pct - elapsed;
  const state = delta > PACE_TOLERANCE ? 'ahead' : delta < -PACE_TOLERANCE ? 'behind' : 'even';
  return {elapsedPercent: elapsed, deltaPoints: delta, state};
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

// ── Durable usage warehouse (mirrors lib/pure.js; tests/fixtures/warehouse.json) ─
// The forecast history above is a rolling 6-hour window in a temp file. The
// panels also keep 90 days of poll samples in one JSONL file; reading it is how
// this tool can answer "is this week worse than last". Read-only here - the
// desktop clients are the writers.

export const WAREHOUSE_KEEP_DAYS = 90;

export function warehousePath() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(), 'Library', 'Application Support', 'claude-usage-panel', 'history.jsonl');
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'claude-usage-panel', 'history.jsonl');
}

// Unreadable lines are skipped, never fatal: several processes append here, so
// a torn last line is normal.
export function parseWarehouse(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (Number.isFinite(o?.t) && o.limits && typeof o.limits === 'object') {
        out.push({t: o.t, limits: o.limits});
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** Peak of one limit over the last 7 days against the 7 before that. */
export function weekOverWeek(entries, key, nowMs = Date.now()) {
  const week = 7 * 86_400_000;
  let thisWeek = null;
  let lastWeek = null;
  for (const e of entries ?? []) {
    const p = e?.limits?.[key];
    if (!Number.isFinite(p)) continue;
    const age = nowMs - e.t;
    if (age < 0 || age >= 2 * week) continue;
    if (age < week) thisWeek = thisWeek === null ? p : Math.max(thisWeek, p);
    else lastWeek = lastWeek === null ? p : Math.max(lastWeek, p);
  }
  if (thisWeek === null) return null;
  return {
    thisWeekPeak: thisWeek,
    lastWeekPeak: lastWeek,
    deltaPoints: lastWeek === null ? null : thisWeek - lastWeek,
  };
}

/** Attach `trend` to every card the warehouse has samples for. */
export function withTrend(cards, {nowMs = Date.now(), warehouse = warehousePath()} = {}) {
  let entries = [];
  try {
    entries = parseWarehouse(fs.readFileSync(warehouse, 'utf8'));
  } catch {
    return cards; // no warehouse yet - the panels write it, this only reads
  }
  return cards.map((c) => {
    const trend = weekOverWeek(entries, c.key, nowMs);
    return trend ? {...c, trend} : c;
  });
}

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
    // vsClock needs no history at all - it is the reset time against the
    // window length - so it is attached even on the very first call.
    const vsClock = clockPace(c, nowMs);
    return {...c, ...(fc ? {pace: fc} : {}), ...(vsClock ? {vsClock} : {})};
  });
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
 * ~/.claude/.credentials.json (or under CLAUDE_CONFIG_DIR - the same path the
 * account store uses); on macOS, Claude Code stores it in the login Keychain,
 * so we fall back to `security find-generic-password`.
 */
export function readAccessToken({
  homedir = os.homedir(), platform = process.platform, env = process.env,
} = {}) {
  try {
    const raw = fs.readFileSync(credentialsPath({homedir, env}), 'utf8');
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
    return {ok: true, cards: normalizeUsage(raw), extraUsage: normalizeExtraUsage(raw), raw};
  } catch (e) {
    return {ok: false, code: 'parse_error', message: e.message};
  }
}

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
      return {tools: [GET_USAGE_TOOL, ...ACCOUNT_TOOLS]};
    case 'tools/call': {
      const name = msg.params?.name;
      const store = openStore(deps.accountsIo);
      if (ACCOUNT_TOOL_NAMES.has(name)) {
        try {
          return await callAccountTool(name, msg.params?.arguments, store);
        } catch (e) {
          return {content: [{type: 'text', text: e.message}], isError: true};
        }
      }
      if (name !== 'get_usage')
        throw new RpcError(-32602, `Unknown tool: ${name}`);
      const result = await fetchUsage(deps);
      if (!result.ok)
        return {content: [{type: 'text', text: `${result.code}: ${result.message}`}], isError: true};
      const cards = withTrend(withPace(result.cards, deps.paceOpts), deps.trendOpts);
      const lastPing = readLastPing(deps.pingOpts);
      const sessions = refreshSessions(deps.sessionOpts);
      const extraUsage = result.extraUsage ?? null;
      const account = currentAccount(store);
      return {
        content: [{
          type: 'text',
          text: [
            renderAccount(account), renderCards(cards), renderExtraUsage(extraUsage),
            renderPing(lastPing), renderSessions(sessions),
          ].filter(Boolean).join('\n\n'),
        }],
        structuredContent: {account, limits: cards, extraUsage, lastPing, sessions},
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
