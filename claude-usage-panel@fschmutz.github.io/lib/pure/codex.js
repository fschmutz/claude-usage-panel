// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Named OpenAI Codex logins (mirrors claude-code/codex-contract.js and
// ClaudeUsageCore/Codex.swift; tests/fixtures/codex.json pins all three)
//
// Codex is a SIBLING of the Claude accounts, never a replacement: it is off by
// default in both panels, it has its own store directory, and nothing here can
// touch a Claude login. What it reads is `auth.json` under the Codex home
// ($CODEX_HOME, else ~/.codex) - the same file the `codex` CLI writes when you
// sign in with ChatGPT - and the credentials never leave the machine.
//
// What it does NOT do: invent usage numbers. OpenAI publishes no plan-limit
// endpoint of the kind Anthropic's /api/oauth/usage is, so there is nothing to
// poll. The only honest figures available are the ones the Codex CLI itself
// recorded when the API last told it (a `token_count` event in a session
// transcript), and those are reported as ESTIMATED, with the instant they were
// captured, or not at all.

import {clampPercent} from './usage.js';

export const CODEX_PROFILE_VERSION = 1;
/** Refresh lead, matching the Claude store: a token this close to expiry is
 *  stale rather than usable. */
export const CODEX_REFRESH_LEAD_MS = 5 * 60_000;
/** Codex re-authenticates when its tokens have not been refreshed in this
 *  long; a stored profile older than that needs the CLI to sign in again. */
export const CODEX_REFRESH_MAX_AGE_MS = 28 * 86_400_000;
/** The claim namespace ChatGPT tokens carry their plan in. */
export const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';
/** How long a recorded rate-limit snapshot is worth showing at all. Past this
 *  the window it measured has almost certainly rolled over. */
export const CODEX_SNAPSHOT_MAX_AGE_MS = 12 * 3_600_000;

