// The Codex store and its CLI group, through openCodexStore bound to a
// throwaway HOME. No network at all - there is none in that module - and,
// asserted here, no reach into a Claude login: the two stores share nothing
// but a state directory root.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {main as claudectl} from '../claude-code/claudectl.js';
import {openCodexStore} from '../claude-code/codex.js';
import {codexAccountsDir, codexAuthPath} from '../claude-code/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'codex.json'), 'utf8'));
const NOW = FIX.now;

/** The auth.json the Codex CLI writes, for one of the fixture identities. */
const auth = (which, extra = {}) => ({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: FIX.tokens[which === 'plus' ? 'idPlus' : 'idPro'],
    access_token: FIX.tokens.accessValid,
    refresh_token: `rt-${which}`,
    account_id: `acct-${which}`,
  },
  last_refresh: new Date(NOW - 3_600_000).toISOString(),
  ...extra,
});

/** A throwaway HOME with a Codex login (or none) and an io bound to it. */
function world({live = 'plus'} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-codex-'));
  const io = {homedir: home, platform: 'linux', env: {}, nowMs: NOW};
  if (live) {
    fs.mkdirSync(path.join(home, '.codex'), {recursive: true});
    fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth(live)));
  }
  return {home, io, s: openCodexStore(io)};
}

/** One rollout line as the Codex CLI writes it. */
const tokenCount = (at, limits) => `${JSON.stringify({
  timestamp: new Date(at).toISOString(),
  type: 'event_msg',
  payload: {type: 'token_count', rate_limits: limits},
})}\n`;

function writeSession(home, name, lines) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '13');
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

test('paths follow CODEX_HOME, and the store never shares a directory with the Claude one', () => {
  assert.equal(codexAuthPath({homedir: '/h', env: {}}), '/h/.codex/auth.json');
  assert.equal(codexAuthPath({homedir: '/h', env: {CODEX_HOME: '/x'}}), '/x/auth.json');
  const dir = codexAccountsDir({homedir: '/h', env: {}, platform: 'linux'});
  assert.equal(dir, '/h/.local/state/claude-usage-panel/codex-accounts');
  assert.ok(!dir.endsWith('/accounts'), 'never the Claude store directory');
});

test('save names the live Codex login, and the file is private', () => {
  const {home, s} = world();
  const p = s.saveCurrent('PLUS');
  assert.equal(p.name, 'PLUS');
  const file = path.join(home, '.local/state/claude-usage-panel/codex-accounts/PLUS.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(s.liveCodexName(), 'PLUS');
  assert.deepEqual(s.listProfiles().map((x) => x.name), ['PLUS']);
});

test('save refuses a case variant, a taken name and a twin', () => {
  const {s} = world();
  s.saveCurrent('PLUS');
  assert.throws(() => s.saveCurrent('plus'), /names ignore case/);
  assert.throws(() => s.saveCurrent('OTHER'), /already saved as PLUS/);
});

test('switching replaces auth.json and nothing else under the Codex home', () => {
  const {home, io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  const config = path.join(home, '.codex', 'config.toml');
  fs.writeFileSync(config, 'model = "gpt-5"\n');

  const r = s.switchTo('PLUS');
  assert.deepEqual({from: r.from, to: r.to, changed: r.changed}, {from: 'PRO', to: 'PLUS', changed: true});
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(io), 'utf8')).tokens.account_id, 'acct-plus');
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = "gpt-5"\n', 'config untouched');
  assert.equal(s.switchTo('PLUS').changed, false);
});

test('a Codex switch never reads or writes a Claude login', () => {
  const {home, io, s} = world();
  // A full Claude login in the same HOME, exactly where the other store keeps it.
  fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
  const claudeCreds = path.join(home, '.claude', '.credentials.json');
  const claudeConfig = path.join(home, '.claude.json');
  fs.writeFileSync(claudeCreds, '{"claudeAiOauth":{"accessToken":"at-claude"}}');
  fs.writeFileSync(claudeConfig, '{"oauthAccount":{"emailAddress":"me@example.com"}}');
  const before = [claudeCreds, claudeConfig].map((f) => fs.readFileSync(f, 'utf8'));

  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  s.switchTo('PLUS');

  assert.deepEqual([claudeCreds, claudeConfig].map((f) => fs.readFileSync(f, 'utf8')), before);
});

test('an unsaved live login is refused rather than overwritten', () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  assert.throws(() => s.switchTo('PLUS'), /is not saved/);
});

test('the live login is synced back before a switch, so a rotated token is not lost', () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  // The CLI rotates PRO's tokens while it is live.
  fs.writeFileSync(codexAuthPath(io),
    JSON.stringify(auth('pro', {last_refresh: new Date(NOW).toISOString()})));
  s.switchTo('PLUS');
  assert.equal(s.readProfile('PRO').auth.last_refresh, new Date(NOW).toISOString());
});

/** A live auth.json for one of the fixture's Team members (ANA, BEN). */
const teamAuth = (name, extra = {}) => ({
  ...FIX.team.profiles.find((p) => p.name === name).auth, ...extra,
});

