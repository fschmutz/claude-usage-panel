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
// The command itself is not restricted: it is the caller's. No hooks, MCP
// servers or settings come along - the config dir is empty but for the login.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn as nodeSpawn} from 'node:child_process';

import {keychainServices} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';

import {openStore} from './accounts.js';
import {scratchDir} from './paths.js';
import {pidAlive} from './procs.js';

export const EXEC_PREFIX = 'claude-exec-';
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

  function removeDir(configDir) {
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

  /** Make the config dir for `profile`: credentials, oauthAccount, owner. */
  function prepare(profile) {
    fs.mkdirSync(root(), {recursive: true, mode: 0o700});
    const configDir = fs.mkdtempSync(path.join(root(), `${EXEC_PREFIX}${io.pid ?? process.pid}-`));
    fs.chmodSync(configDir, 0o700);
    fs.writeFileSync(path.join(configDir, '.exec-profile'), `${profile.name}\n`, {mode: 0o600});
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

  return {exec, sweep, syncBack, dirService};
}