// Hand-rolled rather than atob(): atob is a browser API that GJS does not
// have, and every port of this contract must decode a JWT the same way.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64UrlBytes(text) {
    const s = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const ch of s) {
        const v = B64.indexOf(ch);
        if (v < 0)
            return null;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((acc >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

/**
 * The claims of a JWT, WITHOUT verifying its signature. That is deliberate and
 * safe here: the token is read from a file only this user can write, it is
 * never used as proof of anything, and the claims are used for exactly two
 * things - naming the account in a list and saying which plan it is on. A
 * client that verified it would need OpenAI's keys and would still be reading
 * the same file.
 * @returns {?object} null for anything that is not a three-part JWT
 */
export function jwtClaims(token) {
    if (typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length !== 3)
        return null;
    const bytes = base64UrlBytes(parts[1]);
    if (!bytes)
        return null;
    try {
        const claims = JSON.parse(new TextDecoder().decode(bytes));
        return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
    } catch {
        return null;
    }
}

/** "Plus" / "Pro" / "Business" - the plan as the panels print it; '' unknown. */
export function codexPlanLabel(plan) {
    const p = typeof plan === 'string' ? plan.trim() : '';
    if (!p)
        return '';
    return p.charAt(0).toUpperCase() + p.slice(1).replace(/_/g, ' ');
}

/**
 * Who a Codex auth blob belongs to, from the id token's claims.
 * @param {?object} auth the parsed auth.json
 * @returns {{email: ?string, accountId: ?string, plan: ?string, planLabel: string}}
 */
export function codexIdentity(auth) {
    const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
    const claims = jwtClaims(tokens.id_token) ?? {};
    const scoped = claims[CODEX_AUTH_CLAIM];
    const ns = scoped && typeof scoped === 'object' ? scoped : {};
    const str = v => (typeof v === 'string' && v ? v : null);
    const plan = str(ns.chatgpt_plan_type);
    return {
        email: str(claims.email),
        accountId: str(tokens.account_id) ?? str(ns.chatgpt_account_id),
        plan,
        planLabel: codexPlanLabel(plan),
    };
}

/** A stored Codex profile, validated; null for anything that is not one. */
export function parseCodexProfile(raw, isValidName) {
    if (!raw || typeof raw !== 'object')
        return null;
    if (!isValidName(raw.name))
        return null;
    const auth = raw.auth;
    if (!auth || typeof auth !== 'object')
        return null;
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
    // An API-key-only auth.json is a valid Codex login too, but it is not one
    // this store can switch between accounts with: there is no identity in it.
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token)
        return null;
    return {
        version: CODEX_PROFILE_VERSION,
        name: raw.name,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
        auth: {...auth, tokens: {...tokens}},
    };
}

/**
 * valid   - the access token is good for at least CODEX_REFRESH_LEAD_MS
 * stale   - it is (about to be) expired, and the refresh token can mint a new
 *           one. Also the answer when the token carries no expiry.
 * expired - no refresh token, or the last refresh is older than Codex's own
 *           re-authentication horizon: only `codex login` helps.
 *
 * Note what this does NOT do: exchange anything. The Claude store refreshes a
 * parked login because Anthropic documents that grant; nothing here mints a
 * Codex token, so a stale one is reported and handed to the CLI, which owns
 * the exchange.
 */
export function codexTokenState(profile, nowMs = Date.now(), leadMs = CODEX_REFRESH_LEAD_MS) {
    const tokens = profile?.auth?.tokens ?? {};
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token)
        return 'expired';
    const lastRefresh = Date.parse(profile?.auth?.last_refresh ?? '');
    if (Number.isFinite(lastRefresh) && nowMs - lastRefresh > CODEX_REFRESH_MAX_AGE_MS)
        return 'expired';
    const exp = Number(jwtClaims(tokens.access_token)?.exp);
    if (Number.isFinite(exp) && exp * 1000 - nowMs > leadMs)
        return 'valid';
    return 'stale';
}

/** What a saved Codex login shows in a list. */
export function codexSummary(profile, nowMs = Date.now()) {
    const id = codexIdentity(profile.auth);
    return {
        name: profile.name,
        email: id.email,
        accountId: id.accountId,
        plan: id.plan,
        planLabel: id.planLabel,
        tokenState: codexTokenState(profile, nowMs),
    };
}

/** Which saved Codex profile a live auth blob is - by account id, else email. */
export function activeCodexName(profiles, live) {
    const id = codexIdentity(live);
    if (id.accountId) {
        const hit = profiles.find(p => codexIdentity(p.auth).accountId === id.accountId);
        if (hit)
            return hit.name;
    }
    if (id.email) {
        const want = id.email.toLowerCase();
        const hit = profiles.find(p => (codexIdentity(p.auth).email ?? '').toLowerCase() === want);
        if (hit)
            return hit.name;
    }
    return null;
}

// ── Usage, honestly ─────────────────────────────────────────────────────────────
// Codex does not expose a usage endpoint. What it DOES do is print the rate
// limits the API returned with the last turn, and record them in the session
// transcript as a `token_count` event:
//
//   rate_limits: {primary: {used_percent, window_minutes, resets_in_seconds},
//                 secondary: {…}}
//
// That is a real reading of a real limit, but it is a reading from whenever
// that turn happened, not from now - so it is normalized into the same card
// shape as everything else and marked `estimated`, carrying the instant it was
// captured. When there is no snapshot, the answer is "unavailable". There is
// no third option in which a number is made up.

/** Label for a limit window of `minutes`: "5h limit", "Weekly limit". */
export function codexWindowLabel(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0)
        return 'Codex limit';
    if (m % 10080 === 0) {
        const weeks = m / 10080;
        return weeks === 1 ? 'Weekly limit' : `${weeks}-week limit`;
    }
    if (m % 1440 === 0) {
        const days = m / 1440;
        return days === 1 ? 'Daily limit' : `${days}-day limit`;
    }
    if (m % 60 === 0)
        return `${m / 60}h limit`;
    return `${m}m limit`;
}

/**
 * The cards for one recorded rate-limit snapshot.
 * @param {?object} rateLimits the `rate_limits` object Codex recorded
 * @param {number} capturedAtMs when that turn happened
 * @returns {Array<object>} normalized cards, `provenance: 'estimated'`; empty
 *   when the snapshot carries nothing usable.
 */
export function normalizeCodexLimits(rateLimits, capturedAtMs) {
    const out = [];
    const slots = [['primary', 'session'], ['secondary', 'weekly']];
    for (const [key, group] of slots) {
        const slot = rateLimits?.[key];
        if (!slot || typeof slot !== 'object')
            continue;
        const used = slot.used_percent;
        if (typeof used !== 'number' || !Number.isFinite(used))
            continue;
        const resetsIn = Number(slot.resets_in_seconds);
        out.push({
            key: `codex_${key}`,
            label: codexWindowLabel(slot.window_minutes),
            group,
            scoped: false,
            percent: clampPercent(used),
            percentKnown: true,
            severity: 'normal',
            resetsAt: Number.isFinite(resetsIn)
                ? new Date(capturedAtMs + resetsIn * 1000).toISOString() : null,
            active: key === 'primary',
            // Every figure this panel shows says where it came from; these were
            // read by the Codex CLI at `capturedAt`, not by us, and not now.
            provenance: 'estimated',
            capturedAt: new Date(capturedAtMs).toISOString(),
        });
    }
    return out;
}

/**
 * Whether a recorded snapshot is still worth showing.
 * @returns {{show: boolean, ageMs: number}}
 */
export function codexSnapshotAge(capturedAtMs, nowMs = Date.now(),
    maxAgeMs = CODEX_SNAPSHOT_MAX_AGE_MS) {
    const ageMs = nowMs - Number(capturedAtMs);
    return {show: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs, ageMs};
}
