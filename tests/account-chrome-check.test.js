// `claudectl account chrome [NAME] --check`: the probe verdict from the
// stream-json the real CLI writes (shapes recorded live on 2026-11-20), and
// the check over a throwaway HOME with a stub `claude` child: no real claude
// or Chrome starts, the real ~/.config/google-chrome is never read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {setImmediate} from 'node:timers';

import {PROBE_PROMPT, PROBE_TOOL, openChromeCheck, probeArgv, probeVerdict} from '../claude-code/account-chrome-check.js';
import {EXTENSION_ID} from '../claude-code/account-chrome.js';
import {main} from '../claude-code/account-cli.js';
import {openStore} from '../claude-code/accounts.js';
import {account, creds, world} from './accounts-world.js';

const NOT_CONNECTED = 'Browser extension is not connected. Please ensure the Claude browser extension is installed ' +
  'and running (https://claude.ai/chrome), and that you are logged into claude.ai with the same account as Claude Code.';

/** The stream a probe writes: init, the deferred-tool reference, the tool call, its result. */
function stream(resultText, {isError = false, call = true} = {}) {
  const lines = [
    {type: 'system', subtype: 'init', mcp_servers: [{name: 'claude-in-chrome', status: 'connected'}]},
    {type: 'assistant', message: {content: [{type: 'tool_use', id: 't0', name: 'ToolSearch'}]}},
    {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't0',
      content: [{type: 'tool_reference', tool_name: PROBE_TOOL}]}]}},
  ];
  if (call) {
    lines.push({type: 'assistant', message: {content: [{type: 'tool_use', id: 't1', name: PROBE_TOOL}]}});
    lines.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't1', is_error: isError,
      content: [{type: 'text', text: resultText}]}]}});
  }
  lines.push({type: 'result', subtype: 'success', result: 'done'});
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

test('probe verdict: only the tabs_context_mcp result counts, never init or the tool reference', () => {
  assert.equal(probeVerdict(stream(NOT_CONNECTED)).verdict, 'not-connected');
  assert.match(probeVerdict(stream(NOT_CONNECTED)).detail, /^Browser extension is not connected/);
  assert.deepEqual(probeVerdict(stream('Tab context:\n- tabId 1: claude.ai')),
    {verdict: 'connected', detail: 'Tab context:'});
  assert.equal(probeVerdict(stream('boom', {isError: true})).verdict, 'not-connected');
  const none = probeVerdict(stream('', {call: false}));
  assert.equal(none.verdict, 'inconclusive');
  assert.match(none.detail, /never called mcp__claude-in-chrome__tabs_context_mcp \(done\)/);
  assert.equal(probeVerdict('').verdict, 'inconclusive');
  assert.equal(probeVerdict('not json\n{"type":"result","is_error":true,"result":"Invalid API key"}').detail,
    `the probe never called ${PROBE_TOOL} (Invalid API key)`);
});

test('probe argv: print mode, chrome, only the one tool, stream-json, no user settings or session file', () => {
  const argv = probeArgv('/bin/claude');
  assert.deepEqual(argv.slice(0, 4), ['/bin/claude', '-p', '--chrome', `--allowedTools=${PROBE_TOOL}`]);
  for (const f of ['stream-json', '--verbose', '--no-session-persistence']) assert.ok(argv.includes(f), f);
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'project');
});

/** A world with PRO live and PERSO saved, a stub claude answering per account. */
function setup({answers = {}, hang = false} = {}) {
  const w = world();
  const bin = path.join(w.home, 'bin');
  fs.mkdirSync(bin, {recursive: true});
  for (const b of ['google-chrome-stable', 'claude']) {
    fs.writeFileSync(path.join(bin, b), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, b), 0o755);
  }
  fs.mkdirSync(path.join(w.home, '.claude', 'chrome'), {recursive: true});
  fs.writeFileSync(path.join(w.home, '.claude', 'chrome', 'chrome-native-host'), '#!/bin/sh\n');
  const probes = [];
  const io = {
    ...w.io, platform: 'linux', homedir: w.home, toolDirs: [bin], tmpdir: w.home, hostname: 'box',
    pidAlive: () => true, probeTimeoutMs: 200,
    env: {PATH: bin, XDG_STATE_HOME: path.join(w.home, 'state')},
    spawn: (cmd, args, opts) => {
      const confDir = opts.env?.CLAUDE_CONFIG_DIR;
      const who = confDir ? fs.readFileSync(path.join(confDir, '.exec-profile'), 'utf8').trim() : 'LIVE';
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdin = {end: (s) => probes.push({who, cmd, args, cwd: opts.cwd, input: s})};
      child.kill = () => setImmediate(() => child.emit('exit', null));
      if (!hang) {
        setImmediate(() => {
          child.stdout.emit('data', stream(answers[who] ?? NOT_CONNECTED));
          child.emit('exit', 0);
        });
      }
      return child;
    },
  };
  const s = openStore(io);
  s.saveCurrent('PRO');
  s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
  return {...w, io, probes};
}