test('two members of one Team workspace are two logins: list never writes, switch never mixes them', () => {
  const {io, s} = world({live: null});
  fs.mkdirSync(path.dirname(codexAuthPath(io)), {recursive: true});
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(teamAuth('ANA')));
  s.saveCurrent('ANA');
  const anaSaved = fs.readFileSync(path.join(s.dir, 'ANA.json'), 'utf8');

  // Ben signs in on the same workspace (same account_id).
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(teamAuth('BEN')));
  assert.equal(s.liveCodexName(), null, 'ben is not ana');
  s.listAccounts();
  s.syncBack();
  assert.equal(fs.readFileSync(path.join(s.dir, 'ANA.json'), 'utf8'), anaSaved,
    'ANA keeps her own tokens');
  assert.throws(() => s.saveCurrent('ANA'), /ANA is already ana@team\.example/,
    'ben cannot be saved over ana without --force');
  s.saveCurrent('BEN');
  assert.equal(s.switchTo('ANA').from, 'BEN');
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(io), 'utf8')).tokens.refresh_token, 'rt-ana');
  assert.equal(s.readProfile('BEN').auth.tokens.refresh_token, 'rt-ben');
});

test('listAccounts is read-only (the MCP tool says so); the CLI list syncs first', async () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  const file = path.join(s.dir, 'PLUS.json');
  const before = fs.readFileSync(file, 'utf8');
  const rotated = JSON.stringify(auth('plus', {last_refresh: new Date(NOW).toISOString()}));
  fs.writeFileSync(codexAuthPath(io), rotated);
  assert.equal(s.listAccounts().active, 'PLUS');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'list wrote nothing');
  await run(io, 'codex', 'list');
  assert.equal(s.readProfile('PLUS').auth.last_refresh, new Date(NOW).toISOString(),
    '`claudectl codex list` keeps the rotated tokens');
});

test('a switch leaves auth.json 0600 even when the codex CLI wrote it 0644', () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  fs.chmodSync(codexAuthPath(io), 0o644);
  s.switchTo('PLUS');
  assert.equal(fs.statSync(codexAuthPath(io)).mode & 0o777, 0o600);
});

test('the real rollout shape reads: resets_at in epoch seconds becomes the countdown', () => {
  const {home, s} = world();
  const at = NOW - 600_000;
  const resetsAt = Math.floor((NOW + 3_600_000) / 1000);
  writeSession(home, 'rollout-real.jsonl', [tokenCount(at, {
    primary: {used_percent: 23.0, window_minutes: 300, resets_at: resetsAt},
    secondary: {used_percent: 7.0, window_minutes: 10080, resets_at: resetsAt + 86_400},
    credits: {has_credits: false, unlimited: false, balance: null},
    plan_type: null,
  })]);
  const got = s.recordedUsage();
  assert.equal(got.reason, null);
  assert.deepEqual(got.cards.map((c) => c.resetsAt),
    [new Date(resetsAt * 1000).toISOString(), new Date((resetsAt + 86_400) * 1000).toISOString()]);
});

test('usage is whatever the Codex CLI last recorded - or an honest reason there is none', () => {
  const {home, s} = world();
  assert.deepEqual(s.recordedUsage(), {cards: [], capturedAt: null, reason: 'no_sessions'});

  writeSession(home, 'rollout-a.jsonl', [
    `${JSON.stringify({type: 'session_meta'})}\n`,
  ]);
  assert.equal(s.recordedUsage().reason, 'no_snapshot');

  const at = NOW - 600_000;
  writeSession(home, 'rollout-b.jsonl', [
    tokenCount(at - 60_000, {primary: {used_percent: 5, window_minutes: 300}}),
    tokenCount(at, {
      primary: {used_percent: 41.5, window_minutes: 300, resets_in_seconds: 3600},
      secondary: {used_percent: 8, window_minutes: 10080},
    }),
  ]);
  const got = s.recordedUsage();
  assert.equal(got.reason, null);
  assert.equal(got.capturedAt, new Date(at).toISOString());
  assert.deepEqual(got.cards.map((c) => [c.key, c.percent, c.provenance]),
    [['codex_primary', 42, 'estimated'], ['codex_secondary', 8, 'estimated']]);
});

test('a reading old enough that its window has rolled over is withheld, not shown', () => {
  const {home, s} = world();
  const at = NOW - 13 * 3_600_000;
  writeSession(home, 'rollout-old.jsonl',
    [tokenCount(at, {primary: {used_percent: 90, window_minutes: 300}})]);
  const got = s.recordedUsage();
  assert.deepEqual([got.cards.length, got.reason], [0, 'stale']);
  assert.equal(got.capturedAt, new Date(at).toISOString());
});

test('a truncated first line of the tail does not stop the scan', () => {
  const {home, s} = world();
  writeSession(home, 'rollout-partial.jsonl', [
    '{"type":"event_msg","payload":{"rate_limits":{"prim\n',
    tokenCount(NOW - 1000, {primary: {used_percent: 7, window_minutes: 300}}),
  ]);
  assert.deepEqual(s.recordedUsage().cards.map((c) => c.percent), [7]);
});

