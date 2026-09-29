// Named OpenAI Codex logins, the I/O half: save the ChatGPT login the `codex`
// CLI holds right now under a name, and switch between the saved ones without
// a browser. The decisions (what a profile is, which saved login is live,
// token state, how a recorded rate-limit snapshot becomes cards) are in
// codex-contract.js.
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

import {isValidName, sameJSON, sameName} from './accounts-contract.js';
import {
  CODEX_PROFILE_VERSION, activeCodexName, codexIdentity, codexSummary, codexTokenState,
  parseCodexProfile, pickRecordedCodexUsage, sameCodexLogin,
} from './codex-contract.js';
import {codexAccountsDir, codexAuthPath, codexSessionsDir} from './paths.js';
import {readJSON, writePrivate} from './private-fs.js';

/** Tail of a session transcript read when looking for the last rate-limit
 *  snapshot. A rollout file grows with the conversation; the newest events are
 *  at the end, and nothing older than the tail would be fresh enough to show. */
export const SESSION_TAIL_BYTES = 256 * 1024;
/** How many recent transcripts to look through before giving up. */
export const SESSION_SCAN_LIMIT = 8;

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
 * has one passes it straight through.
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

  function snapshotLive(name) {
    const auth = readLiveAuth();
    if (!auth) throw new Error('no Codex login to save - run `codex login` first');
    return writeProfile({version: CODEX_PROFILE_VERSION, name, savedAt: stamp(), auth});
  }

  /**
   * Write the live login back into its own profile, so the tokens the Codex
   * CLI rotated since the last switch are the ones we keep. Returns the
   * profile name, or null when the live login is not a saved one.
   */
  function syncBack() {
    const auth = readLiveAuth();
    if (!auth) return null;
    const profiles = listProfiles();
    const name = activeCodexName(profiles, auth);
    if (!name) return null;
    const stored = profiles.find((p) => p.name === name);
    if (!stored || !sameJSON(stored.auth, auth)) snapshotLive(name);
    return name;
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
    const from = syncBack();
    const live = readLiveAuth();
    if (live && !from) {
      const id = codexIdentity(live);
      throw new Error(
        `the current Codex login (${id.email ?? 'unknown account'}) is not saved - ` +
        '`claudectl codex save <NAME>` it first, or it would be lost');
    }
    if (from === name) {
      return {from, to: name, changed: false, tokenState: codexTokenState(target, now())};
    }
    writePrivate(authFile, `${JSON.stringify(target.auth, null, 2)}\n`);
    return {from, to: name, changed: true, tokenState: codexTokenState(target, now())};
  }

  // ── Usage, honestly ───────────────────────────────────────────────────────

  /** The newest session transcripts, newest first, capped. */
  function recentSessions(limit = SESSION_SCAN_LIMIT) {
    let entries;
    try {
      entries = fs.readdirSync(sessionsDir, {withFileTypes: true, recursive: true});
    } catch {
      return [];
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const full = path.join(e.parentPath ?? e.path ?? sessionsDir, e.name);
      try {
        files.push({full, mtimeMs: fs.statSync(full).mtimeMs});
      } catch {
        // gone between the listing and the stat
      }
    }
    return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
  }

  /**
   * The freshest usage Codex has recorded locally, as cards: the tails of the
   * newest transcripts, handed to pickRecordedCodexUsage (codex-contract.js),
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