/** The main Chrome with the extension in Profile 2, running, its manifest on the live host. */
function mainChrome(t) {
  const dir = path.join(t.home, '.config', 'google-chrome');
  fs.mkdirSync(path.join(dir, 'Profile 2', 'Extensions', EXTENSION_ID, '1.0_0'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'Local State'),
    JSON.stringify({profile: {info_cache: {'Profile 2': {name: 'WORK'}}}}));
  fs.mkdirSync(path.join(dir, 'NativeMessagingHosts'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'NativeMessagingHosts', 'com.anthropic.claude_code_browser_extension.json'),
    JSON.stringify({path: path.join(t.home, '.claude', 'chrome', 'chrome-native-host')}));
  fs.symlinkSync('box-1', path.join(dir, 'SingletonLock'));
}

test('check: the current login is probed directly, every other saved one through account exec, in turn', async () => {
  const t = setup({answers: {PERSO: 'Tab context: 2 tabs'}});
  mainChrome(t);
  const r = await openChromeCheck(t.io).check();
  assert.equal(r.name, 'PRO');
  assert.deepEqual(t.probes.map((p) => p.who), ['LIVE', 'PERSO']);
  assert.ok(t.probes.every((p) => p.input === `${PROBE_PROMPT}\n` && p.cwd === t.home && p.args.includes('--chrome')));
  assert.equal(r.connected, false);
  assert.equal(r.verdict, 'not-connected');
  assert.deepEqual(r.main.profiles, ['Profile 2 (WORK)']);
  assert.deepEqual(r.probes.map((p) => [p.name, p.verdict, p.where]),
    [['PRO', 'not-connected', null], ['PERSO', 'connected', 'main Chrome']]);
  assert.ok(r.reasons.some((x) => /extension answers PERSO: signed in to that claude.ai account \(inferred\)/.test(x)));
  assert.ok(r.reasons.some((x) => /PRO's own Chrome: extension missing/.test(x)));
});

test('check: CONNECTED exits 0 with no reasons; a probe on NAME names NAME first', async () => {
  const t = setup({answers: {PERSO: 'Tab context: 1 tab'}});
  const lines = [];
  const code = await main(['chrome', 'PERSO', '--check'], {...t.io, stdout: (s) => lines.push(s), stderr: () => {}});
  assert.equal(code, 0);
  assert.deepEqual(t.probes.map((p) => p.who), ['PERSO', 'LIVE']);
  const text = lines.join('');
  assert.match(text, /^PERSO: CONNECTED - Tab context: 1 tab\n/);
  assert.match(text, /answered: PERSO \(main Chrome\)\n/);
  assert.doesNotMatch(text, /^ {2}- /m);
});

test('check: the reasons come from the files - native host, extension, sign-in, Chrome not running', async () => {
  const t = setup();
  fs.rmSync(path.join(t.home, '.claude', 'chrome'), {recursive: true});
  const r = await openChromeCheck(t.io).check('PERSO');
  const all = r.reasons.join('\n');
  assert.match(all, /native host missing: .*chrome-native-host \(run `claude` once and type \/chrome\)/);
  assert.match(all, /PERSO's own Chrome: extension missing/);
  assert.match(all, /PERSO's own Chrome: not signed in to claude.ai/);
  assert.match(all, /PERSO's own Chrome: not running/);
  assert.match(all, /main Chrome: no native-host manifest/);
  assert.match(all, /main Chrome: extension not installed in any profile/);
});

test('check: an account whose own Chrome runs with the extension is answered by "main or its own"', async () => {
  const t = setup({answers: {PERSO: 'Tab context: 1 tab'}});
  const dir = path.join(t.home, 'state', 'claude-usage-panel', 'chrome', 'PERSO');
  fs.mkdirSync(path.join(dir, 'Default', 'Extensions', EXTENSION_ID, '1.0_0'), {recursive: true});
  fs.symlinkSync('box-9', path.join(dir, 'SingletonLock'));
  const r = await openChromeCheck(t.io).check('PERSO');
  assert.equal(r.probes[0].where, "main Chrome or PERSO's own Chrome");
});

test('check: a probe that hangs is INCONCLUSIVE at its deadline, exit 1, JSON on request', async () => {
  const t = setup({hang: true});
  const lines = [];
  const code = await main(['chrome', '--check', '--json'], {...t.io, stdout: (s) => lines.push(s), stderr: () => {}});
  assert.equal(code, 1);
  const r = JSON.parse(lines.join(''));
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.detail, /timed out after 0 s/);
});

test('check: an unknown NAME or an unsaved current login is refused before any probe', async () => {
  const t = setup();
  await assert.rejects(openChromeCheck(t.io).check('NOPE'), /no saved account named NOPE/);
  openStore(t.io).removeProfile('PRO');
  await assert.rejects(openChromeCheck(t.io).check(), /is not a saved account/);
  assert.equal(t.probes.length, 0);
});
