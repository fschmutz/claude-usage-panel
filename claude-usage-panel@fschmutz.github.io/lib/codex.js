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

import {readJSON, writeText} from './fs.js';
import {stateDir} from './paths.js';
import {
    CODEX_PROFILE_VERSION, activeCodexName, codexIdentity, codexSummary, codexTokenState,
    isValidName, parseCodexProfile, pickRecordedCodexUsage, sameCodexLogin, sameJSON, sameName,
} from './pure.js';

/** Tail of a session transcript read when looking for the last rate-limit
 *  snapshot: the newest events are at the end of a rollout file. */
const SESSION_TAIL_BYTES = 256 * 1024;
/** How many recent transcripts to look through before giving up. */
const SESSION_SCAN_LIMIT = 8;

const writePrivate = (path, text) => writeText(path, text, {mode: 0o600});

/** The codex CLI's config dir - follows CODEX_HOME, as every port does. */
export function codexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

export function codexAuthPath() {
    return GLib.build_filenamev([codexHome(), 'auth.json']);
}

export function codexSessionsDir() {
    return GLib.build_filenamev([codexHome(), 'sessions']);
}

/** A directory of its own, next to (never inside) the Claude one. */
export function codexAccountsDir() {
    return GLib.build_filenamev([stateDir(), 'codex-accounts']);
}

function profilePath(name) {
    return GLib.build_filenamev([codexAccountsDir(), `${name}.json`]);
}

