// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.
//
// Live Claude Code sessions that are blocked waiting for the user: a
// permission prompt, a question, or idle after Stop. Twin of
// ClaudeUsageCore/Waiting.swift; pinned by tests/fixtures/waiting.json.
//
// Stop marks idle (the turn ended and the prompt is waiting), it does not
// clear. UserPromptSubmit / PreToolUse / SessionEnd clear. Notification
// marks with a more specific reason. Markers for a pid that is not live
// are ignored - the I/O layer hands only live registry rows in.

export const WAITING_REASONS = Object.freeze(['permission', 'question', 'idle']);
export const WAITING_HOOK_EVENTS = Object.freeze([
    'Notification', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'SessionEnd',
]);
const WAITING_MARKER_SUFFIX = '.waiting.json';
export const WAITING_MARKER_VERSION = 1;

const REASON_SET = new Set(WAITING_REASONS);

/** `<pid>.waiting.json` next to Claude Code's `<pid>.json` registry file. */
export function waitingMarkerName(pid) {
    return `${Number(pid)}${WAITING_MARKER_SUFFIX}`;
}

/** The pid a marker filename names, or null when the name is not ours. */
export function pidFromWaitingMarkerName(name) {
    const m = /^(\d+)\.waiting\.json$/.exec(String(name ?? ''));
    return m ? Number(m[1]) : null;
}

/**
 * Why a Notification hook is waiting. Type first, then the message: a
 * permission prompt says so even when the type field is missing, and
 * anything else is a question the user has to answer.
 */
export function reasonFromNotification(payload) {
    const type = String(payload?.notification_type ?? payload?.notificationType ?? '')
        .toLowerCase();
    const message = String(payload?.message ?? '').toLowerCase();
    const text = `${type} ${message}`;
    if (type.includes('permission') || message.includes('permission'))
        return 'permission';
    if (type.includes('idle') || type.includes('timeout') || /\bidle\b/.test(text))
        return 'idle';
    return 'question';
}

/**
 * What a Claude Code hook event does to the waiting marker.
 *   Notification -> mark (permission / question / idle)
 *   Stop         -> mark idle  (the turn ended; the prompt is waiting)
 *   UserPromptSubmit / PreToolUse / SessionEnd -> clear
 * Anything else is ignore, so an unknown event cannot wipe a marker.
 */
export function applyHookEvent(name, payload = {}, nowMs = 0) {
    const event = String(name ?? '');
    if (event === 'SessionEnd' || event === 'UserPromptSubmit' || event === 'PreToolUse')
        return {action: 'clear'};
    if (event === 'Stop')
        return {action: 'mark', reason: 'idle', at: nowMs};
    if (event === 'Notification')
        return {action: 'mark', reason: reasonFromNotification(payload), at: nowMs};
    return {action: 'ignore'};
}

/** A marker object, or null when a field is the wrong JSON type. */
export function parseWaitingMarker(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const sessionId = raw.sessionId;
    const pid = raw.pid;
    const reason = raw.reason;
    const at = raw.at;
    if (typeof sessionId !== 'string' || !sessionId)
        return null;
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    if (!REASON_SET.has(reason))
        return null;
    if (typeof at !== 'number' || !Number.isFinite(at))
        return null;
    return {sessionId, pid, reason, at};
}

/**
 * Compact age, two most significant units, whole seconds floored: "3s",
 * "1m 40s", "5m", "2h", "1d 2h". Empty when the stamp is unreadable.
 */
export function waitingAge(atMs, nowMs) {
    if (!Number.isFinite(atMs) || !Number.isFinite(nowMs))
        return '';
    const sec = Math.max(0, Math.floor((nowMs - atMs) / 1000));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0)
        return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0)
        return m ? `${h}h ${m}m` : `${h}h`;
    if (m > 0)
        return s ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
}

/** English reason word the terminal / MCP / Swift parity use. */
function waitingReasonLabel(reason) {
    return REASON_SET.has(reason) ? reason : '';
}

/**
 * Live sessions that have a waiting marker, oldest wait first.
 * `sessions` is already the live registry (dead pids dropped by I/O).
 * A marker whose pid is not in that list is ignored.
 *
 * @param {object[]} sessions {pid, sessionId, name, cwd}
 * @param {object[]} markers  parseWaitingMarker results (nulls skipped)
 * @param {number} nowMs
 * @returns {Array<{pid, sessionId, name, cwd, reason, at, age, reasonLabel}>}
 */
export function waitingList(sessions, markers, nowMs) {
    const live = new Map();
    for (const s of sessions ?? []) {
        if (!Number.isInteger(s?.pid) || s.pid <= 0)
            continue;
        live.set(s.pid, s);
    }
    const out = [];
    for (const raw of markers ?? []) {
        const marker = raw && raw.reason ? raw : parseWaitingMarker(raw);
        if (!marker)
            continue;
        const session = live.get(marker.pid);
        if (!session)
            continue;
        const name = session.name || session.cwd?.replace(/\/+$/, '').split('/').pop()
            || (session.sessionId ?? '').slice(0, 8) || 'session';
        out.push({
            pid: marker.pid,
            sessionId: session.sessionId ?? marker.sessionId,
            name,
            cwd: session.cwd ?? '',
            reason: marker.reason,
            at: marker.at,
            age: waitingAge(marker.at, nowMs),
            reasonLabel: waitingReasonLabel(marker.reason),
        });
    }
    return out.sort((a, b) => a.at - b.at || a.pid - b.pid);
}

/**
 * How to raise the terminal that holds a live session, from the placement
 * layout.js already recorded (`window` / `tab`) or, without one, the pid.
 * I/O turns this into argv / AppleScript; a `none` plan has nothing to run.
 *
 * @returns {{how: string, id?: string, session?: string, tab?: number, pid?: number}}
 */
export function focusPlan(row) {
    const w = String(row?.window ?? '');
    if (w.startsWith('kitty:'))
        return {how: 'kitty', id: w.slice(6)};
    if (w.startsWith('wezterm:'))
        return {how: 'wezterm', id: w.slice(8)};
    if (w.startsWith('tmux:'))
        return {how: 'tmux', session: w.slice(5), tab: Number.isInteger(row.tab) ? row.tab : null};
    if (w.startsWith('iterm:'))
        return {how: 'iterm', id: w.slice(6), tab: Number.isInteger(row.tab) ? row.tab : null};
    if (w.startsWith('terminal:'))
        return {how: 'terminal', id: w.slice(9), tab: Number.isInteger(row.tab) ? row.tab : null};
    if (Number.isInteger(row?.pid) && row.pid > 0)
        return {how: 'pid', pid: row.pid};
    return {how: 'none'};
}

/**
 * argv attempts that raise the session's terminal, first most exact.
 * AppleScript plans (iterm / terminal) have no argv - I/O writes the script.
 * A pid-only plan tries kitty's pid match (the one layout.js already uses).
 */
export function focusArgv(plan) {
    switch (plan?.how) {
        case 'kitty':
            return ['kitty', '@', 'focus-window', '--match', `id:${plan.id}`];
        case 'wezterm':
            return ['wezterm', 'cli', 'activate-pane', '--window-id', String(plan.id)];
        case 'tmux': {
            const target = plan.tab != null ? `${plan.session}:${plan.tab}` : plan.session;
            return ['tmux', 'select-window', '-t', target];
        }
        case 'pid':
            return ['kitty', '@', 'focus-window', '--match', `pid:${plan.pid}`];
        default:
            return null;
    }
}
