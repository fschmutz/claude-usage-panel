// `claudectl account login NAME | --expired`: a fresh Claude Code sign-in for
// a saved account whose login died (the refresh token is gone or refused),
// without touching the live login and without a click. `claude auth login`
// runs in an empty throwaway config dir (account-exec.js `loginDir`), its
// browser step opens in NAME's own isolated Chrome (`claudectl account chrome
// NAME --devtools`, already signed in to claude.ai as NAME), and
// authorize-click.js drives that page through the DevTools port: focus,
// Authorize, the redirect to the CLI's localhost callback. The CLI ends the
// login by itself and the new credentials are written into NAME's profile.
//
// Why a human click used to do nothing (measured 2026-11-22): claude.ai keeps
// Authorize disabled until its window has held focus for 700 ms, and a window
// a background process opens on GNOME Wayland gets no focus. The CLI itself
// was fine: alive, listening on 127.0.0.1, redirect_uri localhost.
//
// The rules, each pinned by tests/account-login.test.js:
// - The live login is refused: Claude Code holds it, and the next sync-back
//   of the live (still dead) credentials would overwrite the fresh profile.
// - `--email` only fills the page in. The login that comes back must resolve
//   to NAME among the saved profiles (account id, else email, within its org:
//   activeAccountName), or nothing is saved.
// - The child's environment is exec's (childEnv): CLAUDE_CONFIG_DIR is the
//   throwaway dir and the variables that would put another login in front of
//   it are dropped. BROWSER is a script that keeps the URL in a 0600 file of
//   that dir (the driver finds OUR page by its state) and hands it to `account
//   chrome` with the CALLER's CLAUDE_CONFIG_DIR, so the Chrome profile's
//   native host keeps naming the live login's, never the dir about to go.
// - The child's output is never echoed (it carries the authorize URL). Its
//   stdin is ours: a code page's one-time code is written there, never
//   printed. It has a deadline (--wait, default 600 s) and is killed past it.
// - A driver step that fails stops the child at once, and the error names the
//   step. Two steps are handed to the human (onManual says which) while the
//   wait goes on: the click, when NAME's Chrome was already open without
//   DevTools, and the hCaptcha challenge claude.ai answers a DevTools click
//   with (measured: every time, navigator.webdriver being true) - never
//   touched here.
// - A Chrome this login started (with its DevTools port) is closed at the
//   end: the port must not outlive the login.
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
import {clickAuthorize, closeBrowser} from './authorize-click.js';
import {browserEndpoint, devtoolsPort} from './cdp.js';
import {childEnv, openAccountExec} from './account-exec.js';
import {openStore} from './accounts.js';
import {claudeBinary} from './tools.js';

export const DEFAULT_WAIT_S = 600;
const CLAUDECTL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claudectl.js');

/** The BROWSER script: keep the URL (0600), then `account chrome NAME
 *  --only --devtools --url=<the URL>` as the caller. */
export function browserScript({node, claudectl, name, configDir, errFile, urlFile}) {
  const conf = configDir ? `CLAUDE_CONFIG_DIR=${shellQuote(configDir)}; export CLAUDE_CONFIG_DIR`
    : 'unset CLAUDE_CONFIG_DIR';
  return `#!/bin/sh\numask 077\nprintf '%s\\n' "$1" >${shellQuote(`${urlFile}.tmp`)} && mv ${shellQuote(`${urlFile}.tmp`)} ${shellQuote(urlFile)}\n${conf}\n` +
    `exec ${shellQuote(node)} ${shellQuote(claudectl)} account chrome ` +
    `${shellQuote(name)} --only --devtools "--url=$1" >/dev/null 2>${shellQuote(errFile)}\n`;
}

