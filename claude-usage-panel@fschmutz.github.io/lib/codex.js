// Named OpenAI Codex logins - the GJS I/O behind lib/pure/codex.js. Mirrors
// claude-code/codex.js (the CLI + MCP) and the macOS app's CodexStore: one
// store, one file format, one set of decisions.
//
// A Codex login is ONE file: `auth.json` under the Codex home ($CODEX_HOME,
// else ~/.codex). Switching replaces exactly that file; config, history and
// sessions stay, and a running codex process keeps the old login until it
// restarts.
//
// Three rules worth stating out loud, because this file sits next to the one
// that holds Claude credentials:
//   - it never touches a Claude login. Different live file, different store
//     directory, different section.
//   - it never mints a token. OpenAI's refresh grant is the codex CLI's to
//     use, so a stale profile is reported and handed to `codex login`.
//   - it never uploads anything. There is no HTTP client in this file.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {listChildrenAsync, readJSONAsync, writeTextAsync} from './fs.js';
import {stateDir} from './paths.js';
import {
    CODEX_PROFILE_VERSION, activeCodexName, codexIdentity, codexSummary, codexSwitchAsync,
    codexTokenState, isValidName, parseCodexProfile, pickRecordedCodexUsage, sameJSON,
    scanCodexSessionsAsync,
} from './pure.js';

// Everything here runs on the shell's main loop: every call on the way is the
// async variant (promisified once, in fs.js), so neither the store nor a tree
// of thousands of rollouts ever stalls a frame.

/** Tail of a session transcript read when looking for the last rate-limit
 *  snapshot: the newest events are at the end of a rollout file. */
const SESSION_TAIL_BYTES = 256 * 1024;

const writePrivate = (path, text) => writeTextAsync(path, text, {mode: 0o600});

/** The codex CLI's config dir - follows CODEX_HOME, as every port does. */
function codexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

function codexAuthPath() {
    return GLib.build_filenamev([codexHome(), 'auth.json']);
}

function codexSessionsDir() {
    return GLib.build_filenamev([codexHome(), 'sessions']);
}

/** A directory of its own, next to (never inside) the Claude one. */
function codexAccountsDir() {
    return GLib.build_filenamev([stateDir(), 'codex-accounts']);
}

function profilePath(name) {
    return GLib.build_filenamev([codexAccountsDir(), `${name}.json`]);
}

