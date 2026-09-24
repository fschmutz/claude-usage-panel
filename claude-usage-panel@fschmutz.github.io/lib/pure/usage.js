// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Usage normalization, severity, resets, alerts ─────────────────────────────
// The GNOME copy of the shared contract (Model.swift / claude-code/normalize.js
// mirror it; tests/fixtures/normalize.json + extra-usage.json pin the numbers).

const KIND_LABELS = {
    session: 'Current session',
    weekly_all: 'Weekly · all models',
    weekly_scoped: 'Weekly',
    weekly_oauth_apps: 'Weekly · apps',
};
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped', 'weekly_oauth_apps'];

const SPARK_BLOCKS = ' ▁▂▃▄▅▆▇█';

export function clampPercent(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

export function severityClass(severity) {
    if (severity === 'critical')
        return 'cu-critical';
    if (severity === 'warning')
        return 'cu-warning';
    return 'cu-normal';
}

// Which pool a limit draws from. The API sends `group` ("session" / "weekly");
// payloads that predate it are grouped by the kind prefix instead.
function groupOf(kind, group) {
    if (typeof group === 'string' && group)
        return group;
    return String(kind).startsWith('weekly') ? 'weekly' : String(kind);
}

// A label for a kind we have no entry for. The endpoint keeps adding kinds
// (seven_day_cowork, seven_day_omelette and friends are already in the payload
// as null placeholders); rendering the raw key is how a new one shows up as
// `weekly_cowork` in the UI for however long it takes anyone to notice.
export function kindLabel(kind) {
    const known = KIND_LABELS[kind];
    if (known)
        return known;
    const k = String(kind ?? '');
    const words = w => w.replace(/_/g, ' ').trim();
    if (k.startsWith('weekly_'))
        return `Weekly · ${words(k.slice(7))}`;
    if (k.startsWith('session_'))
        return `Session · ${words(k.slice(8))}`;
    return words(k) || 'Limit';
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
    if (model)
        label = `${label} · ${model}`;
    return {
        key: kind + (model ? `:${model}` : ''),
        label,
        group: groupOf(kind, entry?.group),
        scoped: Boolean(model),
        percent: clampPercent(num(entry?.percent) ?? 0),
        severity: SEVERITIES.includes(entry?.severity) ? entry.severity : 'normal',
        resetsAt: str(entry?.resets_at),
        active: entry?.is_active === true,
    };
}

// A scoped (per-model) limit is a sub-cap ON its group's pooled limit, not a
// pool of its own: Fable usage counts toward `weekly_all` and shares its reset.
// The API leaves the scoped `resets_at` null until that model is used in the
// window, so borrow the pooled reset - otherwise the Fable card shows no
// countdown for every week it hasn't been touched yet.
function inheritPooledResets(cards) {
    for (const card of cards) {
        if (!card.scoped || card.resetsAt)
            continue;
        const pooled = cards.find(o => !o.scoped && o.group === card.group && o.resetsAt);
        if (pooled)
            card.resetsAt = pooled.resetsAt;
    }
    return cards;
}

// Extract normalized limit cards from the raw usage payload. Prefers the modern
// `limits[]` array; falls back to legacy five_hour / seven_day fields.
export function normalizeUsage(payload) {
    if (Array.isArray(payload?.limits) && payload.limits.length &&
        payload.limits.every(isObject)) {
        return inheritPooledResets(payload.limits.map(normalizeLimit))
            .sort((a, b) => {
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
            percent: clampPercent(five),
            severity: 'normal', resetsAt: str(payload.five_hour.resets_at), active: true,
        });
    }
    const seven = num(payload?.seven_day?.utilization);
    if (seven !== null) {
        cards.push({
            key: 'weekly_all', label: KIND_LABELS.weekly_all,
            group: 'weekly', scoped: false,
            percent: clampPercent(seven),
            severity: 'normal', resetsAt: str(payload.seven_day.resets_at), active: false,
        });
    }
    return cards;
}

// Sub-line for a scoped (per-model) card. Its percent measures a *share* of the
// weekly pool - on Max, up to 50 % of the weekly allowance may go to Fable - so
// it is never extra headroom: every Fable token also moves `weekly_all`. Say so
// on the card, or a Fable reading of 0 % reads as an untouched second pool.
export function poolNote(card) {
    return card?.scoped && card.group === 'weekly'
        ? 'Share of the weekly all-models limit' : '';
}

// ── Extra usage (prepaid credits beyond the plan) ───────────────────────────
// The payload's `spend` object: money already charged this cycle against the
// cap the account allows. It is NOT one of the limits[] - it has no window and
// no reset - so it stays out of normalizeUsage() and is rendered as its own
// row. Reported only while the account has it switched on; a disabled one is
// noise, not headroom. Mirrored in Model.swift / mcp/server.js, pinned by
// tests/fixtures/extra-usage.json.

function money(obj) {
    const minor = Number(obj?.amount_minor);
    if (!Number.isFinite(minor))
        return null;
    const exp = Number(obj?.exponent);
    return minor / 10 ** (Number.isFinite(exp) ? exp : 2);
}

/** "$12.40", or "12.40 CHF" for anything but USD. */
export function formatMoney(amount, currency = 'USD') {
    if (!Number.isFinite(amount))
        return '';
    const n = amount.toFixed(2);
    return currency === 'USD' ? `$${n}` : `${n} ${currency}`;
}

/**
 * @returns {?{key: string, label: string, percent: number, severity: string,
 *             usedAmount: number, limitAmount: ?number, currency: string,
 *             detail: string}}
 *   null when the account has no extra usage enabled.
 */
export function normalizeExtraUsage(payload) {
    const spend = payload?.spend;
    if (!spend || spend.enabled !== true)
        return null;
    const used = money(spend.used);
    if (used === null)
        return null;
    const limit = money(spend.limit);
    const currency = spend.used?.currency ?? spend.limit?.currency ?? 'USD';
    return {
        key: 'extra_usage',
        label: 'Extra usage',
        percent: clampPercent(spend.percent),
        severity: spend.severity ?? 'normal',
        usedAmount: used,
        limitAmount: limit,
        currency,
        detail: limit !== null
            ? `${formatMoney(used, currency)} of ${formatMoney(limit, currency)}`
            : formatMoney(used, currency),
    };
}

// The sparkline shows the newest SPARK_SAMPLES readings. Part of the shared
// contract: Swift's Sparkline mirrors it, tests/fixtures/sparkline.json pins
// both (including the half-step boundaries, which round up in every port).
export const SPARK_SAMPLES = 12;

// Render a history array (percentages) as a unicode sparkline.
export function sparkline(history) {
    const tail = (history ?? []).slice(-SPARK_SAMPLES);
    if (tail.length < 2)
        return '';
    return tail.map(p => {
        const i = Number.isFinite(p) ? Math.max(0, Math.min(8, Math.round((p / 100) * 8))) : 0;
        return SPARK_BLOCKS[i];
    }).join('');
}

// The reset countdown every client prints, broken into units: whole seconds
// FLOORED (a reset 59 s away is "0m", never "1m"; 23h59m40s is never "1d"),
// then days / hours / minutes. null without a parseable date, {past: true}
// once the reset is due. The status line / MCP (claude-code/stamps.js
// resetHint) and Swift (ResetCountdown) split it the same way;
// tests/fixtures/resets.json pins all three. Only the labels differ per port.
export function resetParts(iso, nowMs = Date.now()) {
    if (!iso)
        return null;
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return null;
    let delta = Math.floor((target - nowMs) / 1000);
    if (delta <= 0)
        return {past: true};
    const d = Math.floor(delta / 86400);
    delta %= 86400;
    return {past: false, d, h: Math.floor(delta / 3600), m: Math.floor((delta % 3600) / 60)};
}

// "Resets in 3h 06m" / "Resets in 4d 2h". nowMs is injectable for tests.
export function formatResets(iso, nowMs = Date.now()) {
    const r = resetParts(iso, nowMs);
    if (!r)
        return '';
    if (r.past)
        return 'Resetting…';
    let span;
    if (r.d > 0)
        span = `${r.d}d ${r.h}h`;
    else if (r.h > 0)
        span = `${r.h}h ${String(r.m).padStart(2, '0')}m`;
    else
        span = `${r.m}m`;
    return `Resets in ${span}`;
}

// Threshold a limit crossed (0 / 90 / 100), for alert logic.
export function alertThreshold(percent) {
    return percent >= 100 ? 100 : (percent >= 90 ? 90 : 0);
}

// Colour class for a percent that carries no API severity (the Cursor spend
// gauge): red from 100, yellow from 90 - the alert buckets, not new ones.
export function thresholdClass(percent) {
    const t = alertThreshold(percent);
    return severityClass(t === 100 ? 'critical' : (t === 90 ? 'warning' : 'normal'));
}

// ── Top-bar readout ─────────────────────────────────────────────────────────────
// The top bar is shared real estate: every other indicator loses the width ours
// takes, so the readout has a hard character budget rather than "whatever the
// strings happen to be". What gives when it does not fit: the percentage never
// (it is the reading), the limit label second, the account name first - and the
// name is all-or-nothing, because half an identity ("PR…") reads as noise and
// the dropdown names the account in full anyway.
export const PANEL_MAX_CHARS = 20;

// "all mod…" - cut to `max` INCLUDING the ellipsis, '' when there is no room.
export function ellipsize(text, max) {
    const s = String(text ?? '').trim();
    if (s.length <= max)
        return s;
    return max < 3 ? '' : `${s.slice(0, max - 1)}…`;
}

// "PRO · Fable 100%" - the panel button's text, from the card the panel picked
// plus the active account name ('' when there is none to show).
export function panelText({account = '', label = '', percent = 0, max = PANEL_MAX_CHARS} = {}) {
    const short = String(label ?? '').split('·').pop().trim();
    const pct = `${clampPercent(percent)}%`;
    const name = String(account ?? '').trim();
    // The limit reading is built at the full budget first; the name is added
    // only if it fits beside it, never by squeezing the label.
    const tail = `${ellipsize(short, Math.max(1, max - pct.length - 1))} ${pct}`.trim();
    return name && name.length + 3 + tail.length <= max ? `${name} · ${tail}` : tail;
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

// ── Plan label ──────────────────────────────────────────────────────────────
// Twin in Swift (ClaudeUsageCore/PlanLabel.swift); pinned by
// tests/fixtures/plan-label.json.

/**
 * The plan the header shows, from the login's own credentials: the usage
 * endpoint names no plan. `subscriptionType` is the plan ("max" -> "Max"),
 * and a `rateLimitTier` ending in a multiplier ("default_claude_max_20x")
 * says which tier of it ("Max 20x"). '' when the login does not say.
 * @param {?object} oauth the `claudeAiOauth` block of .credentials.json
 */
export function planLabel(oauth) {
    const type = typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType.trim() : '';
    if (!type)
        return '';
    const plan = type.charAt(0).toUpperCase() + type.slice(1);
    const tier = typeof oauth.rateLimitTier === 'string'
        ? /_(\d+x)$/.exec(oauth.rateLimitTier)?.[1] : null;
    return tier ? `${plan} ${tier}` : plan;
}
