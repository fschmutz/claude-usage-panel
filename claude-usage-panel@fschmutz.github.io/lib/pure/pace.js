// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {clampPercent} from './usage.js';

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

// Round half toward +infinity, written out so every port computes the same
// thing: Swift's default `.rounded()` sends -0.5 away from zero, and a margin
// of whole minutes lands on an exact negative half-tenth one gap in six (3
// min early is -0.05 h). floor(x + 0.5) also never yields -0.
export function roundHalfUp(x, decimals = 0) {
    const k = 10 ** decimals;
    return Math.floor(x * k + 0.5) / k;
}

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
        ? roundHalfUp((projected - resetMs) / 3600_000, 1) : null;
    return {
        pctPerHour: Math.round(slope * 100) / 100,
        projectedFullAt: new Date(projected).toISOString(),
        exhaustsBeforeReset: margin !== null && margin < 0,
        marginHours: margin,
    };
}

// How far ahead of the reset a limit runs out: "1d10h", "8h", "<1h". The lead
// is rounded to whole hours BEFORE the day split, so 47.6 h reads "2d0h", never
// "1d24h"; under half an hour it is "<1h", never "0h before reset". Part of
// the forecast contract (tests/fixtures/forecast.json `leads`).
export function forecastLead(marginHours) {
    const total = roundHalfUp(Math.abs(marginHours));
    if (!Number.isFinite(total) || total < 1)
        return '<1h';
    const dd = Math.floor(total / 24);
    const hh = total % 24;
    return dd > 0 ? `${dd}d${hh}h` : `${hh}h`;
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
    return `${pace} - full ~${day} ${hm}, ${forecastLead(fc.marginHours)} before reset`;
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
