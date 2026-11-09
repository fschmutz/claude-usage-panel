// `claudectl account exec NAME -- CMD...`: run one command as a saved login
// without switching the live one. The command gets a throwaway Claude Code
// config dir (CLAUDE_CONFIG_DIR) holding only that profile's credentials and
// `oauthAccount` block, so `claude -p ...`, `claude mcp ...` or anything else
// that reads the Claude login acts as NAME while every running session, the
// panels and ~/.claude keep the live login, untouched.
//
// The rules, each pinned by tests/account-exec.test.js:
// - The live login is refused: Claude Code holds its single-use refresh token,
//   and a second holder refreshing it would log the live session out.
// - A stale stored token is refreshed first, under the store's refresh lock
//   (accessTokenFor), so the child starts with a token that lasts.
// - Claude Code rotates tokens as it runs: after the child exits, a rotated
//   login for the same account is written back into the profile, or the
//   profile would keep a dead refresh token.
// - The dir is `<scratch>/claude-exec-<pid>-XXXXXX`, mode 0700, removed when
//   the child exits. One left by a run that died (its pid is gone) is synced
//   back and removed by the next exec, so a crash never strands the only live
//   copy of a rotated token. On macOS the dir's own Keychain item (a hashed
//   service name, never the live one) is written and deleted the same way.
// - Variables that would override the login (ANTHROPIC_API_KEY,
//   ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_SECURESTORAGE_CONFIG_DIR)
//   are dropped from the child's environment.
//
// - The pause waiter hooks (`./install.sh pause`) come along when installed,
//   so a session run this way can be paused and gets `claudectl session
//   send` messages like any other (mail.js).
//
// - Claude Code (re)writes the browser extension's native-messaging host
//   manifest to point into ITS config dir, which here is the throwaway one:
//   once the dir is gone, Claude-in-Chrome is "not connected" for every
//   session. The manifests are recorded before the run (inside the dir, so a
//   crashed run's are too) and put back after it, by exec and by sweep.
//
// The command itself is not restricted: it is the caller's. No other hook,
// MCP server or setting comes along - the config dir holds the login and
// those hooks only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn as nodeSpawn} from 'node:child_process';

import {keychainServices} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';

import {openStore} from './accounts.js';
import os from 'node:os';

import {claudeSettingsPath, scratchDir} from './paths.js';
import {readJSON} from './private-fs.js';
import {pidAlive} from './procs.js';

export const EXEC_PREFIX = 'claude-exec-';
/** The Claude-in-Chrome native-messaging host manifest Claude Code writes. */
const NATIVE_HOST = 'com.anthropic.claude_code_browser_extension.json';
/** Every Chromium-family browser config dir whose NativeMessagingHosts/ it may write. */
const BROWSER_DIRS = {
  linux: ['.config/google-chrome', '.config/google-chrome-beta', '.config/chromium',
    '.config/BraveSoftware/Brave-Browser', '.config/microsoft-edge'],
  darwin: ['Library/Application Support/Google/Chrome', 'Library/Application Support/Chromium',
    'Library/Application Support/BraveSoftware/Brave-Browser', 'Library/Application Support/Microsoft Edge'],
};
/** Variables that would put another login in front of the config dir's. */
export const DROPPED_ENV = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];

/** The environment the child runs in: ours, pointed at `configDir`. */
function childEnv(env, configDir) {
  const out = {...env, CLAUDE_CONFIG_DIR: configDir};
  for (const k of DROPPED_ENV) delete out[k];
  return out;
}

/**
 * Bind exec to one environment. io: everything openStore takes, plus
 * spawn (child_process.spawn), pid (process.pid), pidAlive.
 */
