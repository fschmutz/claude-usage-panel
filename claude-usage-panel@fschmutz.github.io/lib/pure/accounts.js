// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Named accounts (mirrors claude-code/accounts.js; tests/fixtures/accounts.json)
// A saved login is the credentials blob plus the `oauthAccount` block of
// ~/.claude.json, under a name of the user's choosing. The decisions below -
// which saved profile the live login is, whether a stored token is still
// usable, and when to move to another account - are pinned by one fixture
// across the GNOME, Node and Swift ports. The I/O lives in lib/accounts.js.

/** Refresh an access token this close to its expiry rather than use it. */
export const REFRESH_LEAD_MS = 5 * 60_000;
/** Auto-switch contract: threshold the active account must reach, how far
 *  under it a candidate must sit, and the pause between two switches. */
export const AUTO_SWITCH = {threshold: 90, margin: 15, cooldownMs: 5 * 60_000};
/** Profile names are file names: one path segment, no leading dot or dash. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const PROFILE_VERSION = 1;
/** Colour thresholds for usage figures that carry no API severity (an account
 *  row's "S 42% · W 12%"): yellow from `warning`, red from `critical`. */
export const USAGE_SEVERITY_THRESHOLDS = {warning: 70, critical: 90};

export function usageSeverity(percent) {
    if (percent === null || percent === undefined)
        return 'normal';
    if (percent >= USAGE_SEVERITY_THRESHOLDS.critical)
        return 'critical';
    return percent >= USAGE_SEVERITY_THRESHOLDS.warning ? 'warning' : 'normal';
}

export function isValidName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
}

/** A stored profile, validated; null for anything that is not one. */
export function parseProfile(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    if (!isValidName(raw.name))
        return null;
    const oauth = raw.credentials?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object')
        return null;
    if (typeof oauth.accessToken !== 'string' || !oauth.accessToken)
        return null;
    const account = raw.account && typeof raw.account === 'object' ? raw.account : {};
    return {
        version: PROFILE_VERSION,
        name: raw.name,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
        account,
        credentials: {...raw.credentials, claudeAiOauth: {...oauth}},
    };
}

/**
 * valid   - the access token is good for at least REFRESH_LEAD_MS
 * stale   - the access token is (about to be) expired; the refresh token can
 *           mint a new one. Also the answer when the dates are unknown.
 * expired - the refresh token is gone too; only a new login helps.
 */
export function tokenState(profile, nowMs = Date.now(), leadMs = REFRESH_LEAD_MS) {
    const oauth = profile?.credentials?.claudeAiOauth ?? {};
    const refreshUntil = Number(oauth.refreshTokenExpiresAt);
    if (!oauth.refreshToken)
        return 'expired';
    if (Number.isFinite(refreshUntil) && refreshUntil <= nowMs)
        return 'expired';
    const until = Number(oauth.expiresAt);
    if (Number.isFinite(until) && until - nowMs > leadMs)
        return 'valid';
    return 'stale';
}

export function accountSummary(profile, nowMs = Date.now()) {
    const oauth = profile.credentials.claudeAiOauth;
    const acct = profile.account ?? {};
    return {
        name: profile.name,
        email: typeof acct.emailAddress === 'string' ? acct.emailAddress : null,
        accountUuid: typeof acct.accountUuid === 'string' ? acct.accountUuid : null,
        plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
        tier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier
            : (typeof acct.organizationRateLimitTier === 'string'
                ? acct.organizationRateLimitTier : null),
        tokenState: tokenState(profile, nowMs),
    };
}

/** Which saved profile the live login is - by account id, else by email. */
export function activeAccountName(profiles, live) {
    if (!live || typeof live !== 'object')
        return null;
    const uuid = typeof live.accountUuid === 'string' ? live.accountUuid : null;
    if (uuid) {
        const hit = profiles.find(p => p.account?.accountUuid === uuid);
        if (hit)
            return hit.name;
    }
    const email = typeof live.emailAddress === 'string' ? live.emailAddress.toLowerCase() : null;
    if (email) {
        const hit = profiles.find(
            p => String(p.account?.emailAddress ?? '').toLowerCase() === email);
        if (hit)
            return hit.name;
    }
    return null;
}

/**
 * Which saved profile the live login is. The credentials decide first: when
 * the live access token is exactly one a profile holds, that profile is live
 * whatever the account block says (a switch that failed between its two
 * writes leaves them disagreeing). Otherwise Claude Code has rotated the
 * token, and the account block is the identity.
 */
export function liveProfileName(profiles, token, account) {
    const byToken = typeof token === 'string' && token
        ? profiles.find(p => p.credentials?.claudeAiOauth?.accessToken === token) : null;
    return byToken?.name ?? activeAccountName(profiles, account);
}

