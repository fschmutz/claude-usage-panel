// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Inline notices, button-local outcomes, switch rotation ───────────────────────
// The one JavaScript copy of the shared contract: the GNOME extension and the
// Node CLI / MCP server import it (the Node side uses the health and the
// notices only - no Node client draws a button). ClaudeUsageCore/Notices.swift
// is the Swift twin; tests/fixtures/notices.json pins every leg.
//
// The rule these three share: a problem with a saved login belongs next to that
// login, with the ONE thing that repairs it attached, and the answer to pressing
// that button belongs next to the button. Both used to live in a global error
// line at the bottom of the dropdown (or in the prefs window), which is where a
// message goes to be missed.
//
// Sentences and button labels are deliberately NOT here: they are translated per
// port. What is pinned is which notice appears, in what order, how loud it is,
// and what its single repair action does.

/**
 * How usable a saved login is right now: one of
 * valid          - the stored access token is good as it stands
 * stale          - it is (about to be) expired, and the refresh token can mint
 *                  a new one on next use. Not a problem; not worth a notice.
 * expired        - the refresh token is gone or spent: only a new
 *                  `claude auth login` on that account helps.
 * refresh-failed - the exchange was tried and refused, or the usage endpoint
 *                  turned a STORED token down. The saved credentials are
 *                  finished even though their dates say otherwise, so the UI
 *                  must stop drawing that account's bars as if they were current.
 * unreachable    - nothing is known to be wrong with the login; the reading is
 *                  simply missing (a 429, a 5xx, no network, a live login that
 *                  could not be read, or a live token the endpoint turned down:
 *                  that one is Claude Code's to refresh, not the profile's).
 *
 * `errorCode` is the code the usage result carries ('refresh_failed',
 * 'login_expired', 'auth_expired', 'forbidden', 'transient', 'http_error',
 * 'network_error', 'parse_error', 'no_token'), or null when the fetch worked. `live` is true
 * when the token that was used is the live login's (accessTokenFor source
 * 'live').
 */
export function accountHealth({tokenState = 'stale', errorCode = null, live = false} = {}) {
    if (errorCode === 'refresh_failed' || (errorCode === 'auth_expired' && !live))
        return 'refresh-failed';
    if (errorCode === 'login_expired' || tokenState === 'expired')
        return 'expired';
    if (errorCode)
        return 'unreachable';
    return tokenState === 'valid' ? 'valid' : 'stale';
}

/** A health state the user has to act on - the states that earn a notice row. */
export function needsAttention(health) {
    return health === 'expired' || health === 'refresh-failed';
}

/**
 * What the accounts list must say out loud, each with one repair button.
 *
 * @param {object} state
 * @param {Array<{name: string, health: string}>} state.rows saved accounts, store order
 * @param {?string} state.liveEmail the live login's email, when it has one
 * @param {?string} state.activeName the saved profile the live login is, or null
 * @param {?{from: ?string, to: string}} state.pending an unfinished switch
 * @param {boolean} state.torn the live login's two halves name different profiles
 * @returns {Array<{id: string, kind: string, severity: string, action: string, arg: ?string}>}
 */
export function accountNotices({
    rows = [], liveEmail = null, activeName = null, pending = null, torn = false,
} = {}) {
    const out = [];
    const add = (id, kind, severity, action, arg) => out.push({id, kind, severity, action, arg});
    // Loudest first, and the two that describe the LIVE login before the saved
    // ones: a half-installed switch explains every row under it.
    if (pending?.to)
        add('pending-switch', 'pending-switch', 'critical', 'finish-switch', pending.to);
    if (torn && activeName)
        add('torn-login', 'torn-login', 'warning', 'repair', activeName);
    // A login nobody named survives a switch only because we park it under its
    // email. Saying so beats discovering the parked name afterwards.
    if (!activeName && liveEmail)
        add('unsaved-login', 'unsaved-login', 'warning', 'save', liveEmail);
    for (const row of rows) {
        if (row?.health === 'expired')
            add(`login-expired:${row.name}`, 'login-expired', 'critical', 'relogin', row.name);
        else if (row?.health === 'refresh-failed')
            add(`refresh-failed:${row.name}`, 'refresh-failed', 'critical', 'relogin', row.name);
        else if (row?.health === 'unreachable')
            add(`unreachable:${row.name}`, 'unreachable', 'warning', 'retry', row.name);
    }
    return out;
}

// ── Button-local outcomes ───────────────────────────────────────────────────────
// The answer to "did that work?" belongs beside the control that asked, and it
// belongs there briefly: a success that never clears becomes furniture, and a
// failure still on screen two actions later is a lie.

/** How long an outcome stays beside its control. */
export const OUTCOME_TTL_MS = 6000;

/** @returns {{control: string, ok: boolean, text: string, atMs: number}} */
export function outcome(control, ok, text, atMs) {
    return {control: String(control), ok: Boolean(ok), text: String(text ?? ''), atMs};
}

/** Still worth showing: same control, inside the TTL, and it has something to
 *  say. A port clears on the next action as well - this is only the clock. */
export function outcomeVisible(o, nowMs, ttlMs = OUTCOME_TTL_MS) {
    if (!o || !o.text)
        return false;
    const age = nowMs - Number(o.atMs);
    return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

// ── Switch rotation ─────────────────────────────────────────────────────────────
// "Next account" walks the saved list in order and wraps. That order is the one
// every port already lists accounts in (code points), so the quiet line under the
// switch control describes exactly what the button does - and the line is only
// shown when there is a rotation to describe.

// Fewer saved logins than this and there is no rotation to speak of.
const ROTATION_MIN = 2;

/** The saved names in the order a rotation walks them. */
export function rotationOrder(names) {
    return [...(names ?? [])].map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The account "Next" moves to: the one after `active` in rotation order,
 * wrapping at the end. The first name when the live login is not a saved one
 * (there is nowhere to be "after"). Null below ROTATION_MIN names.
 */
export function nextInRotation(names, active) {
    const order = rotationOrder(names);
    if (order.length < ROTATION_MIN)
        return null;
    const i = order.indexOf(active);
    return i < 0 ? order[0] : order[(i + 1) % order.length];
}
