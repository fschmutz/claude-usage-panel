// The session board: "Waiting on you", "Pause / resume" and "Today's
// sessions" joined into one row per Claude Code session, for the dropdown's
// merged and tabbed layouts (setting `sessions-layout` / `sessionsLayout`).
// Each section still reads its own source; this only joins what they read,
// keyed by session id, and says what a row shows and when the board shows.
// Mirrored by ClaudeUsageCore/SessionBoard.swift and pinned by
// tests/fixtures/board.json.

import {num} from './json.js';

/** The layouts the setting takes; anything else reads as the default. */
export const SESSIONS_LAYOUTS = ['merged', 'tabs', 'separate'];
export const DEFAULT_SESSIONS_LAYOUT = 'merged';

/** The tabs of the tabbed layout, in order. */
export const BOARD_TABS = ['waiting', 'live', 'today'];

/** A stored layout value, or the default for anything unknown. */
export function sessionsLayout(value) {
    return SESSIONS_LAYOUTS.includes(value) ? value : DEFAULT_SESSIONS_LAYOUT;
}

const RANK = {waiting: 0, live: 1, ended: 2};

const text = v => (typeof v === 'string' ? v : '');
const posInt = v => (Number.isInteger(v) && v > 0 ? v : null);
// UTF-16 code-unit order (what `<` on two strings does); the Swift twin
// compares `utf16` for the same answer.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One row per session id, from the three sections' own rows. A section that
 * is off passes nothing: the board then simply knows less. A session is
 * running when a section saw its process (a pid); a row only today's index
 * knows is `ended`.
 *
 * @param {object} input
 * @param {Array<{sessionId, pid, name, cwd, reason, at, age}>} input.waiting
 *   waitingList() rows
 * @param {Array<{sessionId, pid, name, cwd, state, via, reason}>} input.pause
 *   pauseRows() targets + others (pid null when not running)
 * @param {Array<{sessionId, cwd, label, tokens, when, lastMs}>} input.today
 *   rankSessions() rows
 * @returns {{rows: object[], counts: {waiting: number, live: number, today: number}}}
 *   rows: {sessionId, name, cwd, pid, status ('waiting' | 'live' | 'ended'),
 *   waiting: {reason, age, at} | null, pause: {state, via, reason} | null,
 *   today: {tokens, when, lastMs, label} | null}. Waiting first (oldest wait
 *   first), then live, then ended; live and ended by today's tokens, then
 *   name, then id.
 */
export function sessionBoard({waiting = [], pause = [], today = []} = {}) {
    const byId = new Map();
    const row = id => {
        let r = byId.get(id);
        if (!r) {
            r = {sessionId: id, name: '', cwd: '', pid: null, waiting: null, pause: null, today: null};
            byId.set(id, r);
        }
        return r;
    };
    const each = (list, fn) => {
        for (const s of Array.isArray(list) ? list : []) {
            if (s && typeof s.sessionId === 'string' && s.sessionId !== '')
                fn(s, row(s.sessionId));
        }
    };
    each(today, (s, r) => {
        r.name ||= text(s.label);
        r.cwd ||= text(s.cwd);
        r.today = {tokens: num(s.tokens) ?? 0, when: text(s.when), lastMs: num(s.lastMs) ?? 0, label: text(s.label)};
    });
    // A live name beats today's title: it is what the tab is called.
    each(pause, (s, r) => {
        r.name = text(s.name) || r.name;
        r.cwd ||= text(s.cwd);
        r.pid = posInt(s.pid) ?? r.pid;
        r.pause = typeof s.state === 'string' && s.state
            ? {state: s.state, via: text(s.via) || null, reason: text(s.reason) || null} : null;
    });
    each(waiting, (s, r) => {
        r.name = text(s.name) || r.name;
        r.cwd ||= text(s.cwd);
        r.pid = posInt(s.pid) ?? r.pid;
        r.waiting = {reason: text(s.reason), age: text(s.age), at: num(s.at) ?? 0};
    });
    const rows = [...byId.values()].map(r => ({
        ...r,
        name: r.name || r.sessionId.slice(0, 8),
        status: r.waiting ? 'waiting' : r.pid !== null ? 'live' : 'ended',
    }));
    const tokens = r => r.today?.tokens ?? 0;
    rows.sort((a, b) => RANK[a.status] - RANK[b.status]
        || (a.status === 'waiting' ? a.waiting.at - b.waiting.at : 0)
        || tokens(b) - tokens(a)
        || cmp(a.name, b.name)
        || cmp(a.sessionId, b.sessionId));
    return {
        rows,
        counts: {
            waiting: rows.filter(r => r.status === 'waiting').length,
            live: rows.filter(r => r.pid !== null).length,
            today: rows.filter(r => r.today).length,
        },
    };
}

/** The rows one tab shows: waiting, every running session (waiting
 *  included), or every session with work today. */
export function boardTab(rows, tab) {
    if (tab === 'waiting')
        return rows.filter(r => r.status === 'waiting');
    if (tab === 'live')
        return rows.filter(r => r.pid !== null);
    return rows.filter(r => r.today);
}

/** The tab to open on: the remembered one when it still has rows, else the
 *  first tab that has any (waiting first), else the remembered one. */
export function boardDefaultTab(counts, remembered = null) {
    if (BOARD_TABS.includes(remembered) && counts[remembered] > 0)
        return remembered;
    return BOARD_TABS.find(t => counts[t] > 0) ?? (BOARD_TABS.includes(remembered) ? remembered : 'waiting');
}

/**
 * What a row says after its name, as typed parts in display order; each
 * port words them (and translates). The wait, then the pause state, then
 * "running" for a live row with neither, then today's tokens.
 * @returns {Array<{kind: 'waiting', reason, age} | {kind: 'pause', state, via, reason}
 *   | {kind: 'running'} | {kind: 'today', tokens, when}>}
 */
export function boardMetaParts(row) {
    const parts = [];
    if (row.waiting)
        parts.push({kind: 'waiting', reason: row.waiting.reason, age: row.waiting.age});
    if (row.pause)
        parts.push({kind: 'pause', ...row.pause});
    if (!parts.length && row.status === 'live')
        parts.push({kind: 'running'});
    if (row.today)
        parts.push({kind: 'today', tokens: row.today.tokens, when: row.today.when});
    return parts;
}

/** Whether the board shows at all: not in the separate layout, and only
 *  with a row or a pause request to show. */
export function boardVisible(layout, rows, pauseRequest = null) {
    return sessionsLayout(layout) !== 'separate' && (rows.length > 0 || Boolean(pauseRequest));
}