/**
 * What syncBack may do with the live login `{token, account}`, given the
 * switch-in-progress marker `pending` ({from, to} or null).
 *   name        - the saved profile the live login is (liveProfileName)
 *   snapshot    - write the live login into that profile. Never when the two
 *                 halves disagree (the account block names another profile),
 *                 never without an account block (the profile would lose its
 *                 identity), and never while a switch is unfinished: its
 *                 credentials may still be the previous login's, rotated past
 *                 any token match.
 *   pendingDone - the marker names a switch that did complete (the target's
 *                 token and account block are both live): clear it.
 */
export function syncBackPlan(profiles, {token = null, account = null} = {}, pending = null) {
    const name = liveProfileName(profiles, token, account);
    if (!name)
        return {name: null, snapshot: false, pendingDone: false};
    const byAccount = activeAccountName(profiles, account);
    const torn = isTorn(profiles, name, account);
    const target = pending ? profiles.find(p => p.name === pending.to) : null;
    const pendingDone = Boolean(target && target.name === name && byAccount === name &&
        target.credentials.claudeAiOauth.accessToken === token);
    const snapshot = account !== null && typeof account === 'object' && !torn &&
        (!pending || pendingDone);
    return {name, snapshot, pendingDone};
}

/** The live login's two halves disagree: its account block names a saved
 *  profile other than `name`, the one its credentials say it is. */
export function isTorn(profiles, name, account) {
    const byAccount = activeAccountName(profiles, account);
    return byAccount !== null && byAccount !== name;
}

/**
 * Two JSON values that hold the same data: objects compare by key set, not
 * key order (Claude Code may rewrite a file with its keys reordered, which is
 * no reason to rewrite a profile), arrays by position, scalars strictly (1 is
 * not "1", true is not 1).
 */
export function sameJSON(a, b) {
    if (a === b)
        return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object')
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    if (Array.isArray(a))
        return a.length === b.length && a.every((x, i) => sameJSON(x, b[i]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
        keys.every(k => Object.hasOwn(b, k) && sameJSON(a[k], b[k]));
}

/**
 * Why the live login (its account block `account`) may not be saved as
 * `name`, or null when it may. First hit wins:
 *   variant - a saved name differs from `name` only by case: one file on
 *             APFS, never a new profile. `force` does not overrule it.
 *   taken   - `name` holds a different account (both uuids known, and they
 *             differ). `force` overrules it.
 *   twin    - this account is already saved under another name. Two profiles
 *             with one identity make activeAccountName a coin toss and an
 *             auto-switch between them a no-op, so `force` does not overrule it.
 * Returns {kind, profile, email}: the conflicting saved profile and its email
 * (null when it has none).
 */
export function saveRefusal(profiles, name, account, force = false) {
    const live = account && typeof account === 'object' ? account : {};
    const uuid = a => (typeof a?.accountUuid === 'string' && a.accountUuid ? a.accountUuid : null);
    const refusal = (kind, p) => ({
        kind, profile: p.name,
        email: typeof p.account?.emailAddress === 'string' ? p.account.emailAddress : null,
    });
    const variant = profiles.find(p => p.name !== name && sameName(p.name, name));
    if (variant)
        return refusal('variant', variant);
    const existing = profiles.find(p => p.name === name);
    if (existing && !force && uuid(live) && uuid(existing.account) &&
        uuid(existing.account) !== uuid(live))
        return refusal('taken', existing);
    const twin = activeAccountName(profiles.filter(p => p.name !== name), live);
    return twin ? refusal('twin', profiles.find(p => p.name === twin)) : null;
}

/**
 * The OAuth block after a refresh-token exchange answered with `body`, or
 * null when the answer carries no access token. A rotated refresh token and a
 * scope list replace ours when present. `expires_in` (seconds) moves
 * expiresAt only when it is a finite number above zero: null, a string, a
 * boolean, 0 or less keep the old expiry, so a malformed answer never stamps
 * a fresh token stale.
 */
export function refreshedOauth(oauth, body, nowMs) {
    if (!body || typeof body !== 'object' || typeof body.access_token !== 'string' ||
        !body.access_token)
        return null;
    const next = {...oauth, accessToken: body.access_token};
    const ttl = body.expires_in;
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0)
        next.expiresAt = nowMs + ttl * 1000;
    if (typeof body.refresh_token === 'string' && body.refresh_token)
        next.refreshToken = body.refresh_token;
    if (typeof body.scope === 'string')
        next.scopes = body.scope.split(/\s+/).filter(Boolean);
    return next;
}

/**
 * What switchTo(name) does once the live login is synced back.
 *   synced  - the saved name syncBack gave the live login, or null
 *   pending - the unfinished switch ({from, to}), or null
 *   torn    - isTorn(profiles, name, live account block)
 *   state   - the target's tokenState
 * Returns {from, park, action}:
 *   from    - the login the switch leaves: an unfinished switch's source (its
 *             live login is of unknown ownership, so it is neither synced nor
 *             parked), else the synced name
 *   park    - no switch pending and the live login was never saved: park it
 *             under parkName first; the parked name becomes `from`
 *   action  - stay:    already the live login, nothing to do
 *             repair:  already the live login but torn - reinstall it as is
 *                      (finishes an interrupted switch), no last-switch stamp
 *             expired: refuse, the target must log in again
 *             refresh: refresh the target first, then install it
 *             install: install it
 */
export function switchPlan({name, synced = null, pending = null, torn = false, state}) {
    const from = pending ? (pending.from ?? null) : synced;
    const park = !pending && synced === null;
    let action;
    if (!pending && synced !== null && synced === name)
        action = torn ? 'repair' : 'stay';
    else if (state === 'expired')
        action = 'expired';
    else
        action = state === 'stale' ? 'refresh' : 'install';
    return {from, park, action};
}

/** Two profile names that would land on one file on a case-insensitive disk
 *  (APFS, the macOS default). Names are ASCII (NAME_RE), so lowercasing is exact. */
export function sameName(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * The name an unsaved live login is parked under before a switch: the local
 * part of its email made a valid profile name ("admin", then "admin-2" ...),
 * free of every taken name ignoring case. One code point = one character.
 */
export function parkName(email, taken = []) {
    const local = typeof email === 'string' ? email.split('@')[0] : '';
    const base = local.replace(/[^A-Za-z0-9._-]/gu, '-').replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 28) || 'account';
    const used = new Set(taken.map(n => String(n).toLowerCase()));
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++)
        name = `${base}-${n}`;
    return name;
}

