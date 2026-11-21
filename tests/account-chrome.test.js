// `claudectl account chrome [NAME]`: an isolated Chrome profile per saved
// account. Throwaway HOME and state dir, a stub chrome on PATH, a recording
// spawn: no real Chrome starts and the real ~/.config/google-chrome is never
// read or written.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {EXTENSION_ID, EXTENSION_PAGE, LOGIN_URL, STORE_URL, openAccountChrome} from '../claude-code/account-chrome.js';
import {main} from '../claude-code/account-cli.js';
import {openStore} from '../claude-code/accounts.js';
import {account, creds, crx, fakeExtension, world} from './accounts-world.js';

const modeOf = (p) => fs.statSync(p).mode & 0o777;

const CLAUDE_MANIFEST = {permissions: ['tabs', 'nativeMessaging'], host_permissions: ['<all_urls>'],
  content_scripts: [{matches: ['https://claude.ai/*']}]};

/** mainExt: the main Chrome's Profile 2 holds the extension; download: the
 *  update service answers with this CRX (else it fails). */
function setup({host = true, mainExt = false, download = null} = {}) {
  const w = world();
  const bin = path.join(w.home, 'bin');
  fs.mkdirSync(bin, {recursive: true});
  fs.writeFileSync(path.join(bin, 'google-chrome-stable'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'google-chrome-stable'), 0o755);
  if (host) {
    fs.mkdirSync(path.join(w.home, '.claude', 'chrome'), {recursive: true});
    fs.writeFileSync(path.join(w.home, '.claude', 'chrome', 'chrome-native-host'), '#!/bin/sh\n');
  }
  const spawned = [];
  const fetched = [];
  const mainChromeDir = path.join(w.home, 'main-chrome');
  if (mainExt) fakeExtension(path.join(mainChromeDir, 'Profile 2'), EXTENSION_ID, '1.0.107', CLAUDE_MANIFEST);
  const io = {
    ...w.io, platform: 'linux', homedir: w.home, toolDirs: [bin], mainChromeDir, chromeVersion: '158.0.1.2',
    fetchImpl: async (url) => {
      fetched.push(url);
      return download ? {ok: true, status: 200, arrayBuffer: async () => download} : {ok: false, status: 503};
    },
    env: {PATH: bin, XDG_STATE_HOME: path.join(w.home, 'state')},
    spawn: (cmd, args, opts) => {
      spawned.push({cmd, args, opts});
      return {unref() {}};
    },
  };
  const s = openStore(io);
  s.saveCurrent('PRO');
  s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
  return {...w, io, spawned, fetched};
}

