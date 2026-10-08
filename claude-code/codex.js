// Named OpenAI Codex logins, the I/O half: save the ChatGPT login the `codex`
// CLI holds right now under a name, and switch between the saved ones without
// a browser. The decisions (what a profile is, which saved login is live,
// token state, how a recorded rate-limit snapshot becomes cards) are in
// lib/pure/codex.js, the copy the GNOME extension uses too.
//
// A Codex login is ONE file: `auth.json` under the Codex home ($CODEX_HOME,
// else ~/.codex). Switching replaces exactly that file and touches nothing
// else - config.toml, history, MCP servers and sessions stay. Codex processes
// already running keep the old token until they restart.
//
// Three rules this store keeps that are worth stating out loud:
//   - it never touches a Claude login. Different live file, different store
//     directory, different CLI group.
//   - it never mints a token. The Claude store refreshes a parked login
//     because Anthropic documents that grant; OpenAI's is not ours to use, so
//     a stale profile is reported and handed to `codex login`.
//   - it never uploads anything. Everything here is a local file read or a
//     local file write; there is no network client in this module at all.

import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';

import {isValidName, sameJSON, sameName} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {
  CODEX_PROFILE_VERSION, CODEX_SESSION_SCAN_LIMIT, activeCodexName, codexIdentity, codexSummary,
  codexSwitch, codexTokenState, parseCodexProfile, pickRecordedCodexUsage, sameCodexLogin,
  scanCodexSessions,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/codex.js';
import {codexAccountsDir, codexAuthPath, codexSessionsDir} from './paths.js';
import {readJSON, writePrivate} from './private-fs.js';

/** Tail of a session transcript read when looking for the last rate-limit
 *  snapshot. A rollout file grows with the conversation; the newest events are
 *  at the end, and nothing older than the tail would be fresh enough to show. */
const SESSION_TAIL_BYTES = 256 * 1024;
/** How many recent transcripts to look through before giving up (the
 *  contract's CODEX_SESSION_SCAN_LIMIT, one rule for every port). */
const SESSION_SCAN_LIMIT = CODEX_SESSION_SCAN_LIMIT;

/** The last SESSION_TAIL_BYTES of a file, as text; '' when unreadable. */
function readTail(file, bytes = SESSION_TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Bind the Codex store to one environment. `io` overrides, all optional:
 * homedir, platform, env, nowMs, dir, authPath, sessionsDir. Defaults are the
 * real process - the same shape openStore(io) takes, so a caller that already
 * has one passes it straight through. `io.afterSyncBack(name)`, test-only, runs
 * between a switch's sync-back and its re-read of auth.json: the window in
 * which the codex CLI may rotate the tokens in place.
 */
export function openCodexStore(io = {}) {
  const now = () => io.nowMs ?? Date.now();
  const dir = io.dir ?? codexAccountsDir(io);
  const authFile = io.authPath ?? codexAuthPath(io);
  const sessionsDir = io.sessionsDir ?? codexSessionsDir(io);

  const profilePath = (name) => path.join(dir, `${name}.json`);
  const stamp = () => new Date(now()).toISOString();

  /** Every valid profile, by name in code-point order (like every port). */
  function listProfiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const file of names) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const profile = parseCodexProfile(readJSON(path.join(dir, file)), isValidName);
      if (profile && `${profile.name}.json` === file) out.push(profile);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function readProfile(name) {
    if (!isValidName(name)) return null;
    const profile = parseCodexProfile(readJSON(profilePath(name)), isValidName);
    return profile?.name === name ? profile : null;
  }

  function writeProfile(profile) {
    const clean = parseCodexProfile(profile, isValidName);
    if (!clean) throw new Error('not a valid Codex profile');
    writePrivate(profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
    return clean;
  }

  function removeProfile(name) {
    if (!readProfile(name)) throw new Error(`no saved Codex account named ${name}`);
    fs.rmSync(profilePath(name), {force: true});
  }

  /** The auth.json the Codex CLI holds right now, or null. */
  function readLiveAuth() {
    const auth = readJSON(authFile);
    return auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : null;
  }

  /** Which saved profile the live Codex login is, or null. */
  function liveCodexName() {
    return activeCodexName(listProfiles(), readLiveAuth());
  }

  /** Save `auth` (the live login, as read once) under `name`. */
  function snapshotLive(name, auth = readLiveAuth()) {
    if (!auth) throw new Error('no Codex login to save - run `codex login` first');
    return writeProfile({version: CODEX_PROFILE_VERSION, name, savedAt: stamp(), auth});
  }

  /** syncBack, also returning the auth.json it read (and saved, if saved). */
  function syncBackLive() {
    const auth = readLiveAuth();
    if (!auth) return {name: null, auth: null};
    const profiles = listProfiles();
    const name = activeCodexName(profiles, auth);
    if (!name) return {name: null, auth};
    const stored = profiles.find((p) => p.name === name);
    // The blob read above, never a second read: the CLI may rotate in between.
    if (!stored || !sameJSON(stored.auth, auth)) snapshotLive(name, auth);
    return {name, auth};
  }

  /**
   * Write the live login back into its own profile, so the tokens the Codex
   * CLI rotated since the last switch are the ones we keep. Returns the
   * profile name, or null when the live login is not a saved one.
   */
  function syncBack() {
    return syncBackLive().name;
  }

  /** Save the live Codex login as `name`. Refuses a case variant outright and
   *  a name already holding another account unless `force`. */
  function saveCurrent(name, {force = false} = {}) {
    if (!isValidName(name)) {
      throw new Error(`invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    const auth = readLiveAuth();
    if (!auth) throw new Error('no Codex login to save - run `codex login` first');
    const profiles = listProfiles();
    const variant = profiles.find((p) => p.name !== name && sameName(p.name, name));
    if (variant) {
      throw new Error(`${variant.name} already exists - names ignore case, use ${variant.name}`);
    }
    const live = codexIdentity(auth);
    const existing = profiles.find((p) => p.name === name);
    if (existing && !force) {
      const held = codexIdentity(existing.auth);
      if (!sameCodexLogin(held, live)) {
        throw new Error(
          `${name} is already ${held.email ?? 'another account'} - pick another name or --force`);
      }
    }
    const twin = activeCodexName(profiles.filter((p) => p.name !== name), auth);
    if (twin) {
      throw new Error(`this login (${live.email ?? 'no email'}) is already saved as ${twin} - ` +
        `\`claudectl codex remove ${twin}\` first if you meant to rename it`);
    }
    return snapshotLive(name);
  }

  /**
   * Make `name` the live Codex login. The live one is written back into its
   * own profile first, so the tokens the CLI rotated are not lost; an unsaved
   * live login is refused rather than silently overwritten (the Claude store
   * parks one, but only because it can name it from its account block - a
   * Codex auth.json without an id token has nothing to be named from).
   */
  function switchTo(name) {
    const target = readProfile(name);
    if (!target) throw new Error(`no saved Codex account named ${name}`);
    // codexSwitch (lib/pure/codex.js) re-reads auth.json right before the
    // write and syncs a token the CLI rotated meanwhile, rather than lose it.
    const r = codexSwitch(name, {
      syncBack: () => {
        const synced = syncBackLive();
        io.afterSyncBack?.(synced.name);
        return synced;
      },
      readLive: readLiveAuth,
      write: () => writePrivate(authFile, `${JSON.stringify(target.auth, null, 2)}\n`),
    });
    if (r.outcome === 'unsaved') {
      const id = codexIdentity(r.live);
      throw new Error(
        `the current Codex login (${id.email ?? 'unknown account'}) is not saved - ` +
        '`claudectl codex save <NAME>` it first, or it would be lost');
    }
    if (r.outcome === 'busy') {
      throw new Error('the codex CLI kept rewriting auth.json during the switch - ' +
        'nothing was changed, try again');
    }
    const changed = r.outcome === 'switched';
    return {from: r.from, to: name, changed, tokenState: codexTokenState(target, now())};
  }

  // ── Usage, honestly ───────────────────────────────────────────────────────

  /** One directory under sessions/, as codexSessionScan asks for it. */
  function listSessionDir(segments) {
    const dirPath = path.join(sessionsDir, ...segments);
    let entries;
    try {
      entries = fs.readdirSync(dirPath, {withFileTypes: true});
    } catch {
      return [];
    }
    return entries.map((e) => {
      let mtimeMs = null;
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          mtimeMs = fs.statSync(path.join(dirPath, e.name)).mtimeMs;
        } catch {
          // gone between the listing and the stat
        }
      }
      return {name: e.name, dir: e.isDirectory(), mtimeMs};
    });
  }

  /** The newest session transcripts, newest first, capped: the contract's
   *  newest-day-first walk (codexSessionScan), never the whole tree. */
  function recentSessions(limit = SESSION_SCAN_LIMIT) {
    return scanCodexSessions(listSessionDir, limit)
      .map((f) => ({full: path.join(sessionsDir, ...f.path.split('/')), mtimeMs: f.mtimeMs}));
  }

  /**
   * The freshest usage Codex has recorded locally, as cards: the tails of the
   * newest transcripts, handed to pickRecordedCodexUsage (lib/pure/codex.js),
   * which owns every decision. OpenAI publishes no plan-limit endpoint, so
   * this is the whole Codex usage story.
   * @returns {{cards: object[], capturedAt: ?string, reason: ?string}}
   */
  function recordedUsage() {
    const files = recentSessions().map(({full, mtimeMs}) => ({text: readTail(full), mtimeMs}));
    return pickRecordedCodexUsage(files, now());
  }

  /** What every "list" shows: the saved Codex logins with the active one
   *  marked, and - once - the newest recorded reading. Read-only: it writes
   *  nothing (the MCP tool says so), so a caller that wants the rotated live
   *  tokens kept first runs syncBack() itself, as `claudectl codex list` does. */
  function listAccounts({usage = false} = {}) {
    const profiles = listProfiles();
    const active = liveCodexName();
    const accounts = profiles.map((p) => ({
      ...codexSummary(p, now()), active: p.name === active,
    }));
    const recorded = usage ? recordedUsage() : {cards: [], capturedAt: null, reason: null};
    return {active, accounts, live: readLiveAuth(), usage: recorded};
  }

  return {
    dir, authPath: authFile, sessionsDir,
    listProfiles, readProfile, writeProfile, removeProfile,
    readLiveAuth, liveCodexName, syncBack, saveCurrent, switchTo,
    recentSessions, recordedUsage, listAccounts,
  };
}
