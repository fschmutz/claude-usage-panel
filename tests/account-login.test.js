// `claudectl account login NAME | --expired`: a fresh sign-in for a dead
// saved login, in a throwaway config dir, while the live login stays
// byte-for-byte as it was. `claude auth login` is a real node child standing
// in for the CLI (it calls $BROWSER, then writes the login the way the real
// one does); `account chrome` is a stub that records how it was called. The
// HOME, state dir and scratch dir are throwaway. No network, no real Chrome.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn as nodeSpawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openAccountChrome} from '../claude-code/account-chrome.js';
import {main} from '../claude-code/account-cli.js';
import {DROPPED_ENV} from '../claude-code/account-exec.js';
import {browserScript, openAccountLogin} from '../claude-code/account-login.js';
import {openStore} from '../claude-code/accounts.js';
import {account, creds, fakeSecurity, sha256Hex, world} from './accounts-world.js';

// The fake `claude auth login`: records what it saw, opens $BROWSER, then
// signs in as the --email account (MODE=other: someone else; MODE=none:
// writes nothing), or exits EXIT, or hangs (MODE=hang).
const CLAUDE = `
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const dir = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
const email = args[args.indexOf('--email') + 1];
const tag = email.split('@')[0];
fs.writeFileSync(process.env.REPORT + '.' + tag, JSON.stringify({dir, args, env: Object.keys(process.env),
  mode: (fs.statSync(dir).mode & 0o777).toString(8), entries: fs.readdirSync(dir)}));
execFileSync(process.env.BROWSER, ['http://localhost:1234/authorize?x=1']);
if (process.env.MODE === 'hang') setTimeout(() => {}, 60000);
else if (tag.startsWith('beta')) process.exit(2);
else if (process.env.EXIT) process.exit(Number(process.env.EXIT));
else if (process.env.MODE !== 'none') {
  const who = process.env.MODE === 'other' ? 'someone' : tag;
  if (process.env.MODE !== 'account-only') fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({claudeAiOauth: {
    accessToken: 'at-new-' + who, refreshToken: 'rt-new-' + who,
    expiresAt: Date.now() + 8 * 3600e3, subscriptionType: 'max'}}), {mode: 0o600});
  fs.writeFileSync(path.join(dir, '.claude.json'),
    JSON.stringify({oauthAccount: {accountUuid: 'u-' + who, emailAddress: who + '@example.com'}}));
}
`;
// The fake claudectl.js the browser script runs: `account chrome NAME --url=U`.
const CHROME = `
require('node:fs').writeFileSync(process.env.REPORT + '.chrome',
  JSON.stringify({argv: process.argv.slice(2), conf: process.env.CLAUDE_CONFIG_DIR ?? null}));
if (process.env.CHROME_FAIL) { console.error('claudectl: Google Chrome not found'); process.exit(1); }
`;

/** Live login PRO, saved PRO, a dead PERSO (no refresh token left). */
// NAME's Chrome cookie store with a claude.ai sessionKey (or not): only the
// name and dates are ever read, as Chrome lays them out.
const SQLITE = process.getBuiltinModule?.('node:sqlite');
function cookies(dir, rows) {
  fs.mkdirSync(path.join(dir, 'Default'), {recursive: true});
  const db = new SQLITE.DatabaseSync(path.join(dir, 'Default', 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, expires_utc INTEGER, has_expires INTEGER)');
  const add = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) add.run(r.host ?? '.claude.ai', r.name ?? 'sessionKey', 'x', r.expires ?? 0, r.hasExpires ?? 0);
  db.close();
}
const chromeTime = (ms) => (BigInt(ms) + 11_644_473_600_000n) * 1000n;

