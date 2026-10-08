// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Adaptive polling ────────────────────────────────────────────────────────
// A fixed interval polls hardest exactly when nothing is happening. Three rules,
// shared with WindowPlanner's twin in Swift and pinned by tests/fixtures/poll.json:
//   1. Nothing moved for a few polls → back off, up to POLL_IDLE_MAX.
//   2. A reset inside the next delay → land just after it instead, so the fresh
//      window shows up as a number and not as a stale card.
//   3. Never poll faster than the configured base, whatever else is true -
//      except after a retryable failure (408/424/425/429/5xx, or no network):
//      that poll produced nothing, so the retry comes at POLL_RETRY_SECONDS,
//      one request, instead of leaving a blank or stale panel up for the
//      whole base interval. Consecutive failures double that wait, capped at
//      POLL_IDLE_MAX, and a server's Retry-After is honoured (same cap): a
//      rate-limited endpoint must not be asked again every minute forever.

export const POLL_IDLE_AFTER = 3;              // unchanged polls before backing off
const POLL_IDLE_FACTOR = 4;
const POLL_IDLE_MAX_SECONDS = 15 * 60;
const POLL_RESET_LAG_SECONDS = 5;       // land just PAST the reset, never on it
export const POLL_RETRY_SECONDS = 60;          // after a retryable failure
export const POLL_RETRY_FACTOR = 2;            // per consecutive retryable failure

/**
 * A failure worth retrying soon with the last good reading kept on screen: a
 * "not now" status (usageFailure's `transient`) or a request that never
 * completed (`network_error`: offline, DNS, timeout - the same outage every
 * poll during it hits). Anything else is a real failure and blanks the cards.
 * Swift twin `PollSchedule.isRetryable(code:)`; tests/fixtures/poll.json pins both.
 */
export function isRetryableFailure(result) {
    if (!result || result.ok)
        return false;
    return result.code === 'transient' || result.code === 'network_error';
}

/**
 * Seconds to wait before the next poll.
 * @param {{baseSeconds: number, idleStreak: number, nextResetMs: ?number,
 *          nowMs: number, retry: boolean, retryStreak?: number,
 *          retryAfterSeconds?: ?number}} o
 *   idleStreak counts consecutive polls where no limit moved; retry is true
 *   when the last poll failed retryably, retryStreak how many in a row did
 *   (1 for the first), retryAfterSeconds what its Retry-After asked for.
 */
export function nextPollSeconds({baseSeconds, idleStreak = 0, nextResetMs = null,
    nowMs = Date.now(), retry = false, retryStreak = 1, retryAfterSeconds = null}) {
    const base = Math.max(60, Math.round(Number(baseSeconds) || 60));
    if (retry) {
        const streak = Math.max(1, Math.floor(Number(retryStreak) || 1));
        const backoff = Math.min(POLL_IDLE_MAX_SECONDS,
            POLL_RETRY_SECONDS * POLL_RETRY_FACTOR ** Math.min(streak - 1, 16));
        const asked = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
            ? Math.min(POLL_IDLE_MAX_SECONDS, Math.max(0, Math.ceil(retryAfterSeconds))) : 0;
        return Math.max(backoff, asked);
    }
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

// ── After the usage fetch ───────────────────────────────────────────────────
// The dropdown's other sections (session cost, today's sessions, Cursor spend,
// saved accounts) do not need the Claude token, and the account switcher is
// the very fix for an expired one, so they refresh after every poll, failed or
// not. GNOME only: no Swift twin and no fixture.
// The poll timer re-arms only once they settle, so each one gets a
// deadline: one hung child process must never stop the panel polling.

/** How long one section may take before the poll stops waiting for it. */
export const SECTION_DEADLINE_MS = 90_000;

/**
 * The cards the account section should treat as the live login's usage: the
 * fresh ones, the last reading while a retryable failure keeps it on screen,
 * else none (usage unknown - no figures, no auto-switch decision from them).
 */
export function sectionCards(result, latest) {
    if (result?.ok)
        return result.cards ?? [];
    if (isRetryableFailure(result) && latest?.length)
        return latest;
    return [];
}

/**
 * Run every section refresh side by side and settle once each has finished,
 * failed or run past its deadline. Never rejects.
 * @param {{[name: string]: (cards: object[]) => Promise<unknown>}} sections
 * @param {object} opts
 * @param {{ok: boolean, code?: string, cards?: object[]}} opts.result the poll
 * @param {object[]} opts.latest the last good cards
 * @param {number} [opts.deadlineMs]
 * @param {{setTimeout: Function, clearTimeout: Function}} [opts.timers]
 * @returns {Promise<Array<{section: string, outcome: 'done'|'failed'|'timeout',
 *                          error?: unknown}>>}
 */
export function refreshSections(sections, {
    result, latest, deadlineMs = SECTION_DEADLINE_MS, timers = globalThis,
}) {
    const cards = sectionCards(result, latest);
    return Promise.all(Object.entries(sections).map(([section, refresh]) => {
        let timer = null;
        const deadline = new Promise(resolve => {
            timer = timers.setTimeout(() => resolve({section, outcome: 'timeout'}), deadlineMs);
        });
        const work = Promise.resolve()
            .then(() => refresh(cards))
            .then(() => ({section, outcome: 'done'}), error => ({section, outcome: 'failed', error}));
        return Promise.race([work, deadline]).finally(() => timers.clearTimeout(timer));
    }));
}
