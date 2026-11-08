// Named Claude Code accounts, the I/O half: save the login Claude Code holds
// right now under a name ("PRO", "PERSO"), and switch between the saved ones
// without a browser. The decisions (what a profile is, which saved login is
// live, token state, the auto-switch rule) are lib/pure/accounts.js, and the
// order the store carries them out in - sync back, refresh under the lock,
// the pending-switch mark, the rename journal - is lib/pure/accountStore.js;
// the GNOME extension runs both too. This file is the Node port those
// sequences run on (node:fs, the macOS Keychain, fetch).
//
// A login is two things: the credentials blob (~/.claude/.credentials.json on
// Linux, the "Claude Code-credentials" login-Keychain item on macOS) and the
// `oauthAccount` block of ~/.claude.json (who the account is). Switching swaps
// exactly those two and touches nothing else - settings, hooks, plugins, MCP
// servers and history stay. Claude Code sessions already running keep the old
// token until they restart; `switchTo` says how many there are.
//
// Saved logins live one file per account under the panel's state dir (0600).
// Claude Code rotates its tokens as it runs, so before every switch the live
// login is written back into its own profile (the stored copy would otherwise
// die with the old refresh token). An idle profile's access token expires
// within hours; it is refreshed with its refresh token when it is needed - for
// the switch, or to read that account's usage - and the rotated tokens are
// written to OUR store only. The live login is Claude Code's to refresh.
//
// `openStore(io)` binds all of this to one home dir, platform, clock, fetch
// and exec (every one overridable, read at call time) so every consumer - the
// claudectl CLI, the MCP tools, the status line, the tests - gets the
// same operations without threading paths through every call. It is also the
// ONE reader of the live login: the usage fetch for the MCP server and the
// Linux status bar goes through it too. The usage half (accessTokenFor, the
// usage fetch and its cache) is accounts-usage.js, bound here to the same io.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

