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
import {authorizeStep, clickAuthorize, pageSays, pastedCode, where} from '../claude-code/authorize-click.js';
import {openStore} from '../claude-code/accounts.js';
import {account, creds, fakeSecurity, sha256Hex, world} from './accounts-world.js';

// The fake `claude auth login`: records what it saw, opens $BROWSER, then
// signs in as the --email account (MODE=other: someone else; MODE=none:
// writes nothing), or exits EXIT, or hangs (MODE=hang). MODE=click waits for
// the fake page's Authorize click first; MODE=code reads the pasted code from
// stdin (kept in REPORT.code) first.
const CLAUDE = `
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process');
const dir = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
const email = args[args.indexOf('--email') + 1];
const tag = email.split('@')[0];
fs.writeFileSync(process.env.REPORT + '.' + tag, JSON.stringify({dir, args, env: Object.keys(process.env),
  mode: (fs.statSync(dir).mode & 0o777).toString(8), entries: fs.readdirSync(dir)}));
if (process.env.MODE !== 'nobrowser') execFileSync(process.env.BROWSER, [process.env.AUTH_URL]);
if (process.env.MODE === 'hang' || process.env.MODE === 'nobrowser') setTimeout(() => {}, 60000);
else if (process.env.MODE === 'click') {
  const t = setInterval(() => { if (fs.existsSync(process.env.REPORT + '.clicked')) { clearInterval(t); signIn(); } }, 20);
} else if (process.env.MODE === 'code') {
  let buf = '';
  process.stdin.on('data', (d) => { buf += d; if (buf.includes('\\n')) {
    fs.writeFileSync(process.env.REPORT + '.code', buf.trim()); process.stdin.destroy(); signIn(); } });
} else signIn();
function signIn() {
if (process.env.MODE === 'hang' || process.env.MODE === 'nobrowser') return;
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
}
`;
// The URL the fake CLI hands $BROWSER: what the real one sends, state included.
const STATE = 'st-Xy_9';
const AUTH_URL = `https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback&state=${STATE}`;
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
  const io = {...w.io, platform, tmpdir: path.join(scratch, 'run'), env: {...env, REPORT: report, AUTH_URL}, pid: 5151,
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
  assert.deepEqual(t.read('chrome'), {argv: ['account', 'chrome', 'PERSO', '--only', '--devtools',
    `--url=${AUTH_URL}`], conf: null}, 'the caller had no CLAUDE_CONFIG_DIR: none');
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
    errFile: '/d/err', urlFile: '/d/u rl'});
  assert.equal(s, "#!/bin/sh\numask 077\nprintf '%s\\n' \"$1\" >'/d/u rl.tmp' && mv '/d/u rl.tmp' '/d/u rl'\nunset CLAUDE_CONFIG_DIR\n" +
    "exec '/n o/node' '/a'\\''b/claudectl.js' account chrome 'PERSO' --only --devtools \"--url=$1\" >/dev/null 2>'/d/err'\n");
  assert.match(browserScript({node: 'n', claudectl: 'c', name: 'P', configDir: '/x y', errFile: 'e', urlFile: 'u'}),
    /\nCLAUDE_CONFIG_DIR='\/x y'; export CLAUDE_CONFIG_DIR\n/);
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
  assert.equal(plain.install.from, 'Web Store download', 'a missing extension is installed, not a tab');
  const only = c.plan('PERSO', {url: 'http://localhost:1/x', only: true});
  assert.deepEqual(only.argv.slice(-2), ['--new-window', 'http://localhost:1/x']);
});

