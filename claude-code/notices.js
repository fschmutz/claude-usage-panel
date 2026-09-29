// Account health and the inline notices - the Node port. Mirrors the health
// and notices half of lib/pure/notices.js (GNOME) and
// ClaudeUsageCore/Notices.swift (macOS); tests/fixtures/notices.json pins
// both decisions across the three. The button-local outcomes and the switch
// rotation have no Node port: no Node client draws a button. No I/O, no Node
// built-ins - a pure module.
//
// The rule the ports share: a problem with a saved login belongs next to that
// login, with the ONE thing that repairs it attached. Sentences and button
// labels are deliberately NOT here: they are translated per port. What is
// pinned is which notice appears, in what order, how loud it is, and what its
// single repair action does.

/**
 * How usable a saved login is right now: one of
 * valid          - the stored access token is good as it stands
 * stale          - it is (about to be) expired, and the refresh token can mint
 *                  a new one on next use. Not a problem; not worth a notice.
 * expired        - the refresh token is gone or spent: only a new
 *                  `claude auth login` on that account helps.
 * refresh-failed - the exchange was tried and refused, or the usage endpoint
 *                  turned a STORED token down. The saved credentials are
 *                  finished even though their dates say otherwise.
 * unreachable    - nothing is known to be wrong with the login; the reading
 *                  is simply missing (a 429, a 5xx, no network, a live login
 *                  that could not be read, or a live token the endpoint turned
 *                  down: that one is Claude Code's to refresh, not the
 *                  profile's).
 *
 * `errorCode` is the code the store's usage result carries ('refresh_failed',
 * 'login_expired', 'auth_expired', 'forbidden', 'transient', 'http_error',
 * 'network_error', 'parse_error', 'no_token'), or null when the fetch worked.
 * `live` is true when the token that was used is the live login's
 * (accessTokenFor source 'live').
 */
export function accountHealth({tokenState = 'stale', errorCode = null, live = false} = {}) {
  if (errorCode === 'refresh_failed' || (errorCode === 'auth_expired' && !live)) return 'refresh-failed';
  if (errorCode === 'login_expired' || tokenState === 'expired') return 'expired';
  if (errorCode) return 'unreachable';
  return tokenState === 'valid' ? 'valid' : 'stale';
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
 * @returns {Array<{id: string, kind: string, severity: 'warning'|'critical',
 *                  action: string, arg: ?string}>}
 */
export function accountNotices({
  rows = [], liveEmail = null, activeName = null, pending = null, torn = false,
} = {}) {
  const out = [];
  const add = (id, kind, severity, action, arg) => out.push({id, kind, severity, action, arg});
  // Loudest first, and the two that describe the LIVE login before the saved
  // ones: a half-installed switch explains every row under it.
  if (pending?.to) add('pending-switch', 'pending-switch', 'critical', 'finish-switch', pending.to);
  if (torn && activeName) add('torn-login', 'torn-login', 'warning', 'repair', activeName);
  // A login nobody named survives a switch only because we park it under its
  // email. Saying so beats discovering the parked name afterwards.
  if (!activeName && liveEmail) add('unsaved-login', 'unsaved-login', 'warning', 'save', liveEmail);
  for (const row of rows) {
    if (row?.health === 'expired') {
      add(`login-expired:${row.name}`, 'login-expired', 'critical', 'relogin', row.name);
    } else if (row?.health === 'refresh-failed') {
      add(`refresh-failed:${row.name}`, 'refresh-failed', 'critical', 'relogin', row.name);
    } else if (row?.health === 'unreachable') {
      add(`unreachable:${row.name}`, 'unreachable', 'warning', 'retry', row.name);
    }
  }
  return out;
}