// ── the CLI group ───────────────────────────────────────────────────────────────

async function run(io, ...argv) {
  let text = '';
  const code = await claudectl(argv, {...io, stdout: (s) => (text += s)});
  return {code, text};
}

test('claudectl codex lists, switches and says where the files are', async () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  assert.match((await run(io, 'codex', 'help')).text, /claudectl codex - named OpenAI Codex logins/);
  assert.match((await run(io, 'codex', 'help')).text, /codex-accounts/);
  const list = await run(io, 'codex', 'list');
  assert.match(list.text, /\* PLUS\s+plus@example\.com\s+Plus\s+valid/);
  assert.deepEqual(await run(io, 'codex', 'current'), {code: 0, text: 'PLUS\n'});
  assert.match((await run(io, 'codex', 'use', 'PLUS')).text, /already the current Codex login/);
  assert.match((await run(io, 'codex', 'remove', 'PLUS')).text, /removed PLUS/);
  assert.equal((await run(io, 'codex', 'current')).code, 1);
});

test('claudectl codex usage says est. and when, or why there is nothing', async () => {
  const {home, io, s} = world();
  s.saveCurrent('PLUS');
  const none = await run(io, 'codex', 'usage');
  assert.equal(none.code, 1);
  assert.match(none.text, /Codex usage unavailable: no Codex sessions/);

  writeSession(home, 'rollout-c.jsonl',
    [tokenCount(NOW - 60_000, {primary: {used_percent: 33, window_minutes: 300, resets_in_seconds: 600}})]);
  const got = await run(io, 'codex', 'usage');
  assert.equal(got.code, 0);
  // The reset is 10 minutes from when the CLI recorded it, a minute ago.
  assert.match(got.text, /5h limit\s+33%\s+resets in 9m/);
  assert.match(got.text, /est\. - recorded by the codex CLI at/);
});

test('the claudectl root help names the codex group', async () => {
  const {io} = world();
  assert.match((await run(io, 'help')).text, /claudectl codex \.\.\./);
});

test('a token the codex CLI rotates between the sync-back and the write lands in its profile', () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  const rotated = auth('pro', {last_refresh: new Date(NOW).toISOString()});
  rotated.tokens.refresh_token = 'rt-pro-rotated';
  let rotations = 0;
  const raced = openCodexStore({...io, afterSyncBack: () => {
    // The CLI refreshes PRO in place, once, right after our sync-back read it.
    if (rotations++ === 0) fs.writeFileSync(codexAuthPath(io), JSON.stringify(rotated));
  }});
  const r = raced.switchTo('PLUS');
  assert.deepEqual({from: r.from, changed: r.changed}, {from: 'PRO', changed: true});
  assert.equal(raced.readProfile('PRO').auth.tokens.refresh_token, 'rt-pro-rotated');
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(io), 'utf8')).tokens.account_id, 'acct-plus');
});

test('a live file rewritten on every try is not overwritten: the switch gives up', () => {
  const {io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  let n = 0;
  const raced = openCodexStore({...io, afterSyncBack: () => {
    const next = auth('pro');
    next.tokens.refresh_token = `rt-pro-${++n}`;
    fs.writeFileSync(codexAuthPath(io), JSON.stringify(next));
  }});
  assert.throws(() => raced.switchTo('PLUS'), /kept rewriting auth\.json/);
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(io), 'utf8')).tokens.refresh_token, 'rt-pro-3');
});

test('a rollout 4 directories below sessions/ is read; a 5th level is never walked', () => {
  const {home, s} = world();
  const put = (segments, name) => {
    const dir = path.join(home, '.codex', 'sessions', ...segments);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, name), '');
    return path.join(dir, name);
  };
  const deep4 = put(['a', 'b', 'c', 'd'], 'deep4.jsonl');
  put(['a', 'b', 'c', 'd', 'e'], 'deep5.jsonl');
  assert.deepEqual(s.recentSessions().map((f) => f.full), [deep4]);
});

test('the private write creates its tmp 0600 and never writes through a planted tmp', () => {
  const {home, io, s} = world();
  s.saveCurrent('PLUS');
  fs.writeFileSync(codexAuthPath(io), JSON.stringify(auth('pro')));
  s.saveCurrent('PRO');
  // A symlink where the tmp goes: a write that follows it would put the token
  // in a file somebody else chose.
  const bait = path.join(home, 'bait');
  fs.writeFileSync(bait, 'untouched');
  fs.symlinkSync(bait, `${codexAuthPath(io)}.${process.pid}.tmp`);
  s.switchTo('PLUS');
  assert.equal(fs.readFileSync(bait, 'utf8'), 'untouched');
  assert.equal(fs.statSync(codexAuthPath(io)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(codexAuthPath(io), 'utf8')).tokens.account_id, 'acct-plus');
});
