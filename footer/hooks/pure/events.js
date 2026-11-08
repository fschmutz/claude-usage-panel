// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {alertThreshold} from './usage.js';

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

/** The environment variable each placeholder reads. */
const EVENT_VARS = Object.freeze({e: 'CUP_EVENT', k: 'CUP_KEY', l: 'CUP_LABEL', p: 'CUP_PERCENT', t: 'CUP_THRESHOLD'});

/** The values of one event, as the environment the command runs with. */
export function eventEnv(event) {
    if (!event)
        return {};
    return {
        CUP_EVENT: String(event.event), CUP_KEY: String(event.key), CUP_LABEL: String(event.label),
        CUP_PERCENT: String(event.percent), CUP_THRESHOLD: String(event.threshold ?? 0),
    };
}

/**
 * The user's command template with each placeholder turned into a reference
 * to its environment variable (eventEnv), quoted for where it stands: bare
 * `"${CUP_LABEL}"`, inside double quotes `${CUP_LABEL}`, inside single quotes
 * `'"${CUP_LABEL}"'`. No value is ever pasted into the command text, so a
 * label from the API (`$(...)`, a quote, a backtick) is data in every
 * position - shell-quoting the value is not enough once the template puts
 * it inside double quotes.
 *   %e event   %k key   %l label   %p percent   %t threshold   %% literal %
 */
export function expandEventCommand(template, event) {
    if (!template || !event)
        return '';
    const text = String(template);
    let out = '';
    let quote = null; // null | "'" | '"'
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '%' && i + 1 < text.length) {
            const next = text[i + 1];
            const name = EVENT_VARS[next];
            if (next === '%') {
                out += '%';
                i++;
                continue;
            }
            if (name) {
                out += quote === '"' ? `\${${name}}` : quote === "'" ? `'"\${${name}}"'` : `"\${${name}}"`;
                i++;
                continue;
            }
        }
        if (ch === '\\' && quote !== "'" && i + 1 < text.length) {
            out += ch + text[i + 1];
            i++;
            continue;
        }
        if ((ch === '"' || ch === "'") && (quote === null || quote === ch))
            quote = quote === null ? ch : null;
        out += ch;
    }
    return out;
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
const PACE_ALERT_MARGIN_HOURS = -1;
/** ...and re-arms only once the projection clears the reset by this margin. */
const PACE_REARM_MARGIN_HOURS = 2;

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
