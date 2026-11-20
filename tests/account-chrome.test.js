// `claudectl account chrome [NAME]`: an isolated Chrome profile per saved
// account. Throwaway HOME and state dir, a stub chrome on PATH, a recording
// spawn: no real Chrome starts and the real ~/.config/google-chrome is never
// read or written.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {EXTENSION_ID, LOGIN_URL, STORE_URL, openAccountChrome} from '../claude-code/account-chrome.js';
import {main} from '../claude-code/account-cli.js';
import {openStore} from '../claude-code/accounts.js';
import {account, creds, world} from './accounts-world.js';

const modeOf = (p) => fs.statSync(p).mode & 0o777;

function setup({host = true} = {}) {
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
  const io = {
    ...w.io, platform: 'linux', homedir: w.home, toolDirs: [bin],
    env: {PATH: bin, XDG_STATE_HOME: path.join(w.home, 'state')},
    spawn: (cmd, args, opts) => {
      spawned.push({cmd, args, opts});
      return {unref() {}};
    },
  };
  const s = openStore(io);
  s.saveCurrent('PRO');
  s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
  return {...w, io, spawned};
}

test('chrome: NAME gets its own 0700 profile with the native host laid in it, detached', () => {
  const t = setup();
  const p = openAccountChrome(t.io).launch('PERSO');
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

test('chrome: the sign-in and Web Store tabs open only for what is missing, then the url', () => {
  const t = setup();
  const x = openAccountChrome(t.io);
  const first = x.launch('PERSO', {url: 'https://example.test/claim'});
  assert.equal(STORE_URL, `https://chromewebstore.google.com/detail/claude/${EXTENSION_ID}`);
  assert.deepEqual([first.signedIn, first.extension], [false, false]);
  assert.deepEqual(t.spawned[0].args.slice(-3), [LOGIN_URL, STORE_URL, 'https://example.test/claim']);
  // the extension is in, the cookie store is not: the store tab is gone, the sign-in stays
  fs.mkdirSync(path.join(first.dir, 'Default', 'Extensions', EXTENSION_ID, '1.0.0_0'), {recursive: true});
  const later = x.launch('PERSO', {url: 'https://example.test/claim'});
  assert.equal(later.extension, true);
  assert.deepEqual(t.spawned[1].args.slice(-2), [LOGIN_URL, 'https://example.test/claim']);
  assert.deepEqual(x.plan('PERSO', {url: 'https://x.test/', only: true}).argv.slice(-1), ['https://x.test/']);
});

test('chrome: an empty Extensions/<id> folder is not an installed extension', () => {
  const t = setup();
  const x = openAccountChrome(t.io);
  const dir = x.plan('PERSO').dir;
  fs.mkdirSync(path.join(dir, 'Default', 'Extensions', EXTENSION_ID), {recursive: true});
  assert.equal(x.state('PERSO').extension, false);
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
  assert.throws(() => x.launch('NOPE'), /no saved account named NOPE/);
  assert.throws(() => x.launch('PERSO'), /no Claude Code native host at .*: run `claude` once and type \/chrome/);
  const noChrome = openAccountChrome({...t.io, toolDirs: [], env: {...t.io.env, PATH: ''}});
  assert.throws(() => noChrome.plan('PERSO'), /Google Chrome not found/);
  await assert.rejects(main(['chrome', 'NOPE'], t.io), /no saved account named NOPE/);
  assert.equal(t.spawned.length, 0);
});

test('chrome: --dry-run prints the plan and starts nothing', async () => {
  const t = setup();
  const lines = [];
  assert.equal(await main(['chrome', 'PERSO', '--dry-run'], {...t.io, stdout: (s) => lines.push(s)}), 0);
  assert.match(lines.join(''), new RegExp('would open Chrome for PERSO: .*chrome/PERSO\\n' +
    '  claude.ai: NOT signed in - sign in as PERSO .*\\n  extension: MISSING - click "Add to Chrome" .*\\n' +
    `  tabs: ${LOGIN_URL} ${STORE_URL}\\n`));
  assert.equal(t.spawned.length, 0);
});
