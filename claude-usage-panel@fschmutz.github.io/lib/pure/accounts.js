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
    const torn = byAccount !== null && byAccount !== name;
    const target = pending ? profiles.find(p => p.name === pending.to) : null;
    const pendingDone = Boolean(target && target.name === name && byAccount === name &&
        target.credentials.claudeAiOauth.accessToken === token);
    const snapshot = account !== null && typeof account === 'object' && !torn &&
        (!pending || pendingDone);
    return {name, snapshot, pendingDone};
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