function setup({env = {}, host = true, platform = 'linux', exec = null, onChild = null, signedIn = true,
  chromeBin = null} = {}) {
  const w = world();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-login-'));
  const report = path.join(scratch, 'report');
  const claude = path.join(scratch, 'claude.cjs');
  const chrome = path.join(scratch, 'claudectl.cjs');
  fs.writeFileSync(claude, CLAUDE);
  fs.writeFileSync(chrome, CHROME);
  // `account chrome` must find a Chrome and the live native host to plan
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'google-chrome'), '#!/bin/sh\n', {mode: 0o755});
  if (host) {
    fs.mkdirSync(path.join(w.home, '.claude', 'chrome'));
    fs.writeFileSync(path.join(w.home, '.claude', 'chrome', 'chrome-native-host'), '#!/bin/sh\n', {mode: 0o755});
  }
  const spawned = [];
  const io = {...w.io, platform, tmpdir: path.join(scratch, 'run'), env: {...env, REPORT: report}, pid: 5151,
    claudeBin: '/fake/claude', claudectlJs: chrome, toolDirs: [bin], ...(exec ? {exec} : {}),
    ...(chromeBin ? {chromeBin} : {}),
    spawn: (cmd, args, opts) => {
      spawned.push({cmd, args});
      const child = nodeSpawn(process.execPath, [claude, ...args], opts);
      if (onChild) onChild(child, opts);
      return child;
    }};
  const s = openStore(io);
  s.saveCurrent('PRO');
  s.writeProfile({version: 1, name: 'PERSO', account: account('perso'),
    credentials: {...creds('perso', {refreshToken: undefined, expiresAt: w.io.nowMs - 1}), mcpOAuth: {x: 1}}});
  if (signedIn && SQLITE) cookies(openAccountChrome(io).plan('PERSO').dir, [{}]);
  const snapshot = () => ({
    creds: fs.readFileSync(path.join(w.home, '.claude', '.credentials.json'), 'utf8'),
    cfg: fs.readFileSync(path.join(w.home, '.claude.json'), 'utf8'),
  });
  const read = (suffix) => JSON.parse(fs.readFileSync(`${report}.${suffix}`, 'utf8'));
  return {...w, s, io, spawned, snapshot, read,
    left: () => (fs.existsSync(io.tmpdir) ? fs.readdirSync(io.tmpdir) : []),
    login: (extraEnv = {}, opts = {}) => openAccountLogin({...io, env: {...io.env, ...extraEnv}})
      .login('PERSO', opts)};
}

test('login: NAME is signed in again in a throwaway dir; the live login and every other profile untouched', async () => {
  const hostile = Object.fromEntries(DROPPED_ENV.map((k) => [k, 'x']));
  const t = setup({env: hostile});
  const before = t.snapshot();
  const pro = fs.readFileSync(path.join(t.s.dir, 'PRO.json'), 'utf8');
  const r = await t.login();
  assert.deepEqual(r, {name: 'PERSO', email: 'perso@example.com', tokenState: 'valid'});
  const saved = t.s.readProfile('PERSO');
  assert.equal(saved.credentials.claudeAiOauth.refreshToken, 'rt-new-perso');
  assert.deepEqual(saved.credentials.mcpOAuth, {x: 1}, 'the rest of the stored blob is kept');
  assert.deepEqual(saved.account, account('perso'));
  const seen = t.read('perso');
  assert.deepEqual(seen.args, ['auth', 'login', '--claudeai', '--email', 'perso@example.com']);
  assert.equal(seen.mode, '700');
  assert.deepEqual(seen.entries.filter((e) => !e.startsWith('.native')).sort(), ['browser.sh'],
    'an empty dir: no login, no owner for a sweep to sync back');
  for (const k of DROPPED_ENV) assert.ok(!seen.env.includes(k), `${k} is dropped`);
  assert.ok(seen.env.includes('BROWSER'));
  assert.deepEqual(t.snapshot(), before, 'live credentials and ~/.claude.json byte-identical');
  assert.equal(fs.readFileSync(path.join(t.s.dir, 'PRO.json'), 'utf8'), pro);
  assert.deepEqual(t.left(), [], 'config dir removed');
});

test('login: the browser step opens NAME\'s Chrome as the caller, never as the throwaway dir', async () => {
  const t = setup();
  await t.login();
  assert.deepEqual(t.read('chrome'), {argv: ['account', 'chrome', 'PERSO', '--only',
    '--url=http://localhost:1234/authorize?x=1'], conf: null}, 'the caller had no CLAUDE_CONFIG_DIR: none');
});

