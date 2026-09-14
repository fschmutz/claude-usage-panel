// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

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