import {
  accountSummary, isTorn, keychainServices, keychainWrite, parseCredentials,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {openStoreCore, runAsync, runSync} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accountStore.js';
import {accountHealth, accountNotices} from '../claude-usage-panel@fschmutz.github.io/lib/pure/notices.js';
import {bindUsage, postToken} from './accounts-usage.js';
import {accountsDir, claudeConfigPath, credentialsPath, nowOf} from './paths.js';
import {readJSON, writePrivate} from './private-fs.js';

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** The credentials in `text` (the file or the Keychain item), or null. */
function credentialsFrom(text) {
  try {
    return parseCredentials(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Where a write to `file` must land: the target of a symlink, so a dotfile
 *  linked from elsewhere stays a link. `file` itself when it is missing. */
function realTarget(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** The plain-file half of the port: the store's own files under `dir`. */
const filePort = {
  readJSON,
  writePrivate,
  exists: (file) => fs.existsSync(file),
  list: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  move: (from, to) => {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  },
  remove: (file) => fs.rmSync(file, {force: true}),
  mkdirPrivate: (dir) => fs.mkdirSync(dir, {recursive: true, mode: 0o700}),
  createExclusive: (file, text) => {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  },
  lockInfo: (file) => {
    try {
      const {mtimeMs} = fs.statSync(file);
      return {text: fs.readFileSync(file, 'utf8'), mtimeMs};
    } catch {
      return null;
    }
  },
  readText: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  uuid: () => crypto.randomUUID(),
};

// The two refusals that name a command name this CLI's.
const CLI_HINTS = {
  finishSwitch: (name) => `\`claudectl account use ${name}\``,
  removeFirst: (name) => `\`claudectl account remove ${name}\` first`,
};

// ── The store ───────────────────────────────────────────────────────────────────

/**
 * Bind the account store to one environment. `io` overrides, all optional:
 * homedir, platform, env, tmpdir, nowMs, exec (execFileSync), fetchImpl
 * (fetch), dir, credentialsPath, configPath. Defaults are the real process.
 */
export function openStore(io = {}) {
  const platform = io.platform ?? process.platform;
  // Read at call time, not bind time: a caller may swap the fake fetch, exec
  // or clock on the same io between operations (the tests do).
  const exec = (...a) => (io.exec ?? execFileSync)(...a);
  const fetchImpl = (...a) => (io.fetchImpl ?? globalThis.fetch)(...a);
  const now = () => nowOf(io);
  const env = io.env ?? process.env;
  // Claude Code's Keychain item for THIS config dir (CLAUDE_CONFIG_DIR moves it).
  const services = keychainServices(env, sha256Hex);
  const dir = io.dir ?? accountsDir(io);
  const credsPath = io.credentialsPath ?? credentialsPath(io);
  const configPath = io.configPath ?? claudeConfigPath(io);

  const security = (args, opts = {}) =>
    exec('/usr/bin/security', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts});

  // ── The live login ──────────────────────────────────────────────────────────

  /** The credentials Claude Code holds now (file, else the macOS Keychain). */
  function readLiveCredentials() {
    try {
      const creds = credentialsFrom(fs.readFileSync(credsPath, 'utf8'));
      if (creds) return creds;
    } catch {
      // fall through
    }
    if (platform !== 'darwin') return null;
    for (const service of services) {
      try {
        const creds = credentialsFrom(security(['find-generic-password', '-s', service, '-w']).trim());
        if (creds) return creds;
      } catch {
        // try the next item name
      }
    }
    return null;
  }

  /** The live access token, or null. */
  function liveAccessToken() {
    return readLiveCredentials()?.claudeAiOauth.accessToken ?? null;
  }

  // macOS keeps the item under the login user's account name; reuse whatever
  // Claude Code wrote so the item we update is the one it reads.
  function keychainAccount() {
    try {
      const m = /"acct"<blob>="([^"]*)"/.exec(security(['find-generic-password', '-s', services[0]]));
      if (m) return m[1];
    } catch {
      // no item yet
    }
    return os.userInfo().username;
  }

  /**
   * Everything the credentials write needs, resolved and checked BEFORE the
   * first live write, so a write that cannot happen throws while the login is
   * still whole. Returns the write itself.
   */
  function prepareLiveCredentials(credentials) {
    const text = JSON.stringify(credentials);
    if (platform !== 'darwin' || fs.existsSync(credsPath)) return () => writePrivate(realTarget(credsPath), text);
    // -U updates the existing item in place, so Claude Code's ACL on it
    // stays. The tokens go on stdin whenever they fit (keychainWrite).
    const write = keychainWrite(keychainAccount(), services[0], text);
    if (!write) throw new Error(`cannot write the Keychain item ${services[0]}: no account name, or credentials that are not valid text`);
    return () => {
      let refused = '';
      try {
        security(write.args, {input: write.stdin ?? undefined, stdio: ['pipe', 'ignore', 'pipe']});
      } catch (e) {
        // a refused argv write exits non-zero: the read-back decides, and
        // the error it raises keeps security's own reason
        refused = String(e.stderr ?? e.message ?? '').trim().split('\n').at(-1) ?? '';
      }
      // `security -i` exits 0 whatever its command did: read the item back.
      let back = null;
      try {
        back = security(['find-generic-password', '-s', services[0], '-w']).trim();
      } catch {
        // no item: the write failed
      }
      if (back !== text) {
        throw new Error(`could not write the Keychain item ${services[0]}${refused ? `: ${refused}` : ''}`);
      }
    };
  }

  /** ~/.claude.json as an object; throws when the file is not one. */
  function readConfig() {
    const cfg = readJSON(configPath);
    if (cfg === null) return {};
    if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${configPath} is not a JSON object`);
    return cfg;
  }

  /** The `oauthAccount` block of ~/.claude.json, or null. */
  function readLiveAccount() {
    const acct = readJSON(configPath)?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
  }

  // ── The shared sequences (lib/pure/accountStore.js) on this port ────────────

  const port = {
    ...filePort,
    ps: () => {
      try {
        return exec('ps', ['-eo', 'args='], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      } catch {
        return null;
      }
    },
    liveCredentials: readLiveCredentials,
    liveAccount: readLiveAccount,
    readConfig,
    // The core patched ONLY oauthAccount into a config it re-read just
    // before; a linked ~/.claude.json stays a link.
    writeConfig: (cfg) => writePrivate(realTarget(configPath), `${JSON.stringify(cfg, null, 2)}\n`),
    prepareCredentials: prepareLiveCredentials,
    writeCredentials: (write) => write(),
    postToken: (body) => postToken(fetchImpl, body),
    now,
  };
  const core = openStoreCore(port, {dir, hints: CLI_HINTS});
  const sync = (gen) => runSync(port, gen);
  const run = (gen) => runAsync(port, gen);

  /** Every valid profile, by name in code-point order (like every port). */
  const listProfiles = () => sync(core.listProfiles());
  const readProfile = (name) => sync(core.readProfile(name));
  const writeProfile = (profile) => sync(core.writeProfile(profile));
  const removeProfile = (name) => sync(core.removeProfile(name));
  /** Rename saved account `from` to `to`: journaled, under `from`'s refresh lock. */
  const renameProfile = (from, to) => run(core.renameProfile(from, to));
  /** Which saved profile the live login is (token first; liveProfileName). */
  const liveAccountName = () => sync(core.liveAccountName());
  /** The unfinished switch ({at, from, to}), or null. */
  const readPendingSwitch = () => sync(core.readPendingSwitch());
  /** Write the live login back into its own profile; its name, or null. */
  const syncBack = () => sync(core.syncBack());
  /** Save the live login as `name` (saveRefusal decides; `force` overrules a taken name). */
  const saveCurrent = (name, opts) => sync(core.saveCurrent(name, opts));
  /** Claude Code processes alive right now - they keep the old token. */
  const runningClaudeCount = () => sync(core.runningClaudeCount());
  const writeLastSwitch = (s) => sync(core.writeLastSwitch(s));
  /** When the last switch happened (epoch ms), or null. */
  const readLastSwitchMs = () => sync(core.readLastSwitchMs());
  /** Make `name` the live login: sync back (or park), refresh, then install. */
  const switchTo = (name) => run(core.switchTo(name));

  const usage = bindUsage({dir, now, fetchImpl, core, sync, run, listProfiles, liveAccessToken});

  /**
   * What every "list" shows: the saved accounts with the active one marked,
   * optionally each one's usage (which also refreshes the status line's cache).
   * Shared by the CLI and the MCP list_accounts tool.
   */
  async function listAccounts({usage: withUsage = false} = {}) {
    syncBack();
    const profiles = listProfiles();
    const active = liveAccountName();
    const results = withUsage ? await usage.usageForAll() : {};
    if (withUsage) usage.writeUsageCache(results);
    const accounts = profiles.map((p) => {
      const r = results[p.name];
      const summary = accountSummary(p, now());
      return {
        ...summary, active: p.name === active,
        cards: r?.ok ? r.cards : null,
        error: r && !r.ok ? r.message : null,
        // The stored dates alone call a refused token "valid"; health folds in
        // what the fetch actually said, so every client reports the same thing.
        // A live token's refusal is Claude Code's to refresh, not the
        // profile's: it reads unreachable, like the panels' active row.
        health: accountHealth({
          tokenState: summary.tokenState, errorCode: r && !r.ok ? r.code : null, live: r?.source === 'live',
        }),
      };
    });
    const live = readLiveAccount();
    const pendingSwitch = readPendingSwitch();
    return {
      active, accounts, live, pendingSwitch,
      notices: accountNotices({
        rows: accounts.map((a) => ({name: a.name, health: a.health})),
        liveEmail: typeof live?.emailAddress === 'string' ? live.emailAddress : null,
        activeName: active, pending: pendingSwitch,
        torn: active !== null && isTorn(profiles, active, live),
      }),
    };
  }

  return {
    // `port` + `hints`: the I/O the shared sequences run on, for a test that
    // records their steps (tests/accounts-store-core.test.js)
    dir, credentialsPath: credsPath, configPath, now, port, hints: CLI_HINTS,
    listProfiles, readProfile, writeProfile, removeProfile, renameProfile,
    readLiveCredentials, liveAccessToken, readLiveAccount, liveAccountName, readPendingSwitch,
    syncBack, saveCurrent, runningClaudeCount,
    writeLastSwitch, readLastSwitchMs, switchTo, listAccounts,
    ...usage,
  };
}