/** The authorize URL the BROWSER script kept, once it is there. */
async function authorizeUrl(urlFile, gone, waitMs = 30_000) {
  for (const end = Date.now() + waitMs; !gone() && Date.now() < end;
    await new Promise((r) => setTimeout(r, 200))) {
    try {
      const url = fs.readFileSync(urlFile, 'utf8').trim();
      if (url) return url;
    } catch {
      // not yet
    }
  }
  return null;
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

  /** Run the child to its end or the deadline: {child, done: {code} |
   *  {timedOut} | {interrupted}}. Its stdin is ours (a code page's code). */
  function runChild(argv, childEnvironment, waitMs) {
    const child = spawn(argv[0], argv.slice(1), {stdio: ['pipe', 'ignore', 'ignore'], env: childEnvironment});
    child.stdin?.on('error', () => {}); // a CLI that exited before reading
    const done = new Promise((resolve, reject) => {
      // past the deadline: SIGTERM, SIGKILL 5 s later; settled on the exit
      // only, so the dir is never removed under a CLI still writing in it
      let timedOut = false;
      let killer = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killer = setTimeout(() => child.kill('SIGKILL'), 5000);
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
        clearTimeout(killer);
        for (const [s, h] of Object.entries(handlers)) process.off(s, h);
        fn(v);
      };
      child.on('error', done(reject));
      child.on('exit', done((code) => {
        if (interrupted) resolve({interrupted: true});
        else resolve(timedOut ? {timedOut: true} : {code: code ?? 1});
      }));
    });
    return {child, done};
  }

  /**
   * Sign NAME in afresh. Resolves to {name, tokenState} once the new login is
   * in NAME's profile; throws with a one-line reason otherwise (nothing saved).
   */
  async function login(name, {waitS = DEFAULT_WAIT_S, onWaiting = () => {}, onManual = () => {}} = {}) {
    const p = plan(name);
    exec.sweep();
    const configDir = exec.loginDir();
    const chrome = openAccountChrome(io);
    const profileDir = chrome.profileDir(p.name);
    const startedAt = Date.now();
    const wasRunning = chrome.running(profileDir);
    try {
      const browser = path.join(configDir, 'browser.sh');
      const errFile = path.join(configDir, 'browser.err');
      const urlFile = path.join(configDir, 'authorize.url');
      fs.writeFileSync(browser, browserScript({
        node: io.nodeBin ?? process.execPath, claudectl: io.claudectlJs ?? CLAUDECTL,
        name: p.name, configDir: env.CLAUDE_CONFIG_DIR || null, errFile, urlFile,
      }), {mode: 0o700});
      onWaiting(p);
      const run = runChild(p.argv, {...childEnv(env, configDir), BROWSER: browser}, waitS * 1000);
      let exited = false;
      run.done.then(() => { exited = true; }, () => { exited = true; });
      let stepError = null;
      const driving = (async () => {
        const url = await authorizeUrl(urlFile, () => exited, io.authorizeTimeouts?.url);
        if (!url) {
          if (!exited) onManual(p, 'the CLI opened no page through BROWSER - follow its own browser step');
          return;
        }
        const r = await clickAuthorize({profileDir, authorizeUrl: url, stopped: () => exited, io, since: startedAt,
          timeouts: io.authorizeTimeouts, onCode: (code) => run.child.stdin?.write(`${code}\n`)});
        if (r.manual) onManual(p, r.manual);
      })().catch(async (e) => {
        stepError = e;
        // after a click the consent may still land: the CLI gets 10 s first
        if (e.afterClick) await Promise.race([run.done, new Promise((r) => setTimeout(r, 10_000))]);
        if (!exited) run.child.kill('SIGTERM');
      });
      const r = await run.done;
      // a driver stuck on a dead page must not hold the login: 5 s grace
      await Promise.race([driving, new Promise((ok) => setTimeout(ok, 5000).unref?.())]);
      const why = browserError(errFile);
      const tail = why ? ` (Chrome did not open: ${why})` : '';
      if (r.interrupted) throw Object.assign(new Error(`${p.name}: interrupted, nothing saved`), {interrupted: true});
      if (r.timedOut) throw new Error(`${p.name}: no Authorize within ${waitS}s, nothing saved${tail}`);
      if (stepError && r.code !== 0) {
        throw new Error(`${p.name}: ${stepError.step ? '' : 'the Authorize click failed: '}${stepError.message}, ` +
          `nothing saved${tail}`);
      }
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
      if (!wasRunning) await closeOurChrome(chrome, profileDir, startedAt);
      exec.removeDir(configDir);
    }
  }

  /** Close the Chrome this login started with a DevTools port: only a
   *  running profile whose DevToolsActivePort was written by this run. */
  async function closeOurChrome(chrome, profileDir, startedAt) {
    const d = {port: devtoolsPort, endpoint: browserEndpoint, ...io.devtools};
    try {
      if (!chrome.running(profileDir)) return;
      if (fs.statSync(path.join(profileDir, 'DevToolsActivePort')).mtimeMs < startedAt - 1000) return;
      const port = d.port(profileDir, startedAt);
      if (port) await closeBrowser(await d.endpoint(port), d.connect);
    } catch {
      // nothing of ours to close
    }
  }

  /** The saved logins only a new sign-in repairs, the live one aside. */
  async function expired() {
    const {accounts} = await store.listAccounts({usage: true});
    return accounts.filter((a) => !a.active && needsAttention(a.health)).map((a) => a.name);
  }

  return {plan, login, expired};
}
