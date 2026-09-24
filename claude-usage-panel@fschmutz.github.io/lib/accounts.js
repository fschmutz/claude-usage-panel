// Named Claude Code accounts - the GJS I/O behind lib/pure.js's account
// contract. Mirrors claude-code/accounts.js (the Node clients) and the macOS
// app's AccountStore: one store, one file format, one set of decisions.
//
// A login is two things: ~/.claude/.credentials.json and the `oauthAccount`
// block of ~/.claude.json. Switching swaps exactly those two and touches
// nothing else. Saved logins live one file per account, mode 0600, under the
// panel's state dir. Before every switch the live login is written back into
// its own profile (Claude Code rotates its tokens as it runs; the stored copy
// would otherwise die with the old refresh token). An idle profile's access
// token is refreshed with its refresh token when it is needed, and the result
// goes to OUR store only - the live login is Claude Code's to refresh.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readLiveAccount, readLiveCredentials} from './claudeFiles.js';
import {fetchUsage} from './claudeUsage.js';
import {readJSON, writeText} from './fs.js';
import {jsonMessage, parseBody, send} from './http.js';
import {claudeConfigPath, credentialsPath, stateDir} from './paths.js';
import {run} from './proc.js';
import {
    PROFILE_VERSION, isTorn, isValidName, liveProfileName, parkName, parseProfile,
    refreshedOauth, saveRefusal, sameJSON, switchPlan, syncBackPlan, tokenState, usageCacheEntry,
} from './pure.js';

export {readLiveAccount, readLiveCredentials};

export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client - the same id the CLI itself refreshes with.
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// The status line reads this snapshot of every account's worst limit; the
// last-switch stamp is what every auto-switch caller - this panel, the macOS
// app, the MCP tool - checks its cooldown against, so a switch made anywhere
// counts everywhere.
const USAGE_CACHE_FILE = '.usage-cache.json';
const LAST_SWITCH_FILE = '.last-switch.json';
// A switch in progress: {at, from, to}, written before the live login is
// touched and removed once both halves are installed. While it is there no
// client snapshots the live login (see syncBackPlan in lib/pure.js).
const SWITCH_PENDING_FILE = '.switch-pending.json';

// ── Paths ───────────────────────────────────────────────────────────────────────

/** Same root as the usage warehouse, so every client reads one store. */
export function accountsDir() {
    return GLib.build_filenamev([stateDir(), 'accounts']);
}

function profilePath(name) {
    return GLib.build_filenamev([accountsDir(), `${name}.json`]);
}

export function usageCachePath() {
    return GLib.build_filenamev([accountsDir(), USAGE_CACHE_FILE]);
}

export function lastSwitchPath() {
    return GLib.build_filenamev([accountsDir(), LAST_SWITCH_FILE]);
}

function pendingSwitchPath() {
    return GLib.build_filenamev([accountsDir(), SWITCH_PENDING_FILE]);
}

// Everything in the store is a secret: created 0600, never world-readable.
const writePrivate = (path, text) => writeText(path, text, {mode: 0o600});

// ── Store ───────────────────────────────────────────────────────────────────────

/** Every valid profile in the store, by name (code-point order, like every
 *  other port). Unreadable files are skipped. */
