// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {alertThreshold} from './usage.js';
// The event hooks quote the substituted values the same way a resume
// command does - one POSIX quoting helper, owned by the sessions block.
import {shellQuote} from './sessions.js';

// ── Event hooks ─────────────────────────────────────────────────────────────
// A command the user asks to be run when a limit crosses 90/100 % or when a
// window rolls over. The panel already knows both moments; without a hook they
// are only ever a notification nobody can act on. Twin in Swift
// (ClaudeUsageCore/EventHooks.swift); pinned by tests/fixtures/events.json.

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

// ── Notification latches ────────────────────────────────────────────────────
// A limit notification fires ONCE per window, not on every poll that still
// reads 95 %. Twin of Swift's AlertLatch (ClaudeUsageCore/EventHooks.swift);
// both are pinned by tests/fixtures/alerts.json.

/** Below this, a limit that had crossed 90 is back in a new window. */
export const ALERT_REARM_BELOW = 85;

/**
 * The limit crossings to announce for this poll, in card order. `fired` maps
 * each limit key to the highest bucket already announced and is updated in
 * place: it is the latch's whole state, kept by the caller between polls. It
 * re-arms only once usage has clearly dropped back (a fresh window), not on a
 * one-point wobble around the threshold.
 * @param {Map<string, number>} fired
 * @param {object[]} cards
 * @returns {Array<{card: object, threshold: number}>}
 */
export function latchCrossings(fired, cards) {
    const out = [];
    for (const card of cards ?? []) {
        const prev = fired.get(card.key) ?? 0;
        const threshold = alertThreshold(card.percent);
        if (threshold > prev) {
            fired.set(card.key, threshold);
            out.push({card, threshold});
        } else if (threshold < prev && card.percent < ALERT_REARM_BELOW) {
            fired.set(card.key, threshold);
        }
    }
    return out;
}

/** The pace alert fires once the forecast runs dry this many hours (or more) before the reset. */
export const PACE_ALERT_MARGIN_HOURS = -1;
/** ...and re-arms only once the projection clears the reset by this margin. */
export const PACE_REARM_MARGIN_HOURS = 2;

/**
 * The limits whose burn rate now projects them running dry at least an hour
 * before their reset, once per window. `alerted` holds the keys already
 * warned about and is updated in place. A key re-arms only when its forecast
 * goes away or clears the reset by 2 h, so a pace hovering at the edge cannot
 * ping-pong notifications.
 * @param {Set<string>} alerted
 * @param {object[]} cards
 * @param {Map<string, ?object>} forecasts limit key -> forecast() result
 * @returns {Array<{card: object, forecast: object}>}
 */
export function latchPaceAlerts(alerted, cards, forecasts) {
    const out = [];
    for (const card of cards ?? []) {
        const fc = forecasts.get(card.key) ?? null;
        if (fc?.exhaustsBeforeReset && fc.marginHours <= PACE_ALERT_MARGIN_HOURS) {
            if (!alerted.has(card.key)) {
                alerted.add(card.key);
                out.push({card, forecast: fc});
            }
        } else if (!fc || (!fc.exhaustsBeforeReset
            && (fc.marginHours ?? Infinity) >= PACE_REARM_MARGIN_HOURS)) {
            alerted.delete(card.key);
        }
    }
    return out;
}

// ── After the usage fetch ───────────────────────────────────────────────────
// The dropdown's other sections (session cost, today's sessions, Cursor spend,
// saved accounts) do not need the Claude token, and the account switcher is
// the very fix for an expired one, so they refresh after every poll, failed or
// not. The poll timer re-arms only once they settle, so each one gets a
// deadline: one hung child process must never stop the panel polling.

/** How long one section may take before the poll stops waiting for it. */
export const SECTION_DEADLINE_MS = 90_000;

/**
 * The cards the account section should treat as the live login's usage: the
 * fresh ones, the last reading while a "not now" failure keeps it on screen,
 * else none (usage unknown - no figures, no auto-switch decision from them).
 */
export function sectionCards(result, latest) {
    if (result?.ok)
        return result.cards ?? [];
    if (result?.code === 'transient' && latest?.length)
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
