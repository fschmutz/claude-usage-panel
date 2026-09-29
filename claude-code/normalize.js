// The Node port of the shared normalization contract: what a raw payload from
// the usage endpoint becomes for every Node client (the MCP server, the
// claudectl CLI). Mirrors lib/pure.js (GNOME) and Model.swift (macOS);
// tests/fixtures/normalize.json + tests/parity.test.js keep the three in step.
// No I/O, no Node built-ins - a pure module.

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
  if (typeof group === 'string' && group) return group;
  return String(kind).startsWith('weekly') ? 'weekly' : String(kind);
}

// A label for a kind we have no entry for - the endpoint keeps adding them.
// Mirrors pure.js kindLabel().
export function kindLabel(kind) {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const k = String(kind ?? '');
  const words = (w) => w.replace(/_/g, ' ').trim();
  if (k.startsWith('weekly_')) return `Weekly · ${words(k.slice(7))}`;
  if (k.startsWith('session_')) return `Session · ${words(k.slice(8))}`;
  return words(k) || 'Limit';
}

// Prepaid credits already charged this cycle. Not a limits[] entry - no window,
// no reset - and reported only while the account has it enabled. Mirrors
// pure.js normalizeExtraUsage(); tests/fixtures/extra-usage.json pins both.
function money(obj) {
  const minor = num(obj?.amount_minor);
  if (minor === null) return null;
  return minor / 10 ** (num(obj?.exponent) ?? 2);
}