export function listProfiles() {
    const dir = Gio.File.new_for_path(accountsDir());
    let children;
    try {
        children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return [];
    }
    const out = [];
    let info;
    while ((info = children.next_file(null)) !== null) {
        const file = info.get_name();
        if (!file.endsWith('.json') || file.startsWith('.'))
            continue;
        const profile = parseProfile(readJSON(GLib.build_filenamev([accountsDir(), file])));
        if (profile && `${profile.name}.json` === file)
            out.push(profile);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readProfile(name) {
    if (!isValidName(name))
        return null;
    const profile = parseProfile(readJSON(profilePath(name)));
    return profile?.name === name ? profile : null;
}

export function writeProfile(profile) {
    const clean = parseProfile(profile);
    if (!clean)
        throw new Error('not a valid profile');
    writePrivate(profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
    return clean;
}

export function removeProfile(name) {
    if (!readProfile(name))
        throw new Error(`no saved account named ${name}`);
    try {
        Gio.File.new_for_path(profilePath(name)).delete(null);
    } catch (e) {
        throw new Error(`could not remove ${name}: ${e.message}`);
    }
}

// ── The live login ──────────────────────────────────────────────────────────────

/** The saved name of the live login (token first, then the account block),
 *  or null when it was never saved. */
export function liveAccountName() {
    return liveProfileName(
        listProfiles(), readLiveCredentials()?.claudeAiOauth.accessToken ?? null, readLiveAccount());
}

/** The unfinished switch ({at, from, to}), or null. */
export function readPendingSwitch() {
    const p = readJSON(pendingSwitchPath());
    return p && typeof p === 'object' && isValidName(p.to) ? p : null;
}

function clearPendingSwitch() {
    try {
        Gio.File.new_for_path(pendingSwitchPath()).delete(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
}

// A profile from what Claude Code holds right now.
function snapshotLive(name) {
    return writeProfile({
        version: PROFILE_VERSION, name, savedAt: new Date().toISOString(),
        account: readLiveAccount() ?? {}, credentials: readLiveCredentials(),
    });
}

/**
 * Write the live login back into its own profile, so the tokens Claude Code
 * rotated since the last switch are the ones we keep. Returns the profile
 * name, or null when the live login is not a saved one. A torn login, one
 * without an account block, or one an unfinished switch left behind is named
 * but never written (syncBackPlan).
 */
export function syncBack() {
    const creds = readLiveCredentials();
    if (!creds)
        return null;
    const account = readLiveAccount();
    const profiles = listProfiles();
    const plan = syncBackPlan(profiles, {token: creds.claudeAiOauth.accessToken, account},
        readPendingSwitch());
    if (plan.pendingDone)
        clearPendingSwitch();
    if (!plan.name || !plan.snapshot)
        return plan.name;
    const stored = profiles.find(p => p.name === plan.name);
    const same = stored && sameJSON(stored.credentials, creds) && sameJSON(stored.account, account);
    if (!same)
        snapshotLive(plan.name);
    return plan.name;
}

/** Save the live login as `name`. `force` overrules a name that already holds
 *  a different account, never a case variant or a twin (saveRefusal). */
export function saveCurrent(name, {force = false} = {}) {
    if (!isValidName(name)) {
        throw new Error(
            `invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    if (!readLiveCredentials())
        throw new Error('no Claude Code login to save - run `claude auth login` first');
    const account = readLiveAccount() ?? {};
    const refusal = saveRefusal(listProfiles(), name, account, force);
    if (refusal?.kind === 'variant') {
        throw new Error(
            `${refusal.profile} already exists - names ignore case, use ${refusal.profile}`);
    }
    if (refusal?.kind === 'taken') {
        throw new Error(
            `${name} is already ${refusal.email ?? 'another account'} - ` +
            'pick another name or --force');
    }
    if (refusal) {
        throw new Error(
            `this login (${account.emailAddress ?? 'no email'}) is already saved as ` +
            `${refusal.profile} - remove ${refusal.profile} first if you meant to rename it`);
    }
    return snapshotLive(name);
}

// A live login that was never saved must not be lost by a switch: park it
// under a name derived from its email ("admin", then "admin-2" ...).
function parkUnsavedLogin() {
    const account = readLiveAccount();
    if (!readLiveCredentials() || !account)
        return null;
    return snapshotLive(parkName(account.emailAddress, listProfiles().map(p => p.name))).name;
}

/** Claude Code processes alive right now - they keep the old token. */
export async function runningClaudeCount() {
    const {ok, stdout} = await run(['ps', '-eo', 'args=']);
    if (!ok)
        return 0;
    return stdout.split('\n').filter(l => /(^|\/)claude(\s|$)/.test(l.trim())).length;
}

// ── Token refresh (our store only) ──────────────────────────────────────────────

/**
 * Exchange the profile's refresh token for a new access token and store the
 * result. Throws on failure. Never touches the live login.
 */
export async function refreshProfile(session, profile) {
    const oauth = profile.credentials.claudeAiOauth;
    if (!oauth.refreshToken)
        throw new Error(`${profile.name}: no refresh token - log in again and save it`);
    let body;
    try {
        const {status, bytes} = await send(session, jsonMessage('POST', OAUTH_TOKEN_ENDPOINT, {
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: OAUTH_CLIENT_ID,
        }));
        if (status < 200 || status >= 300) {
            const again = status === 400 || status === 401 ? ' - log in again and save it' : '';
            throw new Error(`${profile.name}: token refresh rejected (HTTP ${status})${again}`);
        }
        body = parseBody(bytes);
    } catch (e) {
        throw new Error(e.message.startsWith(profile.name)
            ? e.message : `${profile.name}: token refresh failed - ${e.message}`);
    }
    const nowMs = Date.now();
    const next = refreshedOauth(oauth, body, nowMs);
    if (!next)
        throw new Error(`${profile.name}: token refresh returned no access token`);
    return writeProfile({
        ...profile, savedAt: new Date(nowMs).toISOString(),
        credentials: {...profile.credentials, claudeAiOauth: next},
    });
}

/**
 * A usable access token for a saved account: the live one when that account
 * is the active login (Claude Code keeps it fresh), else the stored one,
 * refreshed first when stale.
 */
export async function accessTokenFor(session, name) {
    const profile = readProfile(name);
    if (!profile)
        throw new Error(`no saved account named ${name}`);
    if (liveAccountName() === name) {
        const live = readLiveCredentials();
        if (live)
            return {token: live.claudeAiOauth.accessToken, source: 'live'};
    }
    switch (tokenState(profile)) {
    case 'valid':
        return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
    case 'stale': {
        const fresh = await refreshProfile(session, profile);
        return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
    }
    default:
        throw new Error(
            `${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
}

// ── Switch ──────────────────────────────────────────────────────────────────────

// Install a profile as the live login. ~/.claude.json is read and validated
// BEFORE anything is written; then the switch is marked pending, the account
// block goes in, the credentials, and the mark is cleared. If a write fails in
// between, the mark stays and syncBack() refuses to snapshot the live login -
// even after Claude Code rotates the old token past any match - until a
// switch finishes the job, so no profile is overwritten with the wrong tokens.
function installLogin(profile, from) {
    const configPath = claudeConfigPath();
    const cfg = readJSON(configPath) ?? {};
    if (typeof cfg !== 'object' || Array.isArray(cfg))
        throw new Error(`${configPath} is not a JSON object`);
    cfg.oauthAccount = profile.account;
    writePrivate(pendingSwitchPath(),
        JSON.stringify({at: Date.now(), from: from ?? null, to: profile.name}));
    writePrivate(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    writePrivate(credentialsPath(), JSON.stringify(profile.credentials));
    clearPendingSwitch();
}

/**
 * Make `name` the live login. Order matters: the live login is synced back
 * (or parked under a new name if it was never saved) BEFORE anything is
 * overwritten, and the target is refreshed BEFORE it is installed, so a
 * refresh failure leaves the current login untouched.
 */
export async function switchTo(session, name) {
    let target = readProfile(name);
    if (!target)
        throw new Error(`no saved account named ${name}`);
    const synced = syncBack();
    const plan = switchPlan({
        name, synced, pending: readPendingSwitch(),
        torn: isTorn(listProfiles(), name, readLiveAccount()), state: tokenState(target),
    });
    const from = plan.park ? parkUnsavedLogin() : plan.from;
    const email = target.account.emailAddress ?? null;
    if (plan.action === 'stay' || plan.action === 'repair') {
        if (plan.action === 'repair')
            installLogin(target, from); // finish an interrupted switch
        return {from, to: name, changed: false, running: await runningClaudeCount(), email};
    }
    if (plan.action === 'expired') {
        throw new Error(
            `${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
    if (plan.action === 'refresh')
        target = await refreshProfile(session, target);
    installLogin(target, from);
    writeLastSwitch({from, to: name});
    return {from, to: name, changed: true, running: await runningClaudeCount(), email};
}

// ── The last switch (auto-switch cooldown, shared by every client) ──────────────

export function writeLastSwitch({from, to}, nowMs = Date.now()) {
    try {
        writePrivate(lastSwitchPath(), JSON.stringify({at: nowMs, from: from ?? null, to}));
    } catch (e) {
        logError(e, 'claude-usage-panel: could not record the account switch');
    }
}

/** When the last switch happened (by any client), or null. */
export function readLastSwitchMs() {
    const at = readJSON(lastSwitchPath())?.at;
    return Number.isFinite(at) ? at : null;
}

// ── Per-account usage ───────────────────────────────────────────────────────────

/** Normalized usage for one saved account, or {ok: false, code, message}. */
export async function usageFor(session, name) {
    let token;
    try {
        ({token} = await accessTokenFor(session, name));
    } catch (e) {
        return {name, ok: false, code: 'no_token', message: e.message};
    }
    const result = await fetchUsage(session, token);
    return {name, ...result};
}

// The panels and the MCP server drop the latest per-account worst limit here
// so the status line (no network, no credentials) can hint at a freer account.
export function writeUsageCache(results, nowMs = Date.now()) {
    const accounts = {};
    for (const [name, r] of Object.entries(results)) {
        if (r?.ok)
            accounts[name] = usageCacheEntry(r.cards);
    }
    try {
        writePrivate(usageCachePath(), JSON.stringify({at: nowMs, accounts}));
    } catch (e) {
        logError(e, 'claude-usage-panel: could not write the account usage cache');
    }
}
