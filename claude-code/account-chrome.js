// `claudectl account chrome [NAME] [--url U]`: an isolated Google Chrome for
// one saved account (the current login when NAME is left out). Its own persistent profile (--user-data-dir, mode 0700) under
// the state dir, so nothing of the user's main Chrome profile is read or
// written. In it the Claude extension is signed in to claude.ai as NAME, and
// Claude-in-Chrome pairs a browser with the sessions of the SAME account: a
// Claude Code session on NAME (the current login, or `account exec NAME`)
// drives this window while every other Chrome stays out of it.
//
// What cannot be automated, and is done once per profile, by hand, then kept:
// - signing in to claude.ai as NAME: the stored OAuth login is a token for
//   api.anthropic.com, not a claude.ai web session, and no password goes
//   through a tool;
// - installing the extension from the Chrome Web Store: branded Chrome 137+
//   ignores --load-extension, and force-install policy is system-wide (root,
//   every profile, the main one included).
// Each launch reads the profile's real state (a claude.ai session cookie, the
// extension's folder) and opens the sign-in page and the Web Store page only
// for what is still missing; the human does the rest there.
//
// The extension reaches Claude Code through a native-messaging host; a custom
// --user-data-dir reads its manifest from <profile>/NativeMessagingHosts, so it
// is laid there on every launch, naming the live login's host
// (<claude dir>/chrome/chrome-native-host, written by Claude Code itself).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn as nodeSpawn} from 'node:child_process';

import {openStore} from './accounts.js';
import {chromeProfilesDir} from './paths.js';
import {pidAlive} from './procs.js';
import {onPath, toolEnv} from './tools.js';

/** The Claude extension's Chrome Web Store id. */
export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const HOST_NAME = 'com.anthropic.claude_code_browser_extension';
export const STORE_URL = `https://chromewebstore.google.com/detail/claude/${EXTENSION_ID}`;
export const LOGIN_URL = 'https://claude.ai/login';

