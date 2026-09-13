// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Shared by the extension (extension.js / claudeUsage.js / cursorUsage.js).

// The event hooks quote the substituted values the same way a resume
// command does - one POSIX quoting helper, owned by the sessions block.
import {shellQuote} from './pure/sessions.js';

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
    if (group)
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

function normalizeLimit(entry) {
    let label = kindLabel(entry.kind);
    const model = entry.scope?.model?.display_name;
    if (model)
        label = `${label} · ${model}`;
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
    if (Array.isArray(payload?.limits) && payload.limits.length) {
        return inheritPooledResets(payload.limits.map(normalizeLimit))
            .sort((a, b) => {
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

// Render a history array (percentages) as a unicode sparkline.
export function sparkline(history) {
    if (!history || history.length < 2)
        return '';
    return history.map(p => {
        const i = Math.max(0, Math.min(8, Math.round((p / 100) * 8)));
        return SPARK_BLOCKS[i];
    }).join('');
}

// "Resets in 3h 06m" / "Resets in 4d 2h". nowMs is injectable for tests.
export function formatResets(iso, nowMs = Date.now()) {
    if (!iso)
        return '';
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    let delta = Math.floor((target - nowMs) / 1000);
    if (delta <= 0)
        return 'Resetting…';
    const d = Math.floor(delta / 86400);
    delta %= 86400;
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    let span;
    if (d > 0)
        span = `${d}d ${h}h`;
    else if (h > 0)
        span = `${h}h ${String(m).padStart(2, '0')}m`;
    else
        span = `${m}m`;
    return `Resets in ${span}`;
}

// Threshold a limit crossed (0 / 90 / 100), for alert logic.
export function alertThreshold(percent) {
    return percent >= 100 ? 100 : (percent >= 90 ? 90 : 0);
}

// ── Usage against the clock ─────────────────────────────────────────────────
// The payload dates every reset but never says when the window OPENED, so the
// window length comes from the group: 5 h for a session, 7 days for a weekly.
// elapsed = 1 − remaining/length. Burning ahead of the clock is the reading the
// forecast cannot give at a glance - a pace of 0 %/h right now still runs out
// early when the window is already mostly spent, and a steep pace in the first
// ten minutes of a fresh window is nothing to act on. Part of the shared
// cross-port contract (Model.swift / statusline.js / mcp/server.js mirror it;
// tests/fixtures/pace.json pins the numbers).

export const WINDOW_MS = {session: 5 * 3600_000, weekly: 7 * 86400_000};

// Points of divergence below which used ≈ elapsed. Under it every card would
// flicker between ahead and behind on rounding alone.
export const PACE_TOLERANCE = 5;

/**
 * How much of a limit's window has already gone, 0..100, or null when it can't
 * be known (no reset, or a group with no defined window length).
 */
export function elapsedPercent(card, nowMs = Date.now()) {
    const span = WINDOW_MS[card?.group];
    if (!span || !card?.resetsAt)
        return null;
    const reset = Date.parse(card.resetsAt);
    if (!Number.isFinite(reset))
        return null;
    const ratio = 1 - (reset - nowMs) / span;
    return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/**
 * Usage measured against the clock.
 * @returns {?{elapsedPercent: number, deltaPoints: number,
 *             state: 'ahead'|'even'|'behind'}}
 *   deltaPoints is percent − elapsed: positive means the quota is going faster
 *   than the window it lives in. null whenever the window is unknown.
 */
export function clockPace(card, nowMs = Date.now()) {
    const elapsed = elapsedPercent(card, nowMs);
    if (elapsed === null)
        return null;
    const delta = clampPercent(card.percent) - elapsed;
    const state = delta > PACE_TOLERANCE ? 'ahead'
        : (delta < -PACE_TOLERANCE ? 'behind' : 'even');
    return {elapsedPercent: elapsed, deltaPoints: delta, state};
}

// "62% of the window gone - 18 pts ahead of the clock". Only the ahead case is
// worth a sub-line; even and behind are the normal state of a healthy window.
export function formatClockPace(pace) {
    if (!pace || pace.state !== 'ahead')
        return '';
    return `${pace.elapsedPercent}% of the window gone - ` +
        `${pace.deltaPoints} pts ahead of the clock`;
}

// ── Burn-rate forecast ──────────────────────────────────────────────────────────
// From timestamped percent samples, project when a limit hits 100% at the
// current pace and whether that lands before its reset. Part of the shared
// cross-port contract (Model.swift / statusline.js / mcp/server.js mirror it;
// tests/fixtures/forecast.json pins the numbers).

const FORECAST_WINDOW_MS = 6 * 3600_000; // regress over the last 6 h only
const FORECAST_MIN_SAMPLES = 3;          // never extrapolate from 2 points
const FORECAST_MIN_SPAN_MS = 30 * 60_000; // …or from a burst narrower than 30 min
const FORECAST_MIN_PACE = 0.2;           // %/h below this is idle → no forecast

/**
 * @param {Array<[number, number]>} samples chronological [epochMs, percent]
 * @param {?string} resetsAt ISO reset time of the limit (null → no comparison)
 * @param {number} nowMs injectable clock
 * @returns {?{pctPerHour: number, projectedFullAt: string,
 *            exhaustsBeforeReset: boolean, marginHours: ?number}}
 *   pctPerHour is rounded to 2 decimals; projectedFullAt to the minute;
 *   marginHours (projectedFullAt − reset, 1 decimal) is negative when the limit
 *   runs out BEFORE the reset - that is the alarming case - and null without a
 *   reset to compare to. Returns null whenever an honest projection isn't
 *   possible: too few samples, idle pace, already at 100%.
 */
export function forecast(samples, resetsAt, nowMs) {
    if (!Array.isArray(samples) || !samples.length)
        return null;
    // A percent DROP means the window reset between samples - everything before
    // the drop belongs to the previous window and would poison the slope.
    let start = 0;
    for (let i = samples.length - 1; i > 0; i--) {
        if (samples[i - 1][1] > samples[i][1] + 1) {
            start = i;
            break;
        }
    }
    const win = samples.slice(start)
        .filter(([t]) => Number.isFinite(t) && t > nowMs - FORECAST_WINDOW_MS && t <= nowMs);
    if (win.length < FORECAST_MIN_SAMPLES)
        return null;
    const [t0] = win[0];
    const [tLast, pLast] = win[win.length - 1];
    if (tLast - t0 < FORECAST_MIN_SPAN_MS || pLast >= 100)
        return null;

    // Weighted least squares (weight = recency rank) so the current pace
    // dominates but one burst an hour ago doesn't predict doom all day.
    let sw = 0, swt = 0, swp = 0, swtt = 0, swtp = 0;
    win.forEach(([t, p], i) => {
        const w = i + 1;
        const th = (t - t0) / 3600_000; // hours since window start, keeps numbers small
        sw += w;
        swt += w * th;
        swp += w * p;
        swtt += w * th * th;
        swtp += w * th * p;
    });
    const denom = sw * swtt - swt * swt;
    if (denom === 0)
        return null;
    const slope = (sw * swtp - swt * swp) / denom; // %/h
    if (!Number.isFinite(slope) || slope < FORECAST_MIN_PACE)
        return null;

    const fullMs = tLast + ((100 - pLast) / slope) * 3600_000;
    const projected = Math.round(fullMs / 60_000) * 60_000; // minute precision
    const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
    const margin = Number.isFinite(resetMs)
        ? Math.round(((projected - resetMs) / 3600_000) * 10) / 10 : null;
    return {
        pctPerHour: Math.round(slope * 100) / 100,
        projectedFullAt: new Date(projected).toISOString(),
        exhaustsBeforeReset: margin !== null && margin < 0,
        marginHours: margin,
    };
}

// "↗ 1.8%/h - full ~Sun 03:40, 1d10h before reset" (alarming) or
// "↗ 0.6%/h - lasts past reset" (fine) or "" (no forecast). Weekday+time are
// local, matching the reset countdowns next to it.
export function formatForecast(fc) {
    if (!fc)
        return '';
    const pace = `↗ ${fc.pctPerHour}%/h`;
    if (!fc.exhaustsBeforeReset)
        return fc.marginHours === null ? pace : `${pace} - lasts past reset`;
    const d = new Date(fc.projectedFullAt);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const lead = Math.abs(fc.marginHours);
    const dd = Math.floor(lead / 24);
    const hh = Math.round(lead % 24);
    const span = dd > 0 ? `${dd}d${hh}h` : `${hh}h`;
    return `${pace} - full ~${day} ${hm}, ${span} before reset`;
}

// History entries are stored as [t, p] pairs; entries written by versions that
// stored bare percents migrate as [0, p] - still good for the sparkline, and
// the forecast window (t > now − 6 h) naturally ignores them.
export function normalizeHistory(list) {
    if (!Array.isArray(list))
        return [];
    return list.map(e => Array.isArray(e) ? [Number(e[0]) || 0, clampPercent(e[1])]
        : [0, clampPercent(e)]);
}

// Percent series for the sparkline, from pair-form history.
export function historyPercents(pairs) {
    return (pairs ?? []).map(e => e[1]);
}

// Summarize Cursor /teams/spend rows into cycle spend, limit, %, top, members.
export function summarizeCursorSpend(rows) {
    let cycleCents = 0;
    let limitUSD = 0;
    let top = null;
    for (const r of rows ?? []) {
        const c = r.overallSpendCents ?? r.spendCents ?? 0;
        cycleCents += c;
        limitUSD += r.monthlyLimitDollars ?? 0;
        if (!top || c > top.cents)
            top = {email: r.email ?? r.name ?? '?', cents: c};
    }
    const cycleUSD = cycleCents / 100;
    return {
        cycleUSD,
        limitUSD,
        percent: limitUSD > 0 ? Math.min(100, Math.round((cycleUSD / limitUSD) * 100)) : null,
        topSpender: top ? {email: top.email, usd: top.cents / 100} : null,
        members: (rows ?? []).length,
    };
}

// Sum chargedCents across Cursor usage events → dollars.
export function summarizeCursorToday(events) {
    let cents = 0;
    for (const e of events ?? [])
        cents += e.chargedCents ?? 0;
    return cents / 100;
}

// ── Usage warehouse ─────────────────────────────────────────────────────────
// The forecast history is a rolling 6-hour window in $TMPDIR - it answers "how
// fast right now" and is gone by tomorrow. This is the durable half: one JSONL
// line per poll that MOVED, kept for 90 days under XDG_STATE_HOME, so the panel
// can answer "is this week worse than last". Claude's own history is not
// queryable and the local transcripts are cleaned up after 30 days.
// Twin in Swift (Warehouse.swift); pinned by tests/fixtures/warehouse.json.

export const WAREHOUSE_KEEP_DAYS = 90;

/** One line per poll: the instant, then each limit's percent by key. */
export function warehouseLine(cards, nowMs = Date.now()) {
    const limits = {};
    for (const card of cards ?? [])
        limits[card.key] = clampPercent(card.percent);
    return JSON.stringify({t: Math.round(nowMs), limits});
}

/** Parse a warehouse file. Unreadable lines are skipped, never fatal - the file
 *  is appended to by two processes and a torn last line is normal. */
export function parseWarehouse(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim())
            continue;
        try {
            const o = JSON.parse(line);
            if (Number.isFinite(o?.t) && o.limits && typeof o.limits === 'object')
                out.push({t: o.t, limits: o.limits});
        } catch {
            continue;
        }
    }
    return out;
}

/** Drop what is older than the retention window; the caller rewrites the file
 *  with what comes back. */
export function pruneWarehouse(entries, nowMs = Date.now()) {
    const cutoff = nowMs - WAREHOUSE_KEEP_DAYS * 86_400_000;
    return (entries ?? []).filter(e => e.t >= cutoff);
}

/**
 * Peak of one limit over the last 7 days against the 7 before that.
 * @returns {?{thisWeekPeak: number, lastWeekPeak: ?number, deltaPoints: ?number}}
 *   null when this week has no samples at all. lastWeekPeak is null on a fresh
 *   install - one week of data is still worth showing, without inventing a
 *   comparison for it.
 */
export function weekOverWeek(entries, key, nowMs = Date.now()) {
    const week = 7 * 86_400_000;
    let thisWeek = null;
    let lastWeek = null;
    for (const e of entries ?? []) {
        const p = e?.limits?.[key];
        if (!Number.isFinite(p))
            continue;
        const age = nowMs - e.t;
        if (age < 0 || age >= 2 * week)
            continue;
        if (age < week)
            thisWeek = thisWeek === null ? p : Math.max(thisWeek, p);
        else
            lastWeek = lastWeek === null ? p : Math.max(lastWeek, p);
    }
    if (thisWeek === null)
        return null;
    return {
        thisWeekPeak: thisWeek,
        lastWeekPeak: lastWeek,
        deltaPoints: lastWeek === null ? null : thisWeek - lastWeek,
    };
}

// "peak 71% this week · 84% last" - the comparison only when there is one.
export function formatWeekOverWeek(w) {
    if (!w)
        return '';
    return w.lastWeekPeak === null
        ? `peak ${w.thisWeekPeak}% this week`
        : `peak ${w.thisWeekPeak}% this week · ${w.lastWeekPeak}% last`;
}

// ── Event hooks ─────────────────────────────────────────────────────────────
// A command the user asks to be run when a limit crosses 90/100 % or when a
// window rolls over. The panel already knows both moments; without a hook they
// are only ever a notification nobody can act on. Twin in Swift (PollSchedule's
// neighbour in WindowPlanner.swift); pinned by tests/fixtures/events.json.

/**
 * What changed between two polls, as events worth running a command for.
 * @returns {Array<{event: 'threshold'|'reset', key: string, label: string,
 *                  percent: number, threshold: number}>}
 *   A reset is a percent DROP - the window rolled over. A threshold is an
 *   upward crossing of 90 or 100; crossing both in one poll reports the higher
 *   one only, since that is the state the limit is now in.
 */
export function detectEvents(previous, current) {
    const before = new Map((previous ?? []).map(c => [c.key, c]));
    const events = [];
    for (const card of current ?? []) {
        const prev = before.get(card.key);
        if (!prev)
            continue;
        // 1 point of slack: the endpoint rounds, and a 1-point wobble downward
        // is not a new window.
        if (card.percent < prev.percent - 1) {
            events.push({
                event: 'reset', key: card.key, label: card.label,
                percent: card.percent, threshold: 0,
            });
            continue;
        }
        const crossed = alertThreshold(card.percent);
        if (crossed > alertThreshold(prev.percent)) {
            events.push({
                event: 'threshold', key: card.key, label: card.label,
                percent: card.percent, threshold: crossed,
            });
        }
    }
    return events;
}

/**
 * Substitute an event into the user's command template. Every value is
 * shell-quoted on the way in: the label comes from the API, and a command
 * built by pasting it in raw is a command the API gets to write.
 *   %e event   %k key   %l label   %p percent   %t threshold   %% literal %
 */
export function expandEventCommand(template, event) {
    if (!template || !event)
        return '';
    const values = {
        e: event.event, k: event.key, l: event.label,
        p: String(event.percent), t: String(event.threshold ?? 0),
    };
    return String(template).replace(/%(.)/g, (whole, ch) => {
        if (ch === '%')
            return '%';
        return ch in values ? shellQuote(values[ch]) : whole;
    });
}

// ── Adaptive polling ────────────────────────────────────────────────────────
// A fixed interval polls hardest exactly when nothing is happening. Three rules,
// shared with WindowPlanner's twin in Swift and pinned by tests/fixtures/poll.json:
//   1. Nothing moved for a few polls → back off, up to POLL_IDLE_MAX.
//   2. A reset inside the next delay → land just after it instead, so the fresh
//      window shows up as a number and not as a stale card.
//   3. Never poll faster than the configured base, whatever else is true.

export const POLL_IDLE_AFTER = 3;              // unchanged polls before backing off
export const POLL_IDLE_FACTOR = 4;
export const POLL_IDLE_MAX_SECONDS = 15 * 60;
export const POLL_RESET_LAG_SECONDS = 5;       // land just PAST the reset, never on it

/**
 * Seconds to wait before the next poll.
 * @param {{baseSeconds: number, idleStreak: number, nextResetMs: ?number,
 *          nowMs: number}} o
 *   idleStreak counts consecutive polls where no limit moved.
 */
export function nextPollSeconds({baseSeconds, idleStreak = 0, nextResetMs = null,
    nowMs = Date.now()}) {
    const base = Math.max(60, Math.round(Number(baseSeconds) || 60));
    let delay = base;
    if (idleStreak >= POLL_IDLE_AFTER)
        delay = Math.min(POLL_IDLE_MAX_SECONDS, base * POLL_IDLE_FACTOR);
    if (Number.isFinite(nextResetMs)) {
        const untilReset = Math.ceil((nextResetMs - nowMs) / 1000) + POLL_RESET_LAG_SECONDS;
        // Only pull the poll EARLIER, and never below the base rate: a reset
        // 20 s away must not turn into a 20 s polling loop.
        if (untilReset >= base && untilReset < delay)
            delay = untilReset;
    }
    return delay;
}

/** Soonest reset among the cards, in epoch ms, or null when none has one. */
export function nextResetMs(cards) {
    let soonest = null;
    for (const card of cards ?? []) {
        const t = card?.resetsAt ? Date.parse(card.resetsAt) : NaN;
        if (Number.isFinite(t) && (soonest === null || t < soonest))
            soonest = t;
    }
    return soonest;
}

/** True when no limit moved between two polls - what idleStreak counts. */
export function sameUsage(previous, current) {
    const a = previous ?? [];
    const b = current ?? [];
    if (a.length !== b.length)
        return false;
    return a.every((card, i) => card.key === b[i].key && card.percent === b[i].percent);
}

// ── The rest of the contract lives in lib/pure/ - one file per concern ──────────
// Re-exported here so every importer keeps one path: lib/pure.js.
export * from './pure/pings.js';
export * from './pure/sessions.js';
export * from './pure/accounts.js';
