// `claudectl account login NAME | --expired`: a fresh Claude Code sign-in for
// a saved account whose login died (the refresh token is gone or refused),
// without touching the live login. `claude auth login` runs in an empty
// throwaway config dir (account-exec.js `loginDir`), its browser step opens in
// NAME's own isolated Chrome (`claudectl account chrome NAME --url=...`, which
// is already signed in to claude.ai as NAME), the human clicks Authorize, the
// CLI's localhost callback ends the login by itself, and the new credentials
// are written into NAME's profile. No code is pasted and nothing is typed.
//
// The rules, each pinned by tests/account-login.test.js:
// - The live login is refused: Claude Code holds it, and the next sync-back
//   of the live (still dead) credentials would overwrite the fresh profile.
// - `--email` only fills the page in. The login that comes back must resolve
//   to NAME among the saved profiles (account id, else email, within its org:
//   activeAccountName), or nothing is saved.
// - The child's environment is exec's (childEnv): CLAUDE_CONFIG_DIR is the
//   throwaway dir and the variables that would put another login in front of
//   it are dropped. BROWSER is a script that hands the URL to `account chrome`
//   with the CALLER's CLAUDE_CONFIG_DIR, so the Chrome profile's native host
//   keeps naming the live login's, never the dir about to be removed.
// - The child's output is never echoed (it carries the authorize URL). It
//   gets no stdin, a deadline (--wait, default 600 s) and is killed past it.
// - A profile whose Chrome holds no claude.ai session (no live `sessionKey`
//   cookie) is refused up front with the sign-in step, and the browser step
//   opens the authorize URL alone (`account chrome --only`), never the
//   first-launch tabs.
// - `account chrome` is planned before anything runs (Chrome found, the live
//   native host present), so a browser step that cannot happen fails at once
//   instead of after the whole wait.
// - A signal (Ctrl-C) stops the child and is reported as `interrupted`, so a
//   batch (--expired) stops there instead of opening the next account.
// - The new login replaces only what it brings: the rest of NAME's stored
//   credentials blob (its mcpOAuth) is kept.
// - The dir is removed afterwards (with its macOS Keychain item and the
//   native-host manifests restored, like an exec dir), on every path.

import fs from 'node:fs';
import path from 'node:path';
import {spawn as nodeSpawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {activeAccountName, tokenState} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {needsAttention} from '../claude-usage-panel@fschmutz.github.io/lib/pure/notices.js';
import {shellQuote} from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';

import {openAccountChrome} from './account-chrome.js';
import {childEnv, openAccountExec} from './account-exec.js';
import {openStore} from './accounts.js';
import {claudeBinary} from './tools.js';

export const DEFAULT_WAIT_S = 600;
const CLAUDECTL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claudectl.js');

/** The BROWSER script: `account chrome NAME --url=<the URL>` as the caller. */
export function browserScript({node, claudectl, name, configDir, errFile}) {
  const conf = configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)}; export CLAUDE_CONFIG_DIR`
    : 'unset CLAUDE_CONFIG_DIR';
  return `#!/bin/sh\n${conf}\nexec ${shellQuote(node)} ${shellQuote(claudectl)} account chrome ` +
    `${shellQuote(name)} --only "--url=$1" >/dev/null 2>${shellQuote(errFile)}\n`;
}

/** The last line `account chrome` wrote to stderr, for a failure's reason. */
function browserError(errFile) {
  try {
    return fs.readFileSync(errFile, 'utf8').trim().split('\n').pop().replace(/^claudectl: /, '');
  } catch {
    return '';
  }
}

/**
 * Bind login to one environment. io: everything openAccountExec takes, plus
 * spawn, claudeBin (the `claude` CLI), nodeBin, claudectlJs (for the browser
 * script).
 */