/** Every valid saved Codex login, by name in code-point order. */
export function listCodexProfiles() {
    const dir = Gio.File.new_for_path(codexAccountsDir());
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
        const profile = parseCodexProfile(
            readJSON(GLib.build_filenamev([codexAccountsDir(), file])), isValidName);
        if (profile && `${profile.name}.json` === file)
            out.push(profile);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readCodexProfile(name) {
    if (!isValidName(name))
        return null;
    const profile = parseCodexProfile(readJSON(profilePath(name)), isValidName);
    return profile?.name === name ? profile : null;
}

function writeCodexProfile(profile) {
    const clean = parseCodexProfile(profile, isValidName);
    if (!clean)
        throw new Error('not a valid Codex profile');
    writePrivate(profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
    return clean;
}

export function removeCodexProfile(name) {
    if (!readCodexProfile(name))
        throw new Error(`no saved Codex account named ${name}`);
    try {
        Gio.File.new_for_path(profilePath(name)).delete(null);
    } catch (e) {
        throw new Error(`could not remove ${name}: ${e.message}`);
    }
}

/** The auth.json the codex CLI holds right now, or null. */
export function readLiveCodexAuth() {
    const auth = readJSON(codexAuthPath());
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
}

/** Which saved profile the live Codex login is, or null. */
export function liveCodexName() {
    return activeCodexName(listCodexProfiles(), readLiveCodexAuth());
}

function snapshotLiveCodex(name) {
    const auth = readLiveCodexAuth();
    if (!auth)
        throw new Error('no Codex login to save - run `codex login` first');
    return writeCodexProfile({
        version: CODEX_PROFILE_VERSION, name, savedAt: new Date().toISOString(), auth,
    });
}

/** Write the live login back into its own profile, so the tokens the codex CLI
 *  rotated since the last switch are the ones we keep. */
export function syncBackCodex() {
    const auth = readLiveCodexAuth();
    if (!auth)
        return null;
    const profiles = listCodexProfiles();
    const name = activeCodexName(profiles, auth);
    if (!name)
        return null;
    const stored = profiles.find(p => p.name === name);
    if (!stored || !sameJSON(stored.auth, auth))
        snapshotLiveCodex(name);
    return name;
}

/** Save the live Codex login as `name`. */
export function saveCurrentCodex(name, {force = false} = {}) {
    if (!isValidName(name)) {
        throw new Error(
            `invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    const auth = readLiveCodexAuth();
    if (!auth)
        throw new Error('no Codex login to save - run `codex login` first');
    const profiles = listCodexProfiles();
    const variant = profiles.find(p => p.name !== name && sameName(p.name, name));
    if (variant)
        throw new Error(`${variant.name} already exists - names ignore case, use ${variant.name}`);
    const live = codexIdentity(auth);
    const existing = profiles.find(p => p.name === name);
    if (existing && !force) {
        const held = codexIdentity(existing.auth);
        if (!sameCodexLogin(held, live)) {
            throw new Error(
                `${name} is already ${held.email ?? 'another account'} - pick another name`);
        }
    }
    const twin = activeCodexName(profiles.filter(p => p.name !== name), auth);
    if (twin) {
        throw new Error(`this login (${live.email ?? 'no email'}) is already saved as ${twin} - ` +
            `remove ${twin} first if you meant to rename it`);
    }
    return snapshotLiveCodex(name);
}

/**
 * Make `name` the live Codex login. The live one is written back into its own
 * profile first; an unsaved live login is refused rather than overwritten.
 */
export function switchCodexTo(name) {
    const target = readCodexProfile(name);
    if (!target)
        throw new Error(`no saved Codex account named ${name}`);
    const from = syncBackCodex();
    const live = readLiveCodexAuth();
    if (live && !from) {
        const id = codexIdentity(live);
        throw new Error(
            `the current Codex login (${id.email ?? 'unknown account'}) is not saved - ` +
            'save it first, or it would be lost');
    }
    const tokenState = codexTokenState(target);
    if (from === name)
        return {from, to: name, changed: false, tokenState};
    writePrivate(codexAuthPath(), `${JSON.stringify(target.auth, null, 2)}\n`);
    return {from, to: name, changed: true, tokenState};
}

// ── Usage, honestly ─────────────────────────────────────────────────────────────

/** The last SESSION_TAIL_BYTES of a file as text; '' when unreadable. */
function readTail(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null)
            .get_size();
        const stream = file.read(null);
        const offset = Math.max(0, size - SESSION_TAIL_BYTES);
        if (offset > 0)
            stream.seek(offset, GLib.SeekType.SET, null);
        const bytes = stream.read_bytes(Math.min(size, SESSION_TAIL_BYTES), null);
        stream.close(null);
        return new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
    } catch {
        return '';
    }
}

/** The newest session transcripts, newest first, capped. */
function recentCodexSessions() {
    const root = Gio.File.new_for_path(codexSessionsDir());
    const files = [];
    const walk = (dir, depth) => {
        if (depth > 4)
            return;
        let children;
        try {
            children = dir.enumerate_children(
                'standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        let info;
        while ((info = children.next_file(null)) !== null) {
            const child = dir.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                walk(child, depth + 1);
            else if (info.get_name().endsWith('.jsonl'))
                files.push({path: child.get_path(), mtime: info.get_attribute_uint64('time::modified')});
        }
    };
    walk(root, 0);
    return files.sort((a, b) => b.mtime - a.mtime).slice(0, SESSION_SCAN_LIMIT);
}

/**
 * The freshest usage Codex has recorded locally, as cards: the tails of the
 * newest transcripts, handed to pickRecordedCodexUsage (lib/pure/codex.js),
 * which owns every decision. OpenAI publishes no plan-limit endpoint, so this
 * is the whole Codex usage story.
 * @returns {{cards: object[], capturedAt: ?string,
 *            reason: ?('no_sessions'|'no_snapshot'|'stale')}}
 */
export function recordedCodexUsage(nowMs = Date.now()) {
    const files = recentCodexSessions()
        .map(({path, mtime}) => ({text: readTail(path), mtimeMs: mtime * 1000}));
    return pickRecordedCodexUsage(files, nowMs);
}

/** Every saved Codex login with the active one marked, plus the summaries.
 *  Read-only; the section runs syncBackCodex() before it, as every port's
 *  panel refresh does. */
export function listCodexAccounts(nowMs = Date.now()) {
    const profiles = listCodexProfiles();
    const active = liveCodexName();
    return {
        active,
        accounts: profiles.map(p => ({...codexSummary(p, nowMs), active: p.name === active})),
        live: readLiveCodexAuth(),
    };
}