test('login: a sign-in as another account is not saved, and NAME stays byte-identical', async () => {
  const t = setup();
  const file = path.join(t.s.dir, 'PERSO.json');
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(t.login({MODE: 'other'}), /PERSO: signed in as someone@example.com, not PERSO - nothing saved/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(t.left(), []);
});

test('login: an exit code, no login left behind, or no Authorize in time saves nothing', async () => {
  const t = setup();
  const file = path.join(t.s.dir, 'PERSO.json');
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(t.login({EXIT: '3'}), /PERSO: claude auth login exited 3, nothing saved/);
  await assert.rejects(t.login({MODE: 'none'}), /PERSO: the sign-in left no login behind, nothing saved/);
  await assert.rejects(t.login({MODE: 'hang'}, {waitS: 1}), /PERSO: no Authorize within 1s, nothing saved/);
  await assert.rejects(t.login({CHROME_FAIL: '1'}),
    /exited 1, nothing saved \(Chrome did not open: Google Chrome not found\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(t.left(), [], 'the dir is removed on every path');
});

test('login: the live login, an unknown name and a browser step that cannot happen are refused up front', async () => {
  const t = setup();
  const l = openAccountLogin(t.io);
  await assert.rejects(l.login('PRO'), /PRO is the current login/);
  await assert.rejects(l.login('NOPE'), /no saved account named NOPE/);
  const u = setup({host: false});
  await assert.rejects(u.login(), /no Claude Code native host at .*chrome-native-host/);
  await assert.rejects(openAccountLogin({...t.io, toolDirs: []}).login('PERSO'), /Google Chrome not found/);
  assert.deepEqual([...t.spawned, ...u.spawned], []);
  assert.deepEqual([...t.left(), ...u.left()], []);
});

test('login: on macOS the new login is read from the dir\'s own Keychain item, which is then deleted', async () => {
  const keychain = new Map([['Claude Code-credentials', JSON.stringify(creds('pro'))]]);
  const sec = fakeSecurity(keychain);
  const deleted = [];
  const exec = (cmd, args, opts) => {
    if (cmd === '/usr/bin/security' && args[0] === 'delete-generic-password') {
      deleted.push(args[args.indexOf('-s') + 1]);
      keychain.delete(args[args.indexOf('-s') + 1]);
      return '';
    }
    return sec.exec(cmd, args, opts);
  };
  const service = (dir) => `Claude Code-credentials-${sha256Hex(dir.normalize('NFC')).slice(0, 8)}`;
  let svc = null;
  // the real CLI keeps a macOS login in the Keychain, not in the dir's file
  const onChild = (child, opts) => child.once('exit', () => {
    svc = service(opts.env.CLAUDE_CONFIG_DIR);
    keychain.set(svc, JSON.stringify(creds('mac-perso')));
  });
  const t = setup({platform: 'darwin', exec, onChild,
    chromeBin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  t.s = openStore(t.io);
  const r = await t.login({MODE: 'account-only'});
  assert.equal(r.tokenState, 'valid');
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-mac-perso');
  assert.deepEqual(deleted, [svc], 'exactly the dir\'s own item is deleted');
  assert.equal(keychain.get('Claude Code-credentials'), JSON.stringify(creds('pro')), 'live item unchanged');
});

test('login CLI: --dry-run says what would run and spawns nothing; bad usage is refused', async () => {
  const t = setup();
  let text = '';
  const io = {...t.io, stdout: (s) => { text += s; }};
  assert.equal(await main(['login', 'PERSO', '--dry-run'], io), 0);
  assert.match(text, /^PERSO: would run claude auth login --email perso@example.com in a throwaway config dir/);
  assert.deepEqual(t.spawned, []);
  for (const bad of [[], ['PERSO', '--expired'], ['A', 'B'], ['PERSO', '--wait=0'], ['PERSO', '--wait=x']]) {
    await assert.rejects(main(['login', ...bad], io), /usage: claudectl account login NAME\|--expired/);
  }
});

test('login CLI: --expired signs in every dead saved login, the live one aside, past a failure', async () => {
  const t = setup();
  t.s.writeProfile({version: 1, name: 'BETA', account: account('beta'),
    credentials: creds('beta', {refreshToken: undefined})});
  if (SQLITE) cookies(openAccountChrome(t.io).plan('BETA').dir, [{}]);
  t.s.writeProfile({version: 1, name: 'WORK', account: account('work'), credentials: creds('work')});
  let text = '';
  const io = {...t.io, stdout: (s) => { text += s; }};
  assert.deepEqual(await openAccountLogin(io).expired(), ['BETA', 'PERSO']);
  assert.equal(await main(['login', '--expired', '--json'], io), 1, 'one failure fails the run');
  const rows = JSON.parse(text);
  assert.deepEqual(rows.map((r) => [r.name, r.ok]), [['BETA', false], ['PERSO', true]]);
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-new-perso');
  assert.equal(t.s.readProfile('WORK').credentials.claudeAiOauth.refreshToken, 'rt-work');
  assert.deepEqual(t.spawned.map((s) => s.args.at(-1)), ['beta@example.com', 'perso@example.com']);
});

test('browserScript: every value is quoted; the URL is the one argument', () => {
  const s = browserScript({node: '/n o/node', claudectl: "/a'b/claudectl.js", name: 'PERSO', configDir: null,
    errFile: '/d/err'});
  assert.equal(s, "#!/bin/sh\nunset CLAUDE_CONFIG_DIR\nexec '/n o/node' '/a'\\''b/claudectl.js' account chrome " +
    "'PERSO' --only \"--url=$1\" >/dev/null 2>'/d/err'\n");
  assert.match(browserScript({node: 'n', claudectl: 'c', name: 'P', configDir: '/x y', errFile: 'e'}),
    /^#!\/bin\/sh\nCLAUDE_CONFIG_DIR='\/x y'; export CLAUDE_CONFIG_DIR\n/);
});

test('login: a profile signed out of claude.ai is refused before anything runs, with the sign-in step', async () => {
  const t = setup({signedIn: false});
  await assert.rejects(t.login(), /PERSO: its Chrome is not signed in to claude.ai - sign in there first \(`claudectl account chrome PERSO --url=https:\/\/claude.ai\/login`/);
  assert.deepEqual(t.spawned, []);
  assert.deepEqual(t.left(), []);
});

test('account chrome signedIn: a live sessionKey on claude.ai only', {skip: !SQLITE && 'no node:sqlite'}, () => {
  const cases = [
    [[{}], true, 'a session cookie'],
    [[{hasExpires: 1, expires: chromeTime(Date.now() + 86_400_000)}], true, 'not expired yet'],
    [[{hasExpires: 1, expires: chromeTime(Date.now() - 1000)}], false, 'expired'],
    [[{name: 'lastActiveOrg'}], false, 'another cookie'],
    [[{host: '.example.com'}], false, 'another site'],
  ];
  for (const [rows, want, why] of cases) {
    const t = setup({signedIn: false});
    const c = openAccountChrome({...t.io, nowMs: Date.now()});
    cookies(c.plan('PERSO').dir, rows);
    assert.equal(c.signedIn('PERSO'), want, why);
  }
  const t = setup({signedIn: false});
  assert.equal(openAccountChrome(t.io).signedIn('PERSO'), false, 'a profile never launched');
});

test('account chrome --only: the URL alone, never the sign-in or Web Store tabs', () => {
  const t = setup();
  const c = openAccountChrome(t.io);
  const plain = c.plan('PERSO', {url: 'http://localhost:1/x'});
  assert.ok(plain.argv.some((a) => a.includes('chromewebstore')), 'no extension: the Web Store tab');
  const only = c.plan('PERSO', {url: 'http://localhost:1/x', only: true});
  assert.deepEqual(only.argv.slice(-2), ['--new-window', 'http://localhost:1/x']);
});
