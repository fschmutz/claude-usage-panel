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
import {readJSON, readText, writeText} from './fs.js';
import {jsonMessage, parseBody, send} from './http.js';
import {claudeConfigPath, credentialsPath, stateDir} from './paths.js';
import {run} from './proc.js';
import {
    PROFILE_VERSION, REFRESH_LOCK, isTorn, isValidName, liveProfileName, parkName, parseProfile,
    refreshFailureCode, refreshLockFile, refreshRaced, refreshedOauth, saveRefusal, sameJSON,
    switchPlan, syncBackPlan, tokenState, usageCacheEntry,
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

// An error the UI has to classify rather than just print. `code` is the string
// accountHealth() reads ('refresh_failed', 'login_expired', 'no_account',
// 'no_token', 'transient', 'http_error', 'network_error'), so a broken saved
// login is reported identically by every port.
function coded(code, message) {
    return Object.assign(new Error(message), {code});
}

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
// A refresh token is single-use and several processes poll one store (this
// panel, one MCP server per Claude Code window, the CLI, the macOS app on a
// shared home), so the exchange runs under the per-profile lock file every
// port uses (REFRESH_LOCK in lib/pure/accounts.js), and a profile another
// process already refreshed is used as it is (refreshRaced).

const sleep = ms => new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    });
});