export function openAccountLogin(io = {}) {
  const store = openStore(io);
  const exec = openAccountExec(io);
  const env = io.env ?? process.env;
  const spawn = (...a) => (io.spawn ?? nodeSpawn)(...a);

  const claudeBin = () => claudeBinary(io);

  /** What a login of NAME does, without doing it. */
  function plan(name) {
    const profile = store.readProfile(name);
    if (!profile) throw new Error(`no saved account named ${name}`);
    if (store.liveAccountName() === profile.name) {
      throw new Error(`${profile.name} is the current login - Claude Code holds it; run \`claude auth login\` there`);
    }
    const email = typeof profile.account?.emailAddress === 'string' ? profile.account.emailAddress : null;
    const chrome = openAccountChrome(io);
    const where = chrome.plan(profile.name); // throws when Chrome is missing
    if (!fs.existsSync(where.host)) {
      throw new Error(`no Claude Code native host at ${where.host}: run \`claude\` once and type /chrome, then retry`);
    }
    // Authorize needs the profile signed in to claude.ai; signed out, the
    // page bounces to /login and the wait runs out for nothing.
    if (chrome.signedIn(profile.name) === false) {
      throw new Error(`${profile.name}: its Chrome is not signed in to claude.ai - sign in there first ` +
        `(\`claudectl account chrome ${profile.name} --url=https://claude.ai/login\`, the emailed link), then retry`);
    }
    return {
      name: profile.name, email, health: tokenState(profile, store.now()),
      argv: [claudeBin(), 'auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])],
    };
  }

  /** Run the child to its end or the deadline: {code} or {timedOut}. */
  function runChild(argv, childEnvironment, waitMs) {
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {stdio: 'ignore', env: childEnvironment});
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({timedOut: true});
      }, waitMs);
      let interrupted = false;
      const stop = (sig) => () => {
        interrupted = true;
        child.kill(sig);
      };
      const handlers = {SIGINT: stop('SIGINT'), SIGTERM: stop('SIGTERM')};
      for (const [s, h] of Object.entries(handlers)) process.on(s, h);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        for (const [s, h] of Object.entries(handlers)) process.off(s, h);
        fn(v);
      };
      child.on('error', done(reject));
      child.on('exit', done((code) => resolve(interrupted ? {interrupted: true} : {code: code ?? 1})));
    });
  }

  /**
   * Sign NAME in afresh. Resolves to {name, tokenState} once the new login is
   * in NAME's profile; throws with a one-line reason otherwise (nothing saved).
   */
  async function login(name, {waitS = DEFAULT_WAIT_S, onWaiting = () => {}} = {}) {
    const p = plan(name);
    exec.sweep();
    const configDir = exec.loginDir();
    try {
      const browser = path.join(configDir, 'browser.sh');
      const errFile = path.join(configDir, 'browser.err');
      fs.writeFileSync(browser, browserScript({
        node: io.nodeBin ?? process.execPath, claudectl: io.claudectlJs ?? CLAUDECTL,
        name: p.name, configDir: env.CLAUDE_CONFIG_DIR || null, errFile,
      }), {mode: 0o700});
      onWaiting(p);
      const r = await runChild(p.argv, {...childEnv(env, configDir), BROWSER: browser}, waitS * 1000);
      const why = browserError(errFile);
      const tail = why ? ` (Chrome did not open: ${why})` : '';
      if (r.interrupted) throw Object.assign(new Error(`${p.name}: interrupted, nothing saved`), {interrupted: true});
      if (r.timedOut) throw new Error(`${p.name}: no Authorize within ${waitS}s, nothing saved${tail}`);
      if (r.code !== 0) throw new Error(`${p.name}: claude auth login exited ${r.code}, nothing saved${tail}`);
      const inside = openStore({...io, env: childEnv(env, configDir)});
      const creds = inside.readLiveCredentials();
      const acct = inside.readLiveAccount();
      if (!creds || !acct) throw new Error(`${p.name}: the sign-in left no login behind, nothing saved`);
      if (activeAccountName(store.listProfiles(), acct) !== p.name) {
        throw new Error(`${p.name}: signed in as ${acct.emailAddress ?? 'another account'}, not ${p.name} - ` +
          'nothing saved; pick that account on the Authorize page');
      }
      const profile = store.readProfile(p.name);
      const saved = {...profile, account: acct, credentials: {...profile.credentials, ...creds}, savedAt: new Date(store.now()).toISOString()};
      store.writeProfile(saved);
      return {name: p.name, email: acct.emailAddress ?? p.email, tokenState: tokenState(saved, store.now())};
    } finally {
      exec.removeDir(configDir);
    }
  }

  /** The saved logins only a new sign-in repairs, the live one aside. */
  async function expired() {
    const {accounts} = await store.listAccounts({usage: true});
    return accounts.filter((a) => !a.active && needsAttention(a.health)).map((a) => a.name);
  }

  return {plan, login, expired};
}
