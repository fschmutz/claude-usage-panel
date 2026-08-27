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
    'projected 100% instant, and whether that lands before the reset.',
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
      return {
        content: [{type: 'text', text: renderCards(cards)}],
        structuredContent: {limits: cards},
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
