// Named Claude Code accounts - the GJS port of the account store. The
// decisions are lib/pure/accounts.js and the order they are carried out in
// (sync back before overwrite, refresh under the lock, the pending-switch
// mark, the rename journal) is lib/pure/accountStore.js, the same sequences
// the Node clients run (claude-code/accounts.js); this file only answers
// their I/O steps, all of it Gio async: the store is read on every poll, and
// nothing on the Shell's main loop may block.
//
// A login is two things: ~/.claude/.credentials.json and the `oauthAccount`
// block of ~/.claude.json. Switching swaps exactly those two and touches
// nothing else. Saved logins live one file per account, mode 0600, under the
// panel's state dir. An idle profile's access token is refreshed with its
// refresh token when it is needed, and the result goes to OUR store only -
// the live login is Claude Code's to refresh.

import GLib from 'gi://GLib';

import {readLiveAccount, readLiveCredentials} from './claudeFiles.js';
import {fetchUsage} from './claudeUsage.js';
import {
    createExclusiveAsync, existsAsync, listChildrenAsync, moveAsync, mtimeMsAsync, readJSONAsync,
    readTextAsync, removeAsync, writeTextAsync,
} from './fs.js';
import {jsonMessage, parseBody, send} from './http.js';
import {claudeConfigPath, credentialsPath, stateDir} from './paths.js';
import {run} from './proc.js';
import {
    STORE_FILES, activeIn, keepWeeklyResets, openStoreCore, runAsync, sameJSON, usageCacheEntry,
} from './pure.js';

const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

/** Same root as the usage warehouse, so every client reads one store. */
function accountsDir() {
    return GLib.build_filenamev([stateDir(), 'accounts']);
}

const storePath = file => GLib.build_filenamev([accountsDir(), file]);
// Everything in the store is a secret: created 0600, never world-readable.
const writePrivate = (path, text) => writeTextAsync(path, text, {mode: 0o600});

/** ~/.claude.json as an object ({} when missing); throws when it is not one. */
async function readConfig() {
    const path = claudeConfigPath();
    const cfg = await readJSONAsync(path);
    if (cfg === null)
        return {};
    if (typeof cfg !== 'object' || Array.isArray(cfg))
        throw new Error(`${path} is not a JSON object`);
    return cfg;
}

/**
 * The port the shared sequences run on, bound to one Soup session (the token
 * exchange is the one step that needs it). Writes to Claude Code's two files
 * go through GIO's replace, which writes through a symlink: a ~/.claude.json
 * linked from a dotfiles repo stays a link. Exported with the store dir for
 * the test that records the steps of both JS ports.
 */
export function storePort(session = null) {
    return {dir: accountsDir(), port: portFor(session)};
}

function portFor(session) {
    return {
        readJSON: readJSONAsync,
        exists: existsAsync,
        list: dir => listChildrenAsync(dir, 'standard::name', info => info.get_name()),
        writePrivate,
        move: moveAsync,
        remove: removeAsync,
        mkdirPrivate: dir => GLib.mkdir_with_parents(dir, 0o700),
        createExclusive: createExclusiveAsync,
        lockInfo: async path => {
            const mtimeMs = await mtimeMsAsync(path);
            if (mtimeMs === null)
                return null;
            const text = await readTextAsync(path);
            return text === null ? null : {text, mtimeMs};
        },
        readText: readTextAsync,
        sleep: ms => new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        }),
        ps: async () => {
            const {ok, stdout} = await run(['ps', '-eo', 'args=']);
            return ok ? stdout : null;
        },
        liveCredentials: readLiveCredentials,
        liveAccount: readLiveAccount,
        readConfig,
        writeConfig: cfg => writePrivate(claudeConfigPath(), `${JSON.stringify(cfg, null, 2)}\n`),
        prepareCredentials: credentials => JSON.stringify(credentials),
        writeCredentials: text => writePrivate(credentialsPath(), text),
        postToken: async body => {
            const {status, bytes} = await send(session, jsonMessage('POST', OAUTH_TOKEN_ENDPOINT, body));
            let json = null;
            try {
                json = parseBody(bytes);
            } catch {
                // a 200 without a JSON body carries no access token either
            }
            return {status, json};
        },
        now: () => Date.now(),
        uuid: () => GLib.uuid_string_random(),
        warn: (e, message) => logError(e, `claude-usage-panel: ${message}`),
    };
}