/** Branded Google Chrome only, never a bundled Chromium. */
const CHROME = {
  linux: ['google-chrome-stable', 'google-chrome'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
};

export function openAccountChrome(io = {}) {
  const store = openStore(io);
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const spawn = (...a) => (io.spawn ?? nodeSpawn)(...a);

  function chromeBinary() {
    if (io.chromeBin) return io.chromeBin;
    const pathEnv = toolEnv(io).PATH;
    for (const c of CHROME[platform] ?? []) {
      if (path.isAbsolute(c) ? fs.existsSync(c) : onPath(c, pathEnv)) return c;
    }
    throw new Error('Google Chrome not found (google-chrome-stable / google-chrome); install Chrome itself, not Chromium');
  }

  /** The live login's native host, which Claude Code writes on its first /chrome. */
  function liveHost() {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(io.homedir ?? os.homedir(), '.claude');
    return path.join(dir, 'chrome', 'chrome-native-host');
  }

  /** NAME's saved profile, or the current login's when NAME is left out. */
  function resolve(name) {
    const wanted = name ?? store.liveAccountName();
    if (!wanted) {
      const email = store.readLiveAccount()?.emailAddress;
      throw new Error(`the current login${email ? ` (${email})` : ''} is not a saved account - ` +
        '`claudectl account save NAME` saves it, or name one');
    }
    const profile = store.readProfile(wanted);
    if (!profile) throw new Error(`no saved account named ${wanted}`);
    return profile;
  }

  const profileDir = (name) => path.join(chromeProfilesDir(io), name);

  /** The extension's folder holds at least one version: installed in that profile. */
  function hasExtension(dir) {
    try {
      return fs.readdirSync(path.join(dir, 'Extensions', EXTENSION_ID)).length > 0;
    } catch {
      return false;
    }
  }

  /** Chrome holds a user-data-dir by its SingletonLock symlink, "<host>-<pid>",
   *  while it runs; a crash leaves it behind, so the pid must be alive (a
   *  lock from another host counts as held). */
  function running(dir) {
    let target;
    try {
      target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
    } catch {
      return false;
    }
    const m = /^(.*)-(\d+)$/.exec(target);
    if (!m) return true;
    if (m[1] !== (io.hostname ?? os.hostname())) return true;
    return (io.pidAlive ?? pidAlive)(Number(m[2]));
  }

  /** What NAME's profile holds now: {signedIn: true|false|null, extension, running}. */
  function state(name) {
    const dir = profileDir(resolve(name).name);
    return {signedIn: signedIn(name), extension: hasExtension(path.join(dir, 'Default')), running: running(dir)};
  }

  /** What a launch does, without doing it: {name, dir, signedIn, extension,
   *  running, host, manifest, argv}. The sign-in page opens only on a profile
   *  with no claude.ai session, the Web Store page only when the extension
   *  is missing, then `url` (default claude.ai when nothing else opens).
   *  `only`: open `url` alone, whatever is missing (account login). */
  function plan(name, {url, only = false} = {}) {
    const profile = resolve(name);
    const dir = profileDir(profile.name);
    const now = state(profile.name);
    const urls = [];
    if (!(only && url)) {
      if (now.signedIn === false) urls.push(LOGIN_URL);
      if (!now.extension) urls.push(STORE_URL);
    }
    if (url) urls.push(url);
    else if (!urls.length) urls.push('https://claude.ai/');
    return {
      name: profile.name, dir, ...now, host: liveHost(),
      manifest: path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`),
      argv: [chromeBinary(), `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
        '--new-window', ...urls],
    };
  }

  /** Lay the profile (0700) and its native-host manifest. */
  function prepare(p) {
    if (!fs.existsSync(p.host)) {
      throw new Error(`no Claude Code native host at ${p.host}: run \`claude\` once and type /chrome, then retry`);
    }
    fs.mkdirSync(p.dir, {recursive: true, mode: 0o700});
    fs.chmodSync(p.dir, 0o700);
    fs.mkdirSync(path.dirname(p.manifest), {recursive: true, mode: 0o700});
    const manifest = {
      name: HOST_NAME, description: 'Claude Code Browser Extension Native Host', path: p.host, type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    };
    fs.writeFileSync(p.manifest, `${JSON.stringify(manifest, null, 2)}\n`, {mode: 0o600});
  }

  /** Open NAME's Chrome, detached. Returns the plan it ran. */
  function launch(name, opts = {}) {
    const p = plan(name, opts);
    prepare(p);
    const child = spawn(p.argv[0], p.argv.slice(1), {detached: true, stdio: 'ignore'});
    child.unref?.();
    return p;
  }

  /**
   * Whether NAME's profile holds a claude.ai session: a `sessionKey` cookie
   * on .claude.ai that has not expired. Read from a copy of the profile's
   * cookie store (Chrome keeps it open), names and dates only - no cookie
   * value is read. null when that cannot be told (no store yet, no
   * node:sqlite), so a caller only refuses on a definite false.
   */
  function signedIn(name) {
    const db = path.join(profileDir(resolve(name).name), 'Default', 'Cookies');
    if (!fs.existsSync(db)) return false;
    let sqlite;
    try {
      sqlite = process.getBuiltinModule?.('node:sqlite');
    } catch {
      sqlite = null;
    }
    if (!sqlite?.DatabaseSync) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-cookies-'));
    try {
      fs.copyFileSync(db, path.join(tmp, 'Cookies'));
      const conn = new sqlite.DatabaseSync(path.join(tmp, 'Cookies'), {readOnly: true});
      try {
        // Chrome dates: microseconds since 1601-01-01; 0 / has_expires 0 is a session cookie
        // (past Number's safe range today, hence BigInt)
        const nowChrome = (BigInt(Math.floor(store.now())) + 11_644_473_600_000n) * 1000n;
        const q = conn.prepare("SELECT expires_utc, has_expires FROM cookies WHERE name = 'sessionKey' " +
          "AND host_key IN ('.claude.ai', 'claude.ai')");
        q.setReadBigInts(true);
        return q.all().some((r) => !r.has_expires || BigInt(r.expires_utc) > nowChrome);
      } finally {
        conn.close();
      }
    } catch {
      return null;
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  return {resolve, profileDir, plan, prepare, launch, signedIn, state, hasExtension, running, liveHost};
}