/** The fullest limit of a set of cards. */
export function worstPercent(cards) {
    let worst = null;
    for (const c of cards ?? []) {
        const p = Number(c?.percent);
        if (!Number.isFinite(p))
            continue;
        const clamped = Math.max(0, Math.min(100, Math.round(p)));
        worst = worst === null ? clamped : Math.max(worst, clamped);
    }
    return worst;
}

/** One account's row of the usage cache: its worst limit, and its session
 *  and weekly-all percents (null for a card it does not have). */
export function usageCacheEntry(cards) {
    const pct = key => (cards ?? []).find(c => c?.key === key)?.percent ?? null;
    return {worst: worstPercent(cards), session: pct('session'), weekly: pct('weekly_all')};
}

/**
 * The account to switch to, or null to stay. `worst` maps each saved name to
 * its worst limit percent (null = usage unknown). Switch only when the active
 * account is at/over the threshold, to the candidate with the most headroom,
 * and only if that candidate sits at least `margin` points under the
 * threshold (so two busy accounts do not ping-pong); never within the
 * cooldown of the previous switch. Ties break by name, code-point order.
 */
export function autoSwitchTarget({
    active, worst, threshold = AUTO_SWITCH.threshold, margin = AUTO_SWITCH.margin,
    cooldownMs = AUTO_SWITCH.cooldownMs, lastSwitchMs = null, nowMs = Date.now(),
}) {
    if (!active || !worst || typeof worst !== 'object')
        return null;
    const activePercent = worst[active];
    if (!Number.isFinite(activePercent) || activePercent < threshold)
        return null;
    if (Number.isFinite(lastSwitchMs) && nowMs - lastSwitchMs < cooldownMs)
        return null;
    let best = null;
    for (const name of Object.keys(worst).sort()) {
        if (name === active)
            continue;
        const p = worst[name];
        if (!Number.isFinite(p) || p > threshold - margin)
            continue;
        if (!best || p < best.percent)
            best = {name, percent: p};
    }
    if (!best)
        return null;
    return {from: active, to: best.name, activePercent, targetPercent: best.percent};
}

/** "S 42% · W 12%" from the session / weekly-all cards; '' without cards. */
export function formatAccountUsage(cards) {
    const pick = key => {
        const c = (cards ?? []).find(x => x?.key === key);
        return c ? `${Math.max(0, Math.min(100, Math.round(Number(c.percent) || 0)))}%` : null;
    };
    const s = pick('session');
    const w = pick('weekly_all');
    return [s && `S ${s}`, w && `W ${w}`].filter(x => x).join(' · ');
}

/**
 * The fetch/refresh error as an account ROW shows it: the store prefixes its
 * errors with the profile name for the CLI and the notifications, and a row
 * already carries that name, so the prefix is dropped there.
 * "PRO: token refresh rejected (HTTP 400) - log in again" → "token refresh
 * rejected (HTTP 400) - log in again".
 */
export function rowError(name, message) {
    const text = String(message ?? '').trim();
    const prefix = `${name}: `;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}