/** Every valid saved Codex login, by name in code-point order. */
async function listCodexProfiles() {
    const dir = codexAccountsDir();
    const names = (await listChildrenAsync(dir, 'standard::name', info => info.get_name()))
        .filter(file => file.endsWith('.json') && !file.startsWith('.'));
    const out = [];
    for (const file of names) {
        const profile = parseCodexProfile(await readJSONAsync(GLib.build_filenamev([dir, file])), isValidName);
        if (profile && `${profile.name}.json` === file)
            out.push(profile);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function readCodexProfile(name) {
    if (!isValidName(name))
        return null;
    const profile = parseCodexProfile(await readJSONAsync(profilePath(name)), isValidName);
    return profile?.name === name ? profile : null;
}

async function writeCodexProfile(profile) {
    const clean = parseCodexProfile(profile, isValidName);
    if (!clean)
        throw new Error('not a valid Codex profile');
    await writePrivate(profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
    return clean;
}

/** The auth.json the codex CLI holds right now, or null. */
async function readLiveCodexAuth() {
    const auth = await readJSONAsync(codexAuthPath());
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
}

/**
 * Write the live login back into its own profile, so the tokens the codex CLI
 * rotated since the last switch are the ones we keep. `known` ({profiles,
 * auth}) is a listing and a live read the caller already made: nothing is
 * read twice. Returns the live profile's name, the auth.json it read, and the
 * profiles with the one it wrote replaced.
 */
async function syncBackLiveCodex(known = null) {
    const auth = known ? known.auth : await readLiveCodexAuth();
    if (!auth)
        return {name: null, auth: null, profiles: known?.profiles ?? []};
    const profiles = known ? known.profiles : await listCodexProfiles();
    const name = activeCodexName(profiles, auth);
    if (!name)
        return {name: null, auth, profiles};
    const stored = profiles.find(p => p.name === name);
    // The blob read above, never a second read: the CLI may rotate in between.
    if (stored && sameJSON(stored.auth, auth))
        return {name, auth, profiles};
    const written = await writeCodexProfile({
        version: CODEX_PROFILE_VERSION, name, savedAt: new Date().toISOString(), auth,
    });
    return {name, auth, profiles: profiles.map(p => (p.name === name ? written : p))};
}

/**
 * Make `name` the live Codex login. The live one is written back into its own
 * profile first; an unsaved live login is refused rather than overwritten, and
 * a token the codex CLI rotates mid-switch is synced, not lost (codexSwitch).
 */
export async function switchCodexTo(name) {
    const target = await readCodexProfile(name);
    if (!target)
        throw new Error(`no saved Codex account named ${name}`);
    const r = await codexSwitchAsync(name, {
        syncBack: () => syncBackLiveCodex(),
        readLive: readLiveCodexAuth,
        write: () => writePrivate(codexAuthPath(), `${JSON.stringify(target.auth, null, 2)}\n`),
    });
    if (r.outcome === 'unsaved') {
        const id = codexIdentity(r.live);
        throw new Error(
            `the current Codex login (${id.email ?? 'unknown account'}) is not saved - ` +
            'save it first, or it would be lost');
    }
    if (r.outcome === 'busy') {
        throw new Error('the codex CLI kept rewriting auth.json during the switch - ' +
            'nothing was changed, try again');
    }
    return {from: r.from, to: name, changed: r.outcome === 'switched', tokenState: codexTokenState(target)};
}

// ── Usage, honestly ─────────────────────────────────────────────────────────────

/** The last SESSION_TAIL_BYTES of a file as text; '' when unreadable. Every
 *  read is async; the seek is an lseek, no I/O. */
async function readTail(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = await file.query_info_async(
            'standard::size', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        const size = info.get_size();
        const stream = await file.read_async(GLib.PRIORITY_LOW, null);
        try {
            const offset = Math.max(0, size - SESSION_TAIL_BYTES);
            if (offset > 0)
                stream.seek(offset, GLib.SeekType.SET, null);
            const bytes = await stream.read_bytes_async(
                Math.min(size, SESSION_TAIL_BYTES), GLib.PRIORITY_LOW, null);
            return new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
        } finally {
            await stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    } catch {
        return '';
    }
}

/** One directory under sessions/, as codexSessionScan asks for it; [] when
 *  unreadable. */
function listSessionDir(segments) {
    return listChildrenAsync(GLib.build_filenamev([codexSessionsDir(), ...segments]),
        'standard::name,standard::type,time::modified', info => {
            const dir = info.get_file_type() === Gio.FileType.DIRECTORY;
            return {
                name: info.get_name(),
                dir,
                mtimeMs: dir ? null : info.get_attribute_uint64('time::modified') * 1000,
            };
        });
}

/** The newest session transcripts, newest first, capped: the contract's
 *  newest-day-first walk, one awaited listing at a time. */
async function recentCodexSessions() {
    const picked = await scanCodexSessionsAsync(listSessionDir);
    return picked.map(f => ({
        path: GLib.build_filenamev([codexSessionsDir(), ...f.path.split('/')]),
        mtimeMs: f.mtimeMs,
    }));
}

/**
 * The freshest usage Codex has recorded locally, as cards: the tails of the
 * newest transcripts, handed to pickRecordedCodexUsage (lib/pure/codex.js),
 * which owns every decision. OpenAI publishes no plan-limit endpoint, so this
 * is the whole Codex usage story. Async end to end: it never blocks the shell.
 * @param {number} [nowMs] the clock; read when the scan finishes by default
 * @returns {Promise<{cards: object[], capturedAt: ?string,
 *            reason: ?('no_sessions'|'no_snapshot'|'stale')}>}
 */
export async function recordedCodexUsage(nowMs) {
    const sessions = await recentCodexSessions();
    const files = [];
    for (const {path, mtimeMs} of sessions)
        files.push({text: await readTail(path), mtimeMs});
    return pickRecordedCodexUsage(files, nowMs ?? Date.now());
}

/**
 * Every saved Codex login with the active one marked, plus the summaries,
 * after writing the live login back into its profile (the codex CLI rotates
 * its tokens as it runs). The store is listed once and auth.json read once.
 */
export async function readCodexAccounts(nowMs = Date.now()) {
    const [profiles, live] = await Promise.all([listCodexProfiles(), readLiveCodexAuth()]);
    const synced = await syncBackLiveCodex({profiles, auth: live});
    return {
        active: synced.name,
        accounts: synced.profiles.map(p => ({...codexSummary(p, nowMs), active: p.name === synced.name})),
        live,
    };
}
