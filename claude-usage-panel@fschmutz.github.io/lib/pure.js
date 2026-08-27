// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Shared by the extension (extension.js / claudeUsage.js / cursorUsage.js).

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

function normalizeLimit(entry) {
    let label = KIND_LABELS[entry.kind] ?? entry.kind;
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

// ── Session-window planner ──────────────────────────────────────────────────
// Twin of ClaudeUsageCore/WindowPlanner.swift, kept identical by
// tests/fixtures/window-plan.json (asserted from both ports).
//
// Claude's 5-hour window is anchored to your first message, not the clock, so a
// 09:00 start fits only two full windows into a 09:00-18:00 day and the second
// runs out mid-afternoon. `install.sh sessionping` schedules pings; this
// decides WHEN, instead of making the user guess. It does not raise quota - it
// lines the windows up with the hours actually worked.

export const WINDOW_MINUTES = 5 * 60;

export function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

export function formatHHMM(minute) {
    const m = ((minute % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function coveragePercent(covered, day) {
    const len = day.endMinute - day.startMinute;
    return len > 0 ? Math.round((covered / len) * 100) : 0;
}

function summarize(pingTimes, coverage, day) {
    return (
        `${pingTimes.join(' ')} · ${coverage}% of ` +
        `${formatHHMM(day.startMinute)}-${formatHHMM(day.endMinute)} covered`
    );
}

/**
 * Plan `count` back-to-back windows across a working day.
 * A ping inside an already-open window is wasted (the window stays anchored to
 * its own first message), so the only real choice is where the FIRST one goes.
 */
export function planWindows(day, count = 2) {
    const dayLen = day.endMinute - day.startMinute;
    // More windows than the day can use is meaningless: the extras start after
    // the day is over (and used to wrap past midnight). Cap at the number it
    // takes to blanket the working day.
    const useful = Math.max(1, Math.ceil(dayLen / WINDOW_MINUTES));
    const n = Math.max(1, Math.min(count, useful));
    const span = n * WINDOW_MINUTES;
    let first = span >= dayLen ? day.endMinute - span : day.startMinute;
    first = Math.max(0, Math.min(first, day.startMinute));

    const windows = [];
    let covered = 0;
    for (let i = 0; i < n; i++) {
        const open = first + i * WINDOW_MINUTES;
        const close = open + WINDOW_MINUTES;
        const overlap = Math.max(
            0,
            Math.min(close, day.endMinute) - Math.max(open, day.startMinute),
        );
        covered += overlap;
        windows.push({openMinute: open, usefulMinutes: overlap});
    }
    const pingTimes = windows.map((w) => formatHHMM(w.openMinute));
    const coveredMinutes = Math.min(covered, dayLen);
    const pct = coveragePercent(coveredMinutes, day);
    return {pingTimes, windows, coveredMinutes, coveragePercent: pct, summary: summarize(pingTimes, pct, day)};
}

/**
 * Coverage of a schedule the user already has, so the UI can say
 * "yours covers 56%, this would cover 100%". Overlapping windows are unioned,
 * never summed - a naive sum ranks a redundant schedule above a spread one.
 */
export function evaluateWindows(pingTimes, day) {
    const opens = pingTimes
        .map(parseHHMM)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
    if (!opens.length) return null;

    const windows = [];
    const merged = [];
    for (const open of opens) {
        const close = open + WINDOW_MINUTES;
        const overlap = Math.max(
            0,
            Math.min(close, day.endMinute) - Math.max(open, day.startMinute),
        );
        windows.push({openMinute: open, usefulMinutes: overlap});
        const lo = Math.max(open, day.startMinute);
        const hi = Math.min(close, day.endMinute);
        if (hi <= lo) continue;
        const last = merged[merged.length - 1];
        if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
    }
    const coveredMinutes = merged.reduce((a, [lo, hi]) => a + (hi - lo), 0);
    const times = opens.map(formatHHMM);
    const pct = coveragePercent(coveredMinutes, day);
    return {pingTimes: times, windows, coveredMinutes, coveragePercent: pct, summary: summarize(times, pct, day)};
}