// O_EXCL create, 0600 (G_FILE_CREATE_PRIVATE). The lock carries a random id so
// a holder only ever removes its own lock, never one a waiter took over after
// it went stale.
async function acquireRefreshLock(name) {
    const path = GLib.build_filenamev([accountsDir(), refreshLockFile(name)]);
    const file = Gio.File.new_for_path(path);
    const id = GLib.uuid_string_random();
    GLib.mkdir_with_parents(accountsDir(), 0o700);
    const start = Date.now();
    for (;;) {
        try {
            const stream = file.create(Gio.FileCreateFlags.PRIVATE, null);
            stream.write_all(new TextEncoder().encode(id), null);
            stream.close(null);
            return {path, file, id};
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        let age;
        try {
            const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            age = Date.now() - info.get_modification_date_time().to_unix() * 1000;
        } catch {
            continue; // released between the two calls: try again at once
        }
        if (age > REFRESH_LOCK.staleMs) {
            try {
                file.delete(null); // a crashed holder
            } catch {
                // another waiter took it first
            }
            continue;
        }
        if (Date.now() - start > REFRESH_LOCK.waitMs) {
            throw coded('transient',
                `${name}: another refresh of this login is still running - try again`);
        }
        await sleep(REFRESH_LOCK.pollMs);
    }
}

function releaseRefreshLock({path, file, id}) {
    if (readText(path) !== id)
        return;
    try {
        file.delete(null);
    } catch {
        // already gone
    }
}

// The token exchange itself: the new OAuth block, or a coded throw.
async function exchange(session, name, oauth) {
    let status, bytes;
    try {
        ({status, bytes} = await send(session, jsonMessage('POST', OAUTH_TOKEN_ENDPOINT, {
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: OAUTH_CLIENT_ID,
        })));
    } catch (e) {
        throw coded('network_error', `${name}: token refresh failed - ${e.message}`);
    }
    if (status < 200 || status >= 300) {
        const code = refreshFailureCode(status);
        const again = code === 'refresh_failed' ? ' - log in again and save it' : '';
        throw coded(code, `${name}: token refresh rejected (HTTP ${status})${again}`);
    }
    let body = null;
    try {
        body = parseBody(bytes);
    } catch {
        // a 200 without a JSON body carries no access token either
    }
    const next = refreshedOauth(oauth, body, Date.now());
    if (!next)
        throw coded('refresh_failed', `${name}: token refresh returned no access token`);
    return next;
}

/**
 * Exchange the profile's refresh token for a new access token and store the
 * result, under the profile's refresh lock. When another process refreshed it
 * first, the stored result is returned and no token is spent. Throws a coded
 * error on failure. Never touches the live login.
 */
export async function refreshProfile(session, profile) {
    const sent = profile.credentials.claudeAiOauth;
    if (!sent.refreshToken) {
        throw coded('login_expired',
            `${profile.name}: no refresh token - log in again and save it`);
    }
    const lock = await acquireRefreshLock(profile.name);
    try {
        const current = readProfile(profile.name);
        if (!current)
            throw coded('no_account', `no saved account named ${profile.name}`);
        if (refreshRaced(sent, current.credentials.claudeAiOauth))
            return current;
        let next;
        try {
            next = await exchange(session, profile.name, sent);
        } catch (e) {
            // A writer that took no lock may have spent it: a spent token
            // whose replacement is on disk is fine.
            const again = e.code === 'refresh_failed' ? readProfile(profile.name) : null;
            if (again && refreshRaced(sent, again.credentials.claudeAiOauth))
                return again;
            throw e;
        }
        // The rotated tokens go into OUR store and nowhere else. This is
        // reached for parked accounts on every poll; writing the live
        // credentials from here would rotate the token Claude Code is running on.
        return writeProfile({
            ...current, savedAt: new Date().toISOString(),
            credentials: {...current.credentials, claudeAiOauth: next},
        });
    } finally {
        releaseRefreshLock(lock);
    }
}

/**
 * A usable access token for a saved account: the live one when that account
 * is the active login (Claude Code keeps it fresh), else the stored one,
 * refreshed first when stale.
 */
export async function accessTokenFor(session, name) {
    const profile = readProfile(name);
    if (!profile)
        throw coded('no_account', `no saved account named ${name}`);
    // THE RULE: a name that resolves to the live login returns the live token
    // or throws no_token; it never reaches the refresh below, whatever its
    // stored copy says. Its stored refresh token is the one Claude Code holds.
    if (liveAccountName() === name) {
        const live = readLiveCredentials();
        if (live)
            return {token: live.claudeAiOauth.accessToken, source: 'live'};
        throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
    }
    switch (tokenState(profile)) {
    case 'valid':
        return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
    case 'stale': {
        const fresh = await refreshProfile(session, profile);
        return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
    }
    default:
        throw coded('login_expired',
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
    // The live login by its account block, with credentials we cannot read:
    // refreshing or reinstalling the stored copy would spend or overwrite the
    // refresh token Claude Code is running on. Wait for it to be readable.
    if (!readLiveCredentials() && liveAccountName() === name)
        throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
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

/** Normalized usage for one saved account, or {ok: false, code, message};
 *  `source` is where the token came from (accountHealth's `live`).
 *  A token taken from the live login is Claude Code's to keep fresh, so its
 *  refusal is reported as the live login's (no label, so the message keeps the
 *  refresh hint); a stored or refreshed one names the profile. Same rule as
 *  claude-code/login-usage.js. */
export async function usageFor(session, name) {
    let token, source;
    try {
        ({token, source} = await accessTokenFor(session, name));
    } catch (e) {
        // The store's own codes are what accountHealth() tells a broken login
        // from a merely unreachable one with.
        return {name, ok: false, code: e.code ?? 'no_token', message: e.message};
    }
    const result = await fetchUsage(session, token, {label: source === 'live' ? null : name});
    return {name, source, ...result};
}

// The panels and the MCP server drop the latest per-account worst limit here
// so the status line (no network, no credentials) can hint at a freer account.
export function writeUsageCache(results, nowMs = Date.now()) {
    const accounts = {};
    for (const [name, r] of Object.entries(results)) {
        if (r?.ok)
            accounts[name] = usageCacheEntry(r.cards, nowMs);
    }
    try {
        writePrivate(usageCachePath(), JSON.stringify({at: nowMs, accounts}));
    } catch (e) {
        logError(e, 'claude-usage-panel: could not write the account usage cache');
    }
}