// ---- the Authorize click (authorize-click.js) against a fake DevTools page ----
// The page is a small state machine: Page.bringToFront focuses it, `onFocus`
// and `onClick` (a mouseReleased at the button) move it on. Every CDP call is
// logged. No socket, no Chrome.
const FAST = {port: 300, load: 300, button: 300, redirect: 300, poll: 5};
const AUTHORIZE = `https://claude.ai/oauth/authorize?code=true&state=${STATE}`;
function fakePage({page = {}, onFocus = (p) => { p.button.disabled = false; }, onClick = () => {},
  port = 9333, targets = null} = {}) {
  const log = [];
  const pg = {href: AUTHORIZE, focus: false, notes: '', text: 'Claude Code would like to connect',
    ...page, button: page.button === null ? null : {disabled: true, busy: false, x: 400, y: 600, visible: true,
      ...page.button}};
  const session = {
    async send(method, params = {}) {
      log.push(params.type ? `${method}:${params.type}@${params.x},${params.y}` : method);
      if (method === 'Page.bringToFront' && !pg.focus) {
        pg.focus = true;
        onFocus(pg);
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') onClick(pg);
      return {};
    },
    async evaluate(expr) {
      if (expr.includes('scrollIntoView')) return !!pg.button;
      return JSON.parse(JSON.stringify(pg));
    },
    close() { log.push('close'); },
  };
  const devtools = {
    port: () => port,
    targets: async () => targets ?? [{url: `https://claude.com/cai/oauth/authorize?state=${STATE}`,
      webSocketDebuggerUrl: 'ws://127.0.0.1/page'}, {url: 'https://claude.ai/new', webSocketDebuggerUrl: 'ws://other'}],
    connect: async (ws) => {
      log.push(`connect ${ws}`);
      return session;
    },
  };
  return {devtools, log, pg};
}
const drive = (f, extra = {}) => clickAuthorize({profileDir: '/p', authorizeUrl: AUTH_URL, io: {devtools: f.devtools},
  timeouts: FAST, ...extra});

test('authorizeStep: where a page stands, from one probe', () => {
  const b = (o) => ({href: AUTHORIZE, button: {disabled: false, busy: false, visible: true, ...o}});
  const cases = [
    [null, 'loading'],
    [{href: 'https://claude.com/cai/oauth/authorize?state=x'}, 'loading'],
    [{href: 'https://claude.ai/login?returnTo=%2Foauth%2Fauthorize'}, 'signed-out'],
    [{href: 'https://claude.ai/magic-link'}, 'signed-out'],
    [{href: AUTHORIZE, button: null}, 'no-button'],
    [b({visible: false}), 'no-button'],
    [b({disabled: true}), 'disabled'],
    [b({busy: true}), 'disabled'],
    [b({}), 'ready'],
    [{href: 'http://localhost:1234/callback?code=c&state=s'}, 'callback'],
    [{href: 'http://127.0.0.1:1234/callback'}, 'callback'],
    [{href: `https://platform.claude.com/oauth/code/callback?code=C1&state=${STATE}`}, 'code'],
    [{href: 'https://platform.claude.com/oauth/code/callback?code=C1&state=someone-else'}, 'loading'],
    [{href: 'chrome-error://chromewebdata/'}, 'error-page'],
  ];
  for (const [probe, want] of cases) assert.equal(authorizeStep(probe, STATE), want, JSON.stringify(probe));
});

test('authorize-click: nothing it prints carries a query, a state or a code', () => {
  const codeUrl = `https://platform.claude.com/oauth/code/callback?code=SECRET1&state=${STATE}`;
  assert.equal(where(codeUrl), 'https://platform.claude.com/oauth/code/callback');
  assert.equal(where(AUTHORIZE), 'https://claude.ai/oauth/authorize');
  assert.equal(where('chrome-error://chromewebdata/'), 'a Chrome error page');
  assert.equal(pageSays({href: codeUrl, text: 'Paste this code: SECRET1#st'}), '', 'a code page says nothing');
  assert.equal(pageSays({href: AUTHORIZE, notes: 'Something went wrong', text: 'x'}), ': "Something went wrong"');
  assert.equal(pastedCode(codeUrl), `SECRET1#${STATE}`);
});

test('authorize-click: focus first (Authorize is disabled until then), one real click, then the callback', async () => {
  const f = fakePage({onClick: (p) => { p.href = 'http://localhost:1234/callback?code=c&state=s'; p.button = null; }});
  assert.deepEqual(await drive(f), {via: 'callback'});
  assert.deepEqual(f.log, ['connect ws://127.0.0.1/page', 'Page.bringToFront',
    'Input.dispatchMouseEvent:mouseMoved@400,600', 'Input.dispatchMouseEvent:mousePressed@400,600',
    'Input.dispatchMouseEvent:mouseReleased@400,600', 'close'], 'OUR page, by its state; never clicked while disabled');
});

test('authorize-click: a code page hands its code over, once', async () => {
  const codes = [];
  const f = fakePage({onClick: (p) => {
    p.href = `https://platform.claude.com/oauth/code/callback?code=C1&state=${STATE}`;
    p.text = 'Authentication Code C1#...';
  }});
  assert.deepEqual(await drive(f, {onCode: (c) => codes.push(c)}), {via: 'code'});
  assert.deepEqual(codes, [`C1#${STATE}`]);
});

test('authorize-click: every failure names its step', async () => {
  const cases = [
    [{page: {href: 'https://claude.ai/login?returnTo=x'}}, /^signed out: the page went to https:\/\/claude.ai\/login - sign in/],
    [{page: {href: 'https://claude.com/cai/oauth/authorize'}}, /^page not loaded within 0.3s \(last at https:\/\/claude.com\/cai\/oauth\/authorize\)$/],
    [{page: {href: 'chrome-error://chromewebdata/'}}, /^page not loaded: Chrome shows an error page/],
    [{page: {button: null, text: 'Your organization does not allow Claude Code'}},
      /^button missing: no Authorize on https:\/\/claude.ai\/oauth\/authorize: "Your organization does not allow/],
    [{onFocus: () => {}}, /^Authorize stayed disabled for 0.3s \(window focused: true\)/],
    [{onClick: (p) => { p.notes = 'Something went wrong. Try again.'; }},
      /^click with no redirect after 0.3s \(still on https:\/\/claude.ai\/oauth\/authorize\): "Something went wrong/],
    [{onClick: (p) => { p.href = 'chrome-error://chromewebdata/'; }}, /^callback refused: Chrome could not reach/],
    [{onClick: (p) => { p.challenge = 'held'; p.button.busy = true; }},
      /^bot check: claude.ai's hCaptcha held the Authorize click without showing a challenge/],
  ];
  for (const [opts, want] of cases) {
    const f = fakePage(opts);
    await assert.rejects(drive(f), (e) => want.test(e.message) && e.step === true, String(want));
    assert.equal(f.log.at(-1), 'close', 'the page session is closed on every path');
  }
});

test('authorize-click: no DevTools port for our page, or a bot check, is handed to the human; a CLI gone stops it', async () => {
  assert.deepEqual(await drive(fakePage({port: null})),
    {manual: 'its Chrome has no DevTools port of this run (it was already open) - click inside that window, then Authorize'});
  assert.deepEqual(await drive(fakePage({targets: [{url: 'https://claude.ai/new', webSocketDebuggerUrl: 'ws://x'}]})),
    {manual: 'its DevTools port shows no page for this request - click inside that window, then Authorize'});
  assert.deepEqual(await drive(fakePage(), {stopped: () => true}), {stopped: true});
  await assert.rejects(drive(fakePage(), {authorizeUrl: 'http://localhost:1/authorize'}), /no state/);
  const bot = fakePage({onClick: (p) => { p.challenge = 'shown'; p.button.busy = true; }});
  const r = await drive(bot);
  assert.match(r.manual, /^bot check: claude.ai answered the Authorize click with an hCaptcha challenge .* - solve it in that Chrome window/);
  assert.equal(bot.log.filter((l) => l.endsWith('mouseReleased@400,600')).length, 1, 'the challenge is never clicked');
});

test('login: no click by hand - the driver clicks, the CLI\'s callback lands, NAME is saved', async () => {
  const t = setup({env: {MODE: 'click'}});
  const f = fakePage({onClick: (p) => {
    fs.writeFileSync(`${t.io.env.REPORT}.clicked`, '');
    p.href = 'http://localhost:1234/callback?code=c&state=s';
  }});
  t.io.devtools = f.devtools;
  t.io.authorizeTimeouts = FAST;
  const r = await t.login({}, {waitS: 20});
  assert.equal(r.tokenState, 'valid');
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-new-perso');
  assert.ok(f.log.includes('Input.dispatchMouseEvent:mouseReleased@400,600'));
  assert.deepEqual(t.left(), []);
});

test('login: a code page\'s code goes to the CLI\'s stdin, and into no message', async () => {
  const t = setup({env: {MODE: 'code'}});
  t.io.devtools = fakePage({onClick: (p) => {
    p.href = `https://platform.claude.com/oauth/code/callback?code=C1&state=${STATE}`;
  }}).devtools;
  t.io.authorizeTimeouts = FAST;
  let said = '';
  const r = await t.login({}, {waitS: 20, onWaiting: (p) => { said += JSON.stringify(p); }});
  assert.equal(r.tokenState, 'valid');
  assert.equal(fs.readFileSync(`${t.io.env.REPORT}.code`, 'utf8'), `C1#${STATE}`);
  assert.ok(!said.includes('C1'));
});

test('login: a failed step stops the CLI at once and names the step; nothing saved', async () => {
  const t = setup({env: {MODE: 'click'}});
  t.io.devtools = fakePage({onFocus: () => {}}).devtools;
  t.io.authorizeTimeouts = FAST;
  const file = path.join(t.s.dir, 'PERSO.json');
  const before = fs.readFileSync(file, 'utf8');
  const started = Date.now();
  await assert.rejects(t.login({}, {waitS: 60}),
    /^Error: PERSO: Authorize stayed disabled for 0.3s \(window focused: true\): "Claude Code would like to connect", nothing saved$/);
  assert.ok(Date.now() - started < 20_000, 'not the whole --wait');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(t.left(), []);
});

test('login: Chrome already open without DevTools: the click is the human\'s, said once', async () => {
  const t = setup({env: {MODE: 'hang'}});
  t.io.devtools = fakePage({port: null}).devtools;
  t.io.authorizeTimeouts = FAST;
  const manual = [];
  await assert.rejects(t.login({}, {waitS: 2, onManual: (p, why) => manual.push([p.name, why])}),
    /PERSO: no Authorize within 2s, nothing saved/);
  assert.deepEqual(manual, [['PERSO', 'its Chrome has no DevTools port of this run (it was already open) - click inside that window, then Authorize']]);
});

test('login: the Chrome it started with a DevTools port is closed after; one already running is not', async () => {
  for (const running of [false, true]) {
    const t = setup({env: {MODE: 'click'}});
    const f = fakePage({onClick: (p) => {
      fs.writeFileSync(`${t.io.env.REPORT}.clicked`, '');
      p.href = 'http://localhost:1234/callback';
    }});
    const dir = openAccountChrome(t.io).plan('PERSO').dir;
    const lock = () => fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
    if (running) lock();
    const closed = [];
    t.io.devtools = {...f.devtools, endpoint: async () => 'ws://127.0.0.1/browser',
      connect: async (ws) => (ws.endsWith('/browser')
        ? {send: async (m) => { closed.push(m); return {}; }, close() {}} : f.devtools.connect(ws))};
    t.io.authorizeTimeouts = FAST;
    t.io.spawn = ((orig) => (cmd, args, opts) => {
      // the BROWSER step starts Chrome: its lock and DevToolsActivePort appear
      if (!running) {
        lock();
        fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/x\n');
      }
      return orig(cmd, args, opts);
    })(t.io.spawn);
    await t.login({}, {waitS: 20});
    assert.deepEqual(closed, running ? [] : ['Browser.close'], running ? 'not ours' : 'ours');
  }
});

test('authorize-click: the CLI\'s success page after the click is a landed callback, clicked once', async () => {
  const f = fakePage({onClick: (p) => { p.href = 'https://platform.claude.com/oauth/code/success?app=claude-code'; p.button = null; }});
  assert.deepEqual(await drive(f), {via: 'callback'});
  assert.equal(f.log.filter((l) => l.endsWith('mouseReleased@400,600')).length, 1);
  const silent = fakePage({onClick: () => {}});
  await assert.rejects(drive(silent), (e) => e.afterClick === true && /^click with no redirect/.test(e.message));
  assert.equal(silent.log.filter((l) => l.endsWith('mouseReleased@400,600')).length, 1, 'never a second consent');
});

test('devtoolsPort: a port file written before this run is not trusted', async () => {
  const {devtoolsPort} = await import('../claude-code/cdp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-port-'));
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '43161\n/devtools/browser/x\n');
  assert.equal(devtoolsPort(dir), 43161);
  assert.equal(devtoolsPort(dir, Date.now() + 60_000), null, 'older than the run');
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), 'junk\n');
  assert.equal(devtoolsPort(dir), null);
  assert.equal(devtoolsPort(path.join(dir, 'none')), null);
});

test('login: a CLI that never calls BROWSER is said, not silently waited on', async () => {
  const t = setup({env: {MODE: 'nobrowser'}});
  t.io.authorizeTimeouts = {...FAST, url: 200};
  const manual = [];
  await assert.rejects(openAccountLogin(t.io).login('PERSO', {waitS: 2, onManual: (p, why) => manual.push(why)}),
    /no Authorize within 2s/);
  assert.deepEqual(manual, ['the CLI opened no page through BROWSER - follow its own browser step']);
});
