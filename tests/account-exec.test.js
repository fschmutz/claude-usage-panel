// `claudectl account exec NAME -- CMD`: CMD runs as a saved login in a
// throwaway config dir while the live login stays byte-for-byte as it was.
// The child is a real process (node), the HOME, state dir and scratch dir are
// throwaway, the Keychain is fake. No network, no real ~/.claude.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {DROPPED_ENV, EXEC_PREFIX, openAccountExec} from '../claude-code/account-exec.js';
import {main} from '../claude-code/account-cli.js';
import {openStore} from '../claude-code/accounts.js';
import {helpRequest} from '../claude-code/cli-help.js';
import {NOW, account, creds, fakeSecurity, world} from './accounts-world.js';

// What the child saw, written where the test reads it; ROTATE makes it
// rotate its token the way Claude Code does, EXIT sets its exit code.
const CHILD = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR;
const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'));
const mode = (f) => (fs.statSync(path.join(dir, f)).mode & 0o777).toString(8);
fs.writeFileSync(process.env.REPORT, JSON.stringify({
  dir, token: c.claudeAiOauth.accessToken, account: cfg.oauthAccount,
  modes: {dir: (fs.statSync(dir).mode & 0o777).toString(8), creds: mode('.credentials.json'), cfg: mode('.claude.json')},
  env: Object.keys(process.env), argv: process.argv.slice(2),
}));
if (process.env.ROTATE) {
  c.claudeAiOauth.accessToken = 'at-rotated'; c.claudeAiOauth.refreshToken = 'rt-rotated';
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(c));
}
if (process.env.OTHER) {
  cfg.oauthAccount = {accountUuid: 'u-someone-else'};
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify(cfg));
  c.claudeAiOauth.refreshToken = 'rt-someone-else';
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(c));
}
process.exit(Number(process.env.EXIT ?? 0));
`;

/** A world with live login PRO and a saved, idle PERSO; exec bound to it. */
function setup({env = {}, perso = creds('perso'), platform = 'linux', exec} = {}) {
  const w = world();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-exec-scratch-'));
  const report = path.join(scratch, 'report.json');
  const childFile = path.join(scratch, 'child.cjs');
  fs.writeFileSync(childFile, CHILD);
  const io = {...w.io, platform, tmpdir: path.join(scratch, 'run'), env: {...env, REPORT: report}, pid: 4242,
    ...(exec ? {exec} : {})};
  // the store on the same platform as exec: macOS keeps it elsewhere
  w.s = openStore(io);
  w.s.saveCurrent('PRO');
  w.s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: perso});
  const snapshot = () => ({
    creds: fs.readFileSync(path.join(w.home, '.claude', '.credentials.json'), 'utf8'),
    cfg: fs.readFileSync(path.join(w.home, '.claude.json'), 'utf8'),
  });
  return {...w, io, report, childFile, scratch, snapshot,
    seen: () => JSON.parse(fs.readFileSync(report, 'utf8')),
    left: () => (fs.existsSync(io.tmpdir) ? fs.readdirSync(io.tmpdir) : []),
    run: (extraEnv = {}, argv = []) => openAccountExec({...io, env: {...io.env, ...extraEnv}})
      .exec('PERSO', [process.execPath, childFile, ...argv], {stdio: 'ignore'})};
}

test('exec: the command runs as NAME; the live login is untouched and the dir is gone', async () => {
  const hostile = Object.fromEntries(DROPPED_ENV.map((k) => [k, 'x']));
  const t = setup({env: hostile});
  const before = t.snapshot();
  const code = await t.run({EXIT: '7'}, ['--help', 'a b']);
  assert.equal(code, 7, 'the exit code is the command\'s');
  const seen = t.seen();
  assert.equal(seen.token, 'at-perso');
  assert.deepEqual(seen.account, account('perso'));
  assert.deepEqual(seen.argv, ['--help', 'a b'], 'arguments pass through untouched, flags included');
  assert.ok(path.basename(seen.dir).startsWith(`${EXEC_PREFIX}4242-`));
  assert.deepEqual(seen.modes, {dir: '700', creds: '600', cfg: '600'});
  for (const k of DROPPED_ENV) assert.ok(!seen.env.includes(k), `${k} is dropped`);
  assert.deepEqual(t.snapshot(), before, 'live credentials and ~/.claude.json byte-identical');
  assert.deepEqual(t.left(), [], 'config dir removed');
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-perso', 'nothing rotated, nothing written');
});

test('exec: a token the command rotates is written back to NAME, never to the live login', async () => {
  const t = setup();
  const before = t.snapshot();
  assert.equal(await t.run({ROTATE: '1'}), 0);
  const oauth = t.s.readProfile('PERSO').credentials.claudeAiOauth;
  assert.deepEqual([oauth.accessToken, oauth.refreshToken], ['at-rotated', 'rt-rotated']);
  assert.deepEqual(t.snapshot(), before);
  assert.equal(t.s.readProfile('PRO').credentials.claudeAiOauth.refreshToken, 'rt-pro');
});

test('exec: a login for another account inside the dir is never written to NAME', async () => {
  const t = setup();
  await t.run({OTHER: '1'});
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-perso');
});

test('exec: a stale token is refreshed before the command starts', async () => {
  const t = setup({perso: creds('perso', {expiresAt: NOW - 1})});
  await t.run();
  assert.equal(t.calls.length, 1, 'one refresh POST');
  assert.equal(t.seen().token, 'at-fresh');
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-fresh');
});

test('exec: the live login, an unknown name and a missing command are refused', async () => {
  const t = setup();
  const before = t.snapshot();
  const x = openAccountExec(t.io);
  await assert.rejects(x.exec('PRO', ['true']), /PRO is the current login - run the command directly/);
  await assert.rejects(x.exec('NOPE', ['true']), /no saved account named NOPE/);
  await assert.rejects(x.exec('PERSO', []), /exec needs a command after --/);
  await assert.rejects(main(['exec', 'PERSO', 'true'], t.io), /usage: claudectl account exec NAME -- CMD/);
  await assert.rejects(main(['exec', '--', 'true'], t.io), /usage: claudectl account exec NAME -- CMD/);
  assert.deepEqual(t.snapshot(), before);
  assert.deepEqual(t.left(), []);
});

test('exec: the CLI runs it and returns the command\'s code', async () => {
  const t = setup();
  const code = await main(['exec', 'PERSO', '--', process.execPath, t.childFile, '--json'], {...t.io, stdio: 'ignore',
    env: {...t.io.env, EXIT: '3'}});
  assert.equal(code, 3);
  assert.deepEqual(t.seen().argv, ['--json']);
});

test('exec: a dir left by a dead run is synced back and removed; a live run\'s is kept', async () => {
  const t = setup();
  const leftover = (pid, refresh) => {
    const dir = path.join(t.io.tmpdir, `${EXEC_PREFIX}${pid}-abc123`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, '.exec-profile'), 'PERSO\n');
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(creds('perso', {refreshToken: refresh})));
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({oauthAccount: account('perso')}));
    return path.basename(dir);
  };
  const dead = leftover(111, 'rt-from-crash');
  const alive = leftover(222, 'rt-still-running');
  const x = openAccountExec({...t.io, pidAlive: (pid) => pid === 222});
  assert.deepEqual(x.sweep(), [dead]);
  assert.deepEqual(t.left(), [alive]);
  assert.equal(t.s.readProfile('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-from-crash');
});

test('exec on macOS: the dir gets its own Keychain item, written then deleted; the live one is never touched', async () => {
  const written = [];
  const keychain = new (class extends Map {
    set(k, v) {
      written.push([k, v]);
      return super.set(k, v);
    }
  })([['Claude Code-credentials', JSON.stringify(creds('pro'))]]);
  written.length = 0;
  const sec = fakeSecurity(keychain);
  const deleted = [];
  const exec = (cmd, args, opts) => {
    if (cmd === '/usr/bin/security' && args[0] === 'delete-generic-password') {
      const service = args[args.indexOf('-s') + 1];
      deleted.push(service);
      keychain.delete(service);
      return '';
    }
    return sec.exec(cmd, args, opts);
  };
  const t = setup({platform: 'darwin', exec});
  const x = openAccountExec(t.io);
  const code = await x.exec('PERSO', [process.execPath, '-e', `
    const svc = ${JSON.stringify('Claude Code-credentials-')} + require('node:crypto').createHash('sha256')
      .update(process.env.CLAUDE_CONFIG_DIR.normalize('NFC'), 'utf8').digest('hex').slice(0, 8);
    require('node:fs').writeFileSync(process.env.REPORT, JSON.stringify({svc}));`], {stdio: 'ignore'});
  assert.equal(code, 0);
  const during = JSON.parse(fs.readFileSync(t.report, 'utf8')).svc;
  assert.deepEqual(deleted, [during], 'exactly the dir\'s own item is deleted');
  assert.deepEqual(written, [[during, JSON.stringify(creds('perso'))]], 'the dir\'s item, and only it, was written');
  assert.ok(!sec.argvs.some((a) => a.includes('at-perso')), 'the token never sits in an argv');
  assert.equal(keychain.get('Claude Code-credentials'), JSON.stringify(creds('pro')), 'live item unchanged');
  assert.notEqual(during, 'Claude Code-credentials');
});

test('exec: help stops at --, so `account exec NAME -- claude --help` runs claude --help', () => {
  assert.equal(helpRequest(['account', 'exec', 'PERSO', '--', 'claude', '--help']), null);
  assert.equal(helpRequest(['account', 'exec', 'PERSO', '--', 'help']), null);
  assert.deepEqual(helpRequest(['account', 'exec', '--help']), {group: 'account', cmd: 'exec'});
});

test('exec: the pause waiter hooks come along, no other hook does', async () => {
  const t = setup();
  const wait = {type: 'command', command: 'node "/x/claude-code/pause-hook.js" wait', timeout: 86400, asyncRewake: true};
  const guard = {type: 'command', command: 'node /x/guard.js'};
  fs.writeFileSync(path.join(t.home, '.claude', 'settings.json'), JSON.stringify({
    model: 'x', hooks: {Stop: [{hooks: [wait, guard]}], PreToolUse: [{matcher: '*', hooks: [guard]}]},
  }));
  const x = openAccountExec(t.io);
  assert.equal(await x.exec('PERSO', [process.execPath, '-e', `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.REPORT, fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + '/settings.json'));`],
  {stdio: 'ignore'}), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(t.report, 'utf8')), {hooks: {Stop: [{hooks: [wait]}]}});

  fs.writeFileSync(path.join(t.home, '.claude', 'settings.json'), JSON.stringify({hooks: {Stop: [{hooks: [guard]}]}}));
  assert.equal(await x.exec('PERSO', [process.execPath, '-e', `
    require('node:fs').writeFileSync(process.env.REPORT,
      String(require('node:fs').existsSync(process.env.CLAUDE_CONFIG_DIR + '/settings.json')));`],
  {stdio: 'ignore'}), 0);
  assert.equal(fs.readFileSync(t.report, 'utf8'), 'false', 'no waiter installed: no settings.json');
});

// Claude Code repoints Chrome's native-messaging manifest into ITS config
// dir; under exec that dir is deleted, which left Claude-in-Chrome "not
// connected" for every session (2026-11-09).
const HOST = '.config/google-chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json';
const manifest = (p) => `${JSON.stringify({name: 'com.anthropic.claude_code_browser_extension', path: p, type: 'stdio'})}\n`;

test('exec: a native-host manifest the command repoints into the dir is put back after it', async () => {
  const t = setup();
  const file = path.join(t.home, HOST);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const original = manifest(path.join(t.home, '.claude', 'chrome', 'chrome-native-host'));
  fs.writeFileSync(file, original);
  const x = openAccountExec({...t.io, homedir: t.home});
  assert.equal(await x.exec('PERSO', [process.execPath, '-e', `
    const fs = require('node:fs'), f = ${JSON.stringify(file)};
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    m.path = process.env.CLAUDE_CONFIG_DIR + '/chrome/chrome-native-host';
    fs.writeFileSync(f, JSON.stringify(m));`], {stdio: 'ignore'}), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'the manifest names the live host again');
});

test('exec: a manifest a dead run left in a gone dir is healed to the live host; a live run keeps its own', () => {
  const t = setup();
  const file = path.join(t.home, HOST);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const live = path.join(t.home, '.claude', 'chrome', 'chrome-native-host');
  fs.mkdirSync(path.dirname(live), {recursive: true});
  fs.writeFileSync(live, '#!/bin/sh\n');
  // a running exec (pid 222) owns its manifest: left alone
  const running = path.join(t.io.tmpdir, `${EXEC_PREFIX}222-abc123`);
  fs.mkdirSync(running, {recursive: true});
  fs.writeFileSync(file, manifest(path.join(running, 'chrome', 'chrome-native-host')));
  const x = openAccountExec({...t.io, homedir: t.home, pidAlive: (pid) => pid === 222});
  assert.deepEqual(x.restoreHosts(), []);
  // a crashed run whose dir is gone: healed to the live login's host
  fs.writeFileSync(file, manifest(path.join(t.io.tmpdir, `${EXEC_PREFIX}111-gone00`, 'chrome', 'chrome-native-host')));
  assert.deepEqual(x.restoreHosts(), [file]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).path, live);
  // a manifest naming anything else is never touched
  fs.writeFileSync(file, manifest('/opt/other/host'));
  assert.deepEqual(x.restoreHosts(), []);
});
