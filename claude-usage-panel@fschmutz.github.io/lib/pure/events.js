// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {alertThreshold} from './usage.js';
// The event hooks quote the substituted values the same way a resume
// command does - one POSIX quoting helper, owned by the sessions block.
import {shellQuote} from './sessions.js';

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
