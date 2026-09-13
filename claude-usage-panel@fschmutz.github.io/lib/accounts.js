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
import Soup from 'gi://Soup';

import {fetchUsage} from './claudeUsage.js';
import {claudeConfigPath, credentialsPath, stateDir} from './paths.js';
import {
    PROFILE_VERSION, activeAccountName, isValidName, parseProfile, tokenState, worstPercent,
} from './pure.js';

export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client - the same id the CLI itself refreshes with.
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// The status line reads this snapshot of every account's worst limit; the
// last-switch stamp is what every auto-switch caller - this panel, the macOS
// app, the MCP tool - checks its cooldown against, so a switch made anywhere
// counts everywhere.
const USAGE_CACHE_FILE = '.usage-cache.json';
const LAST_SWITCH_FILE = '.last-switch.json';

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

// ── Files ───────────────────────────────────────────────────────────────────────

function readJSON(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
        return null;
    }
}

// Atomic, private write: tmp file in the same dir, CREATED 0600 (never a
// world-readable instant), then renamed over the target.
function writePrivate(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    const tmp = `${path}.${GLib.get_real_time()}.tmp`;
    GLib.file_set_contents_full(
        tmp, new TextEncoder().encode(text), GLib.FileSetContentsFlags.CONSISTENT, 0o600);
    Gio.File.new_for_path(tmp).move(
        Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
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

/** The credentials Claude Code holds now, or null. */
export function readLiveCredentials() {
    const json = readJSON(credentialsPath());
    const oauth = json?.claudeAiOauth;
    return oauth && typeof oauth === 'object' && typeof oauth.accessToken === 'string'
        ? json : null;
}

function writeLiveCredentials(credentials) {
    writePrivate(credentialsPath(), JSON.stringify(credentials));
}

/** The `oauthAccount` block of ~/.claude.json, or null. */
export function readLiveAccount() {
    const acct = readJSON(claudeConfigPath())?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
}

// Patch ONLY oauthAccount; every other key of ~/.claude.json survives.
function writeLiveAccount(account) {
    const path = claudeConfigPath();
    const cfg = readJSON(path) ?? {};
    if (typeof cfg !== 'object' || Array.isArray(cfg))
        throw new Error(`${path} is not a JSON object`);
    cfg.oauthAccount = account;
    writePrivate(path, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** The saved name of the live login, or null when it was never saved. */
export function liveAccountName() {
    return activeAccountName(listProfiles(), readLiveAccount());
}

/**
 * Write the live login back into its own profile, so the tokens Claude Code
 * rotated since the last switch are the ones we keep. Returns the profile
 * name, or null when the live login is not a saved one.
 */
export function syncBack() {
    const creds = readLiveCredentials();
    const account = readLiveAccount();
    if (!creds || !account)
        return null;
    const name = activeAccountName(listProfiles(), account);
    if (!name)
        return null;
    const stored = readProfile(name);
    const same = stored && JSON.stringify(stored.credentials) === JSON.stringify(creds) &&
        JSON.stringify(stored.account) === JSON.stringify(account);
    if (!same) {
        writeProfile({
            version: PROFILE_VERSION, name, savedAt: new Date().toISOString(),
            account, credentials: creds,
        });
    }
    return name;
}

/** Save the live login as `name`. Refuses to shadow another account's name
 *  or to save one account twice, unless `force`. */
export function saveCurrent(name, {force = false} = {}) {
    if (!isValidName(name)) {
        throw new Error(
            `invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    const creds = readLiveCredentials();
    if (!creds)
        throw new Error('no Claude Code login to save - run `claude auth login` first');
    const account = readLiveAccount() ?? {};
    const profiles = listProfiles();
    const existing = profiles.find(p => p.name === name);
    if (existing && !force && account.accountUuid &&
        existing.account?.accountUuid && existing.account.accountUuid !== account.accountUuid) {
        throw new Error(
            `${name} is already ${existing.account.emailAddress ?? 'another account'} - ` +
            'pick another name or --force');
    }
    const twin = activeAccountName(profiles.filter(p => p.name !== name), account);
    if (twin && !force)
        throw new Error(`this login is already saved as ${twin} - remove it first or --force`);
    return writeProfile({
        version: PROFILE_VERSION, name, savedAt: new Date().toISOString(),
        account, credentials: creds,
    });
}

// A live login that was never saved must not be lost by a switch: park it
// under a name derived from its email ("admin", then "admin-2" ...).
function parkUnsavedLogin() {
    const creds = readLiveCredentials();
    const account = readLiveAccount();
    if (!creds || !account)
        return null;
    const taken = new Set(listProfiles().map(p => p.name));
    const base = String(account.emailAddress ?? 'account').split('@')[0]
        .replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 28) || 'account';
    let name = base;
    for (let n = 2; taken.has(name); n++)
        name = `${base}-${n}`;
    return writeProfile({
        version: PROFILE_VERSION, name, savedAt: new Date().toISOString(),
        account, credentials: creds,
    }).name;
}

/** Claude Code processes alive right now - they keep the old token. */
export function runningClaudeCount() {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['ps', '-eo', 'args='],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            resolve(0);
            return;
        }
        proc.communicate_utf8_async(null, null, (self, res) => {
            try {
                const [, stdout] = self.communicate_utf8_finish(res);
                resolve((stdout ?? '').split('\n')
                    .filter(l => /(^|\/)claude(\s|$)/.test(l.trim())).length);
            } catch {
                resolve(0);
            }
        });
    });
}

// ── Token refresh (our store only) ──────────────────────────────────────────────

function postJSON(session, url, body) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('POST', url);
        const payload = new TextEncoder().encode(JSON.stringify(body));
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(payload));
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (self, result) => {
            try {
                const buf = self.send_and_read_finish(result);
                const status = message.get_status();
                if (status < 200 || status >= 300) {
                    reject(Object.assign(new Error(`HTTP ${status}`), {status}));
                    return;
                }
                resolve(JSON.parse(new TextDecoder('utf-8').decode(buf.get_data())));
            } catch (e) {
                reject(e);
            }
        });
    });
}

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
        body = await postJSON(session, OAUTH_TOKEN_ENDPOINT, {
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: OAUTH_CLIENT_ID,
        });
    } catch (e) {
        const again = e.status === 400 || e.status === 401 ? ' - log in again and save it' : '';
        throw new Error(`${profile.name}: token refresh rejected (${e.message})${again}`);
    }
    if (typeof body?.access_token !== 'string' || !body.access_token)
        throw new Error(`${profile.name}: token refresh returned no access token`);
    const nowMs = Date.now();
    const next = {...oauth, accessToken: body.access_token};
    if (Number.isFinite(Number(body.expires_in)))
        next.expiresAt = nowMs + Number(body.expires_in) * 1000;
    if (typeof body.refresh_token === 'string' && body.refresh_token)
        next.refreshToken = body.refresh_token;
    if (typeof body.scope === 'string')
        next.scopes = body.scope.split(/\s+/).filter(Boolean);
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
    const from = syncBack() ?? parkUnsavedLogin();
    const email = target.account.emailAddress ?? null;
    if (from === name)
        return {from, to: name, changed: false, running: await runningClaudeCount(), email};
    const state = tokenState(target);
    if (state === 'expired') {
        throw new Error(
            `${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
    if (state === 'stale')
        target = await refreshProfile(session, target);
    writeLiveCredentials(target.credentials);
    writeLiveAccount(target.account);
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
        if (!r?.ok)
            continue;
        const pct = key => {
            const c = r.cards.find(x => x.key === key);
            return c ? c.percent : null;
        };
        accounts[name] = {worst: worstPercent(r.cards), session: pct('session'), weekly: pct('weekly_all')};
    }
    try {
        writePrivate(usageCachePath(), JSON.stringify({at: nowMs, accounts}));
    } catch (e) {
        logError(e, 'claude-usage-panel: could not write the account usage cache');
    }
}