test('chrome: NAME gets its own 0700 profile with the native host laid in it, detached', async () => {
  const t = setup({mainExt: true});
  const p = await openAccountChrome(t.io).launch('PERSO');
  assert.equal(p.dir, path.join(t.home, 'state', 'claude-usage-panel', 'chrome', 'PERSO'));
  assert.equal(modeOf(p.dir), 0o700);
  const m = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
  assert.equal(m.path, path.join(t.home, '.claude', 'chrome', 'chrome-native-host'));
  assert.deepEqual(m.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(modeOf(p.manifest), 0o600);
  assert.equal(t.spawned.length, 1);
  const {cmd, args, opts} = t.spawned[0];
  assert.equal(cmd, 'google-chrome-stable', 'branded Chrome, found on PATH');
  assert.ok(args.includes(`--user-data-dir=${p.dir}`), 'never the main profile');
  assert.deepEqual(opts, {detached: true, stdio: 'ignore'});
  assert.ok(!fs.existsSync(path.join(t.home, '.config', 'google-chrome')), 'the main Chrome profile is untouched');
});

test('chrome: a missing extension is copied from the main Chrome and registered before Chrome starts', async () => {
  const t = setup({mainExt: true});
  const x = openAccountChrome(t.io);
  assert.equal(x.plan('PERSO').install.from, 'main Chrome Profile 2 (1.0.107)');
  const p = await x.launch('PERSO', {url: 'https://example.test/claim'});
  assert.deepEqual(p.installed, {version: '1.0.107', from: 'main Chrome Profile 2'});
  assert.equal(p.extension, true);
  assert.deepEqual(t.spawned[0].args.slice(-3), [LOGIN_URL, EXTENSION_PAGE, 'https://example.test/claim'],
    'no Web Store tab; the extension\'s own Sign in page');
  const entry = JSON.parse(fs.readFileSync(path.join(p.dir, 'Default', 'Preferences'), 'utf8'))
    .extensions.settings[EXTENSION_ID];
  assert.equal(entry.location, 1);
  assert.equal(entry.path, `${EXTENSION_ID}/1.0.107_0`);
  assert.deepEqual(entry.disable_reasons, []);
  assert.deepEqual(entry.granted_permissions, {api: ['tabs', 'nativeMessaging'], explicit_host: ['<all_urls>'],
    manifest_permissions: [], scriptable_host: ['https://claude.ai/*']}, 'exactly what the manifest declares');
  assert.ok(fs.existsSync(path.join(p.dir, 'Default', 'Extensions', EXTENSION_ID, '1.0.107_0', 'manifest.json')));
  assert.equal(t.fetched.length, 0, 'offline when the main Chrome has a copy');
  const again = await x.launch('PERSO');
  assert.equal(again.installed, undefined, 'installed once');
});

test('chrome: no copy in the main Chrome: the CRX is downloaded, unpacked and registered', async () => {
  const t = setup({download: crx({'manifest.json': JSON.stringify({version: '2.0.1', ...CLAUDE_MANIFEST}),
    'js/sw.js': '//'})});
  const p = await openAccountChrome(t.io).launch('PERSO');
  assert.deepEqual(p.installed, {version: '2.0.1', from: 'Web Store download'});
  assert.match(t.fetched[0], new RegExp(`prodversion=158\\.0\\.1\\.2&.*id%3D${EXTENSION_ID}`));
  assert.ok(fs.existsSync(path.join(p.dir, 'Default', 'Extensions', EXTENSION_ID, '2.0.1_0', 'js', 'sw.js')));
  assert.ok(!t.spawned[0].args.includes(STORE_URL));
});

test('chrome: the Web Store tab opens only when the install cannot happen', async () => {
  const failed = setup();
  const p = await openAccountChrome(failed.io).launch('PERSO');
  assert.equal(STORE_URL, `https://chromewebstore.google.com/detail/claude/${EXTENSION_ID}`);
  assert.match(p.installError, /HTTP 503/);
  assert.deepEqual(failed.spawned[0].args.slice(-2), [LOGIN_URL, STORE_URL]);
  // its Chrome running: Chrome rewrites Preferences on exit, so nothing is written
  const busy = setup({mainExt: true});
  const x = openAccountChrome({...busy.io, hostname: 'box', pidAlive: () => true});
  const dir = x.plan('PERSO').dir;
  fs.mkdirSync(dir, {recursive: true});
  fs.symlinkSync('box-9', path.join(dir, 'SingletonLock'));
  const r = await x.launch('PERSO');
  assert.match(r.install.why, /its Chrome is running/);
  assert.ok(!fs.existsSync(path.join(dir, 'Default', 'Preferences')));
  assert.ok(busy.spawned[0].args.includes(STORE_URL));
  // macOS: not proven there, the tab stays
  const mac = {...busy.io, platform: 'darwin', chromeBin: '/x'};
  openStore(mac).writeProfile({version: 1, name: 'MAC', account: account('mac'), credentials: creds('mac')});
  assert.match(openAccountChrome(mac).plan('MAC').install.why, /Linux only/);
});

test('chrome: the extension\'s own sign-in is read from its storage key names; signed in, no sign-in tab', () => {
  const t = setup();
  const x = openAccountChrome(t.io);
  const def = path.join(x.plan('PERSO').dir, 'Default');
  fakeExtension(def, EXTENSION_ID);
  const db = path.join(def, 'Local Extension Settings', EXTENSION_ID);
  fs.mkdirSync(db, {recursive: true});
  fs.writeFileSync(path.join(db, '000003.log'), 'signInState-x codeVerifier-y');
  assert.equal(x.state('PERSO').extensionSignedIn, false, 'a sign-in started, never finished');
  assert.ok(x.plan('PERSO').argv.includes(EXTENSION_PAGE));
  fs.writeFileSync(path.join(db, '000004.ldb'), 'compressed');
  assert.equal(x.state('PERSO').extensionSignedIn, null, 'a compacted table cannot be read by name');
  fs.writeFileSync(path.join(db, '000005.log'), 'accountUuid tokenOrg tokenScope mcpConnected');
  assert.equal(x.state('PERSO').extensionSignedIn, true, 'the keys a signed-in 1.0.107 writes');
  assert.ok(!x.plan('PERSO').argv.includes(EXTENSION_PAGE));
});

test('chrome: files without a Preferences entry are not an installed extension', () => {
  const t = setup();
  const x = openAccountChrome(t.io);
  const dir = x.plan('PERSO').dir;
  fs.mkdirSync(path.join(dir, 'Default', 'Extensions', EXTENSION_ID, '1.0.0_0'), {recursive: true});
  assert.equal(x.state('PERSO').extension, false);
  fakeExtension(path.join(dir, 'Default'), EXTENSION_ID);
  assert.equal(x.state('PERSO').extension, true);
});

test('chrome: NAME defaults to the current login; an unsaved current login is refused', async () => {
  const t = setup();
  const lines = [];
  assert.equal(await main(['chrome', '--dry-run'], {...t.io, stdout: (s) => lines.push(s)}), 0);
  assert.match(lines.join(''), /would open Chrome for PRO: .*chrome\/PRO\n/);
  openStore(t.io).removeProfile('PRO');
  await assert.rejects(main(['chrome', '--dry-run'], t.io), /current login \(pro@example.com\) is not a saved account/);
  assert.equal(t.spawned.length, 0);
});

test('chrome: a SingletonLock counts as running only while its pid lives on this host', () => {
  const t = setup();
  const alive = new Set([42]);
  const x = openAccountChrome({...t.io, hostname: 'box', pidAlive: (pid) => alive.has(pid)});
  const dir = x.plan('PERSO').dir;
  fs.mkdirSync(dir, {recursive: true});
  assert.equal(x.running(dir), false, 'no lock');
  fs.symlinkSync('box-42', path.join(dir, 'SingletonLock'));
  assert.equal(x.running(dir), true);
  alive.clear();
  assert.equal(x.running(dir), false, 'a crash left the lock behind');
  fs.rmSync(path.join(dir, 'SingletonLock'));
  fs.symlinkSync('other-7', path.join(dir, 'SingletonLock'));
  assert.equal(x.running(dir), true, 'another host holds it');
});

test('chrome: an unknown name, no native host yet, or no Chrome is refused; nothing is started', async () => {
  const t = setup({host: false});
  const x = openAccountChrome(t.io);
  await assert.rejects(x.launch('NOPE'), /no saved account named NOPE/);
  await assert.rejects(x.launch('PERSO'), /no Claude Code native host at .*: run `claude` once and type \/chrome/);
  const noChrome = openAccountChrome({...t.io, toolDirs: [], env: {...t.io.env, PATH: ''}});
  assert.throws(() => noChrome.plan('PERSO'), /Google Chrome not found/);
  await assert.rejects(main(['chrome', 'NOPE'], t.io), /no saved account named NOPE/);
  assert.equal(t.spawned.length, 0);
});

test('chrome: --dry-run prints the plan and starts nothing', async () => {
  const t = setup({mainExt: true});
  const lines = [];
  assert.equal(await main(['chrome', 'PERSO', '--dry-run'], {...t.io, stdout: (s) => lines.push(s)}), 0);
  assert.match(lines.join(''), new RegExp('would open Chrome for PERSO: .*chrome/PERSO\\n' +
    '  claude.ai: NOT signed in - sign in as PERSO .*\\n' +
    '  extension: MISSING - would install it from main Chrome Profile 2 \\(1\\.0\\.107\\)\\n' +
    `  tabs: ${LOGIN_URL} ${EXTENSION_PAGE}\\n`));
  assert.equal(t.spawned.length, 0);
  assert.ok(!fs.existsSync(path.join(t.home, 'state', 'claude-usage-panel', 'chrome', 'PERSO', 'Default')), 'nothing installed');
});