export function formatMoney(amount, currency = 'USD') {
  if (!Number.isFinite(amount)) return '';
  const n = amount.toFixed(2);
  return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

export function normalizeExtraUsage(payload) {
  const spend = payload?.spend;
  if (!spend || spend.enabled !== true) return null;
  const used = money(spend.used);
  if (used === null) return null;
  const limit = money(spend.limit);
  const currency = [spend.used?.currency, spend.limit?.currency]
    .find((c) => typeof c === 'string') ?? 'USD';
  return {
    key: 'extra_usage',
    label: 'Extra usage',
    percent: clampPercent(num(spend.percent) ?? 0),
    severity: SEVERITIES.includes(spend.severity) ? spend.severity : 'normal',
    usedAmount: used,
    limitAmount: limit,
    currency,
    detail:
      limit !== null
        ? `${formatMoney(used, currency)} of ${formatMoney(limit, currency)}`
        : formatMoney(used, currency),
  };
}

// The payload is read strictly, the way Model.swift's `as?` casts read it: a
// field of the wrong JSON type counts as absent. Number("42") and Number(null)
// would otherwise turn a string or a null into a reading Swift never shows
// (tests/fixtures/normalize.json pins the malformed shapes).
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' ? v : null);
const SEVERITIES = ['normal', 'warning', 'critical'];
// Swift casts limits[] as [[String: Any]]: one non-object entry fails the
// whole cast and the legacy fields are read instead.
const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function normalizeLimit(entry) {
  const kind = str(entry?.kind) ?? 'unknown';
  let label = kindLabel(kind);
  const model = str(entry?.scope?.model?.display_name);
  if (model) label = `${label} · ${model}`;
  // A limit the payload gave no number for is not a limit at 0 %: the endpoint
  // ships kinds nobody has enabled as null placeholders (see usageReading).
  const percent = num(entry?.percent);
  return {
    key: kind + (model ? `:${model}` : ''),
    label,
    group: groupOf(kind, entry?.group),
    scoped: Boolean(model),
    percent: clampPercent(percent ?? 0),
    percentKnown: percent !== null,
    severity: SEVERITIES.includes(entry?.severity) ? entry.severity : 'normal',
    resetsAt: str(entry?.resets_at),
    active: entry?.is_active === true,
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
  if (Array.isArray(payload?.limits) && payload.limits.length &&
    payload.limits.every(isObject)) {
    return inheritPooledResets(payload.limits.map(normalizeLimit)).sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.key.split(':')[0]);
      const bi = KIND_ORDER.indexOf(b.key.split(':')[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }
  const cards = [];
  const five = num(payload?.five_hour?.utilization);
  if (five !== null) {
    cards.push({
      key: 'session', label: KIND_LABELS.session,
      group: 'session', scoped: false,
      percent: clampPercent(five), percentKnown: true,
      severity: 'normal', resetsAt: str(payload.five_hour.resets_at), active: true,
    });
  }
  const seven = num(payload?.seven_day?.utilization);
  if (seven !== null) {
    cards.push({
      key: 'weekly_all', label: KIND_LABELS.weekly_all,
      group: 'weekly', scoped: false,
      percent: clampPercent(seven), percentKnown: true,
      severity: 'normal', resetsAt: str(payload.seven_day.resets_at), active: false,
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

// ── Honest readings ─────────────────────────────────────────────────────────────
// A percentage is only worth printing while it still describes the window it is
// drawn under. Two things end that: a payload that carried no number for the
// limit (percentKnown: false - the endpoint ships kinds nobody has enabled as
// null placeholders, and "0 %" reads as a full tank), and a window whose reset
// instant has passed (the endpoint keeps the old figure until the next window
// opens). Both give `–`. Mirrors lib/pure/usage.js and Swift `UsageReading`;
// tests/fixtures/reading.json pins all three.

/** What a reading shows in place of a percentage nobody can stand behind. */
export const NO_READING = '–';

/** The window this card measures has already rolled over. Whole seconds
 *  floored, exactly like the reset countdown, so the two never disagree by a
 *  rounding step. */
export function windowRolledOver(resetsAt, nowMs = Date.now()) {
  const target = Date.parse(resetsAt ?? '');
  return Number.isFinite(target) && Math.floor((target - nowMs) / 1000) <= 0;
}

/**
 * @returns {{known: boolean, percent: ?number, fill: number, text: string,
 *            reason: ?('no_reading'|'window_reset')}}
 */
export function usageReading(card, nowMs = Date.now()) {
  const rolledOver = windowRolledOver(card?.resetsAt, nowMs);
  const known = card?.percentKnown !== false && !rolledOver;
  const percent = known ? clampPercent(card?.percent) : null;
  return {
    known,
    percent,
    fill: percent ?? 0,
    text: known ? `${percent}%` : NO_READING,
    reason: known ? null : (rolledOver ? 'window_reset' : 'no_reading'),
  };
}

/**
 * The one card a single-reading surface shows (the GNOME top bar, the macOS
 * menu-bar title, a Linux status bar). `mode` 'session' is the session card
 * (else the first); 'worst' ranks on what the cards may honestly show, so a
 * window that has just reset (it still carries the old percentage) never
 * parks a stale 96 % up top, and a limit with no honest reading only wins
 * when nothing else has one. Ties go to the first card in KIND_ORDER - the
 * fill of every unknown card is 0, so with all of them unknown a tie is
 * certain and must not depend on how a port's max() breaks it. Mirrors
 * Swift `PanelCard.pick`; tests/fixtures/reading.json pins both.
 * @returns {?object} the card, or null when there is none
 */
export function panelCard(cards, mode = 'worst', nowMs = Date.now()) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return null;
  if (mode === 'session') return list.find(c => String(c?.key ?? '').startsWith('session')) ?? list[0];
  const rank = c => {
    const i = KIND_ORDER.indexOf(String(c?.key ?? '').split(':')[0]);
    return i < 0 ? KIND_ORDER.length : i;
  };
  const scored = list.map((card, index) => ({card, index, reading: usageReading(card, nowMs)}));
  const honest = scored.filter(s => s.reading.known);
  const pool = honest.length ? honest : scored;
  return pool.reduce((best, s) => {
    const d = s.reading.fill - best.reading.fill;
    if (d !== 0) return d > 0 ? s : best;
    const r = rank(s.card) - rank(best.card);
    return r < 0 || (r === 0 && s.index < best.index) ? s : best;
  }).card;
}

// ── HTTP failures from the usage endpoint ───────────────────────────────────────
// A bare "HTTP 424" on the card told nobody what the server said; the body
// carries `{error: {type, message}}` and that goes on screen. Statuses that
// mean "not now" (424 Failed Dependency - an upstream of the endpoint failed -
// 408, 425, 429, 5xx) are `transient`: the last good cards stay up instead of
// the whole dropdown blanking on one bad poll.

const TRANSIENT_STATUSES = new Set([408, 424, 425, 429]);

/** True when the status is worth retrying as-is, with the last data kept. */
export function isTransientStatus(status) {
  const s = Number(status);
  return TRANSIENT_STATUSES.has(s) || (s >= 500 && s <= 599);
}

/**
 * The failure record for a non-2xx answer.
 * @param {number} status
 * @param {?object} body the parsed JSON body when there was one
 * @returns {{ok: false, code: 'transient'|'http_error', message: string}}
 *   message: "HTTP 424 failed_dependency: <server message>" - the server's
 *   words when it gave any, the code alone otherwise.
 */
export function httpFailure(status, body = null) {
  const err = body && typeof body === 'object' ? body.error : null;
  const type = typeof err?.type === 'string' && err.type ? err.type : null;
  const text = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : null;
  const detail = [type, text].filter(x => x).join(': ');
  return {
    ok: false,
    code: isTransientStatus(status) ? 'transient' : 'http_error',
    message: detail ? `HTTP ${status} ${detail}` : `HTTP ${status}`,
  };
}

/** What every client says when the endpoint refuses the LIVE login's token.
 *  Clients never write that token, so the only cure is Claude Code's own. */
export const AUTH_EXPIRED_MESSAGE =
  'Claude session expired. Run any Claude Code command to refresh it.';

/**
 * Seconds a Retry-After header asks for, or null when it says nothing usable.
 * The header is either delta-seconds ("120") or an HTTP-date ("Wed, 21 Oct
 * 2015 07:28:00 GMT"); a date already past is 0, never negative.
 * @param {?string} value the raw header
 * @param {number} nowMs
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  // An HTTP-date always names its weekday; a bare number with a sign or a
  // fraction is neither form and must not be read as a date.
  if (!/^[A-Za-z]{3},/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : null;
}

/**
 * The whole non-2xx contract in one call, so no port has to remember which
 * status means what. 401 is the only answer that says the credentials
 * themselves are finished (`signInAgain`: retrying cannot help, and a panel
 * must stop drawing that account's bars as if they were current). 403 is
 * `forbidden`: the token is valid but not allowed this endpoint (a
 * setup-token without the user:profile scope answers permission_error), so
 * no refresh cures it and the server's own words go on screen instead of the
 * refresh hint. The transient statuses keep the last reading up and carry
 * `retryAfterSeconds` when the server sent a usable Retry-After; everything
 * else is a plain failure. `label` names a saved account in the message -
 * without one the 401 message is the live login's and carries the refresh
 * hint.
 *
 * @param {number} status
 * @param {?object} body the parsed JSON body when there was one
 * @param {{label?: ?string, retryAfter?: ?string, nowMs?: number}} [opts]
 * @returns {{ok: false, code: 'auth_expired'|'forbidden'|'transient'|'http_error',
 *            signInAgain: boolean, retryable: boolean, message: string,
 *            retryAfterSeconds?: number}}
 */
export function usageFailure(status, body = null, {label = null, retryAfter = null, nowMs = Date.now()} = {}) {
  const s = Number(status);
  if (s === 401) {
    return {
      ok: false, code: 'auth_expired', signInAgain: true, retryable: false,
      message: label ? `${label}: usage endpoint refused the token` : AUTH_EXPIRED_MESSAGE,
    };
  }
  const failure = httpFailure(s, body);
  const out = {
    ...failure,
    code: s === 403 ? 'forbidden' : failure.code,
    signInAgain: false,
    retryable: failure.code === 'transient',
    message: label ? `${label}: ${failure.message}` : failure.message,
  };
  const wait = out.retryable ? parseRetryAfter(retryAfter, nowMs) : null;
  if (wait !== null) out.retryAfterSeconds = wait;
  return out;
}