/** Run one shared sequence: `pick(core)` names it. */
function store(pick, session = null) {
    const port = portFor(session);
    return runAsync(port, pick(openStoreCore(port, {dir: accountsDir()})));
}

// ── The store, for the dropdown and the preferences ────────────────────────────

/**
 * What one poll needs, read once and asynchronously: {profiles, liveCreds,
 * liveAccount, pendingSwitch, pendingRename}. `live` ({creds, account}), when
 * the caller already read the live login this poll, is used instead of
 * reading it again.
 */
export const readSnapshot = (live = null) => store(c => c.readSnapshot(live));

export {activeIn};

/** Write the live login back into its own profile; its name, or null. With a
 *  snapshot nothing is read twice, and a profile it writes lands in it. */
export const syncBack = (snap = null) => store(c => c.syncBack(snap));

/** Every valid profile, by name (code-point order, like every other port). */
export const listProfiles = () => store(c => c.listProfiles());

/** The saved name of the live login, or null when it was never saved. */
export const liveAccountName = () => store(c => c.liveAccountName());

export {readLiveAccount};

export const removeProfile = name => store(c => c.removeProfile(name));

/** Rename saved account `from` to `to`: journaled, under `from`'s refresh lock. */
export const renameProfile = (from, to) => store(c => c.renameProfile(from, to));

/** Save the live login as `name` (saveRefusal decides; `force` overrules a taken name). */
export const saveCurrent = (name, opts) => store(c => c.saveCurrent(name, opts));

/** A usable access token for a saved account; `snap` saves the re-reads. */
export const accessTokenFor = (session, name, snap = null) => store(c => c.accessTokenFor(name, snap), session);

/** Make `name` the live login: sync back (or park), refresh, then install. */
export const switchTo = (session, name) => store(c => c.switchTo(name), session);

/** When the last switch happened (by any client), or null. */
export const readLastSwitchMs = () => store(c => c.readLastSwitchMs());

// ── Per-account usage ───────────────────────────────────────────────────────────

/** Normalized usage for one saved account, or {ok: false, code, message};
 *  `source` is where the token came from (accountHealth's `live`).
 *  A token taken from the live login is Claude Code's to keep fresh, so its
 *  refusal is reported as the live login's (no label, so the message keeps the
 *  refresh hint); a stored or refreshed one names the profile. Same rule as
 *  claude-code/login-usage.js. */
export async function usageFor(session, name, snap = null) {
    let token, source;
    try {
        ({token, source} = await accessTokenFor(session, name, snap));
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
export async function writeUsageCache(results, nowMs = Date.now()) {
    const accounts = {};
    for (const [name, r] of Object.entries(results)) {
        if (r?.ok)
            accounts[name] = usageCacheEntry(r.cards, nowMs);
    }
    try {
        await writePrivate(storePath(STORE_FILES.usageCache), JSON.stringify({at: nowMs, accounts}));
    } catch (e) {
        logError(e, 'claude-usage-panel: could not write the account usage cache');
    }
}

// Each account's weekly reset, kept past the poll that read it: a login that
// cannot be read right now still shows when its week restarts. Same file and
// shape as the macOS app ({NAME: epochMs}); keepWeeklyResets decides.
export async function updateWeeklyResets(results, names, nowMs = Date.now()) {
    const path = storePath(STORE_FILES.weeklyResets);
    const prev = await readJSONAsync(path);
    const fresh = Object.fromEntries(
        Object.entries(results).filter(([, r]) => r?.ok).map(([name, r]) => [name, r.cards]));
    const kept = keepWeeklyResets(prev, fresh, names, nowMs);
    if (!sameJSON(prev ?? {}, kept)) {
        try {
            await writePrivate(path, JSON.stringify(kept));
        } catch (e) {
            logError(e, 'claude-usage-panel: could not write the weekly resets');
        }
    }
    return kept;
}
