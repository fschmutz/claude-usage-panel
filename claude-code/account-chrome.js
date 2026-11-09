// `claudectl account chrome NAME [--url U]`: an isolated Google Chrome for one
// saved account. Its own persistent profile (--user-data-dir, mode 0700) under
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
// The first launch opens both pages; later launches open the profile as it is.
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
import {onPath, toolEnv} from './tools.js';

/** The Claude extension's Chrome Web Store id. */
export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const HOST_NAME = 'com.anthropic.claude_code_browser_extension';
const STORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`;
const LOGIN_URL = 'https://claude.ai/login';

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

  /** What a launch does, without doing it: {dir, firstRun, manifest, argv}. */
  function plan(name, {url} = {}) {
    const profile = store.readProfile(name);
    if (!profile) throw new Error(`no saved account named ${name}`);
    const dir = path.join(chromeProfilesDir(io), profile.name);
    const firstRun = !fs.existsSync(path.join(dir, 'Default', 'Extensions', EXTENSION_ID));
    const urls = firstRun ? [LOGIN_URL, STORE_URL] : [url ?? 'https://claude.ai/'];
    if (firstRun && url) urls.push(url);
    return {
      name: profile.name, dir, firstRun, host: liveHost(),
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

  return {plan, prepare, launch};
}