export function openAccountExec(io = {}) {
  const store = openStore(io);
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const spawn = (...a) => (io.spawn ?? nodeSpawn)(...a);
  const alive = (pid) => (io.pidAlive ?? pidAlive)(pid);
  const root = () => scratchDir(io);

  /** The store as seen from inside `configDir`: its login is the child's. */
  const storeIn = (configDir) => openStore({...io, env: childEnv(env, configDir)});

  const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

  /** Keychain item of `configDir`, guarded: never one the live login uses. */
  function dirService(configDir) {
    const [service] = keychainServices(childEnv(env, configDir), sha256Hex);
    if (keychainServices(env, sha256Hex).includes(service)) {
      throw new Error(`refusing the live login's Keychain item ${service}`);
    }
    return service;
  }

  /** Write the rotated login back into `name`'s profile; true when it did. */
  function syncBack(name, configDir) {
    const inside = storeIn(configDir);
    const creds = inside.readLiveCredentials();
    const account = inside.readLiveAccount();
    const profile = store.readProfile(name);
    if (!creds || !profile) return false;
    // Someone logged another account in, in there: not this profile's login.
    if (account?.accountUuid && account.accountUuid !== profile.account?.accountUuid) return false;
    const was = profile.credentials?.claudeAiOauth ?? {};
    const now = creds.claudeAiOauth;
    if (now.refreshToken === was.refreshToken && now.accessToken === was.accessToken) return false;
    store.writeProfile({...profile, credentials: creds, savedAt: new Date(store.now()).toISOString()});
    return true;
  }

  /** The native-host manifest paths of every known browser. */
  function hostManifests() {
    const home = io.homedir ?? os.homedir();
    return (BROWSER_DIRS[platform] ?? []).map((d) => path.join(home, d, 'NativeMessagingHosts', NATIVE_HOST));
  }

  /** Record each manifest as it is now (null: absent) inside `configDir`. */
  function recordHosts(configDir) {
    const before = Object.fromEntries(hostManifests().map((f) => {
      try {
        return [f, fs.readFileSync(f, 'utf8')];
      } catch {
        return [f, null];
      }
    }));
    fs.writeFileSync(path.join(configDir, '.native-hosts.json'), `${JSON.stringify(before)}\n`, {mode: 0o600});
  }

  /** The live login's own native host, the one every manifest should name. */
  const liveHost = () => path.join(env.CLAUDE_CONFIG_DIR || path.join(io.homedir ?? os.homedir(), '.claude'),
    'chrome', 'chrome-native-host');
  const inExecDir = (p) => typeof p === 'string'
    && path.basename(path.dirname(path.dirname(p))).startsWith(EXEC_PREFIX);

  /**
   * Heal every manifest that names a host inside an exec dir (`configDir`'s,
   * or one whose dir is gone or whose run died; a live run's is its own): back to what it was before the run when that
   * was sound, else to the live login's host, else removed - a manifest
   * naming a dir that is gone breaks Claude-in-Chrome for every session.
   * A manifest naming anything else is left alone. Returns the healed files.
   */
  function restoreHosts(configDir = null) {
    let before = {};
    try {
      before = configDir ? JSON.parse(fs.readFileSync(path.join(configDir, '.native-hosts.json'), 'utf8')) : {};
    } catch {
      // nothing recorded: the run never started
    }
    const healed = [];
    for (const f of hostManifests()) {
      let now;
      try {
        now = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        continue;
      }
      if (!inExecDir(now?.path)) continue;
      // another exec still running owns its manifest until it ends
      const dir = path.dirname(path.dirname(now.path));
      const pid = Number(new RegExp(`^${EXEC_PREFIX}(\\d+)-`).exec(path.basename(dir))?.[1]);
      if (dir !== configDir && fs.existsSync(dir) && alive(pid)) continue;
      let was = null;
      try {
        was = typeof before[f] === 'string' ? JSON.parse(before[f]) : null;
      } catch {
        // unreadable record: fall through to the live host
      }
      if (was && typeof was.path === 'string' && !inExecDir(was.path)) fs.writeFileSync(f, before[f]);
      else if (fs.existsSync(liveHost())) fs.writeFileSync(f, `${JSON.stringify({...now, path: liveHost()}, null, 2)}\n`);
      else fs.rmSync(f, {force: true});
      healed.push(f);
    }
    return healed;
  }

  function removeDir(configDir) {
    try {
      restoreHosts(configDir);
    } catch {
      // a manifest we cannot write: never block the cleanup on it
    }
    if (platform === 'darwin') {
      try {
        (io.exec ?? execFileSync)('/usr/bin/security', ['delete-generic-password', '-s', dirService(configDir)],
          {stdio: 'ignore'});
      } catch {
        // no item: nothing to delete
      }
    }
    fs.rmSync(configDir, {recursive: true, force: true});
  }

  /** Dirs left by an exec whose process is gone: sync back, then remove. */
  function sweep() {
    try {
      restoreHosts(); // a crashed run's manifest, whatever became of its dir
    } catch {
      // never block exec on a manifest we cannot write
    }
    let names;
    try {
      names = fs.readdirSync(root());
    } catch {
      return [];
    }
    const swept = [];
    for (const n of names) {
      const m = new RegExp(`^${EXEC_PREFIX}(\\d+)-`).exec(n);
      if (!m || alive(Number(m[1]))) continue;
      const configDir = path.join(root(), n);
      let owner = '';
      try {
        owner = fs.readFileSync(path.join(configDir, '.exec-profile'), 'utf8').trim();
      } catch {
        // died before it was written: nothing to sync back
      }
      if (owner) syncBack(owner, configDir);
      removeDir(configDir);
      swept.push(n);
    }
    return swept;
  }

  /** The live settings' pause waiter hooks (pause-hook.js), and nothing
   *  else: {Event: [group]}, empty when they are not installed. */
  function waiterHooks() {
    const all = readJSON(claudeSettingsPath(io))?.hooks;
    const out = {};
    if (!all || typeof all !== 'object') return out;
    for (const [event, groups] of Object.entries(all)) {
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((g) => ({...g, hooks: (Array.isArray(g?.hooks) ? g.hooks : [])
          .filter((h) => typeof h?.command === 'string' && /[/\\]pause-hook\.js["']?\s/.test(h.command))}))
        .filter((g) => g.hooks.length);
      if (kept.length) out[event] = kept;
    }
    return out;
  }

  /** Make the config dir for `profile`: credentials, oauthAccount, owner,
   *  and the pause waiter hooks when the live settings have them. */
  function prepare(profile) {
    fs.mkdirSync(root(), {recursive: true, mode: 0o700});
    const configDir = fs.mkdtempSync(path.join(root(), `${EXEC_PREFIX}${io.pid ?? process.pid}-`));
    fs.chmodSync(configDir, 0o700);
    fs.writeFileSync(path.join(configDir, '.exec-profile'), `${profile.name}\n`, {mode: 0o600});
    recordHosts(configDir);
    const inside = storeIn(configDir);
    // On macOS the Keychain item goes first (the file does not exist yet, so
    // prepareCredentials picks it), then the file: Claude Code reads either.
    if (platform === 'darwin') {
      dirService(configDir); // throws before any write if it would be the live item
      inside.port.prepareCredentials(profile.credentials)();
    }
    fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(profile.credentials), {mode: 0o600});
    fs.writeFileSync(path.join(configDir, '.claude.json'),
      `${JSON.stringify({oauthAccount: profile.account, hasCompletedOnboarding: true}, null, 2)}\n`, {mode: 0o600});
    const hooks = waiterHooks();
    if (Object.keys(hooks).length) {
      fs.writeFileSync(path.join(configDir, 'settings.json'), `${JSON.stringify({hooks}, null, 2)}\n`, {mode: 0o600});
    }
    return configDir;
  }

  /**
   * Run `argv` as saved login `name`. Resolves to the child's exit code.
   * @param {{stdio?: any}} [opts]
   */
  async function exec(name, argv, {stdio = 'inherit'} = {}) {
    if (!argv.length) throw new Error('exec needs a command after --');
    const profile = store.readProfile(name);
    if (!profile) throw new Error(`no saved account named ${name}`);
    if (store.liveAccountName() === profile.name) {
      throw new Error(`${profile.name} is the current login - run the command directly`);
    }
    sweep();
    await store.accessTokenFor(profile.name); // refreshes a stale token, under the lock
    const configDir = prepare(store.readProfile(profile.name));
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), {stdio, env: childEnv(env, configDir)});
        const forward = (sig) => () => child.kill(sig);
        const handlers = {SIGINT: forward('SIGINT'), SIGTERM: forward('SIGTERM')};
        for (const [s, h] of Object.entries(handlers)) process.on(s, h);
        const done = (fn) => (v) => {
          for (const [s, h] of Object.entries(handlers)) process.off(s, h);
          fn(v);
        };
        child.on('error', done(reject));
        child.on('exit', done((code) => resolve(code ?? 1)));
      });
    } finally {
      try {
        syncBack(profile.name, configDir);
      } finally {
        removeDir(configDir);
      }
    }
  }

  return {exec, sweep, syncBack, dirService, restoreHosts};
}
