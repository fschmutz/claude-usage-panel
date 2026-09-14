// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {clampPercent} from './usage.js';

// ── Usage warehouse ─────────────────────────────────────────────────────────
// The forecast history is a rolling 6-hour window in $TMPDIR - it answers "how
// fast right now" and is gone by tomorrow. This is the durable half: one JSONL
// line per poll that MOVED, kept for 90 days under XDG_STATE_HOME, so the panel
// can answer "is this week worse than last". Claude's own history is not
// queryable and the local transcripts are cleaned up after 30 days.
// Twin in Swift (Warehouse.swift); pinned by tests/fixtures/warehouse.json.

export const WAREHOUSE_KEEP_DAYS = 90;

/** One poll as the warehouse keeps it: the instant, then each limit's percent
 *  by key. The in-memory list and the file line are the same object. */
export function warehouseEntry(cards, nowMs = Date.now()) {
    const limits = {};
    for (const card of cards ?? [])
        limits[card.key] = clampPercent(card.percent);
    return {t: Math.round(nowMs), limits};
}

/** One line per poll. */
export function warehouseLine(cards, nowMs = Date.now()) {
    return JSON.stringify(warehouseEntry(cards, nowMs));
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
