// Named accounts, the store I/O: save, sync back, refresh, per-account usage
// and the store files, through openStore bound to a throwaway HOME. No
// network: fetch is faked. Switching is accounts-switch.test.js, the CLI
// accounts-cli.test.js, the pure rules accounts-contract.test.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openStore} from '../claude-code/accounts.js';
import {autoSwitchTarget, worstFromCache} from '../claude-code/accounts-contract.js';
import {accountsDir, claudeConfigPath, credentialsPath} from '../claude-code/paths.js';
import {NOW, account, creds, world} from './accounts-world.js';

// ── Paths ───────────────────────────────────────────────────────────────────────

test('credentials and config paths follow CLAUDE_CONFIG_DIR', () => {
    assert.equal(credentialsPath({homedir: '/h', env: {}}), '/h/.claude/.credentials.json');
    assert.equal(claudeConfigPath({homedir: '/h', env: {}}), '/h/.claude.json');
    assert.equal(credentialsPath({homedir: '/h', env: {CLAUDE_CONFIG_DIR: '/c'}}), '/c/.credentials.json');
    assert.equal(claudeConfigPath({homedir: '/h', env: {CLAUDE_CONFIG_DIR: '/c'}}), '/c/.claude.json');
});

test('accountsDir follows XDG on linux and Application Support on macOS', () => {
    assert.equal(accountsDir({homedir: '/h', platform: 'linux', env: {}}),
        '/h/.local/state/claude-usage-panel/accounts');
    assert.equal(accountsDir({homedir: '/h', platform: 'linux', env: {XDG_STATE_HOME: '/x'}}),
        '/x/claude-usage-panel/accounts');
    assert.equal(accountsDir({homedir: '/h', platform: 'darwin', env: {}}),
        '/h/Library/Application Support/claude-usage-panel/accounts');
});

// ── I/O against a throwaway HOME ────────────────────────────────────────────────

test('saveCurrent writes a 0600 profile from the live login; list + current see it', () => {
    const {home, s} = world();
    const p = s.saveCurrent('PRO');
    assert.equal(p.account.emailAddress, 'pro@example.com');
    const file = path.join(home, '.local/state/claude-usage-panel/accounts/PRO.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(s.listProfiles().map((x) => x.name), ['PRO']);
    assert.equal(s.liveAccountName(), 'PRO');
});

test('saveCurrent refuses a taken name, a twin, and a bad name; --force overrides', () => {
    const {home, s} = world();
    s.saveCurrent('PRO');
    assert.throws(() => s.saveCurrent('PERSO'), /already saved as PRO/);
    assert.throws(() => s.saveCurrent('bad name'), /invalid name/);
    // another login under a name that belongs to a different account
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('perso')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('perso')}));
    assert.throws(() => s.saveCurrent('PRO'), /PRO is already pro@example.com/);
    s.saveCurrent('PRO', {force: true});
    assert.equal(s.listProfiles()[0].account.emailAddress, 'perso@example.com');
    // ... but --force never lets ONE account occupy TWO names: two profiles
    // with one identity make activeAccountName a coin toss and an auto-switch
    // between them a no-op. Seen live: a `claude auth login` that landed back
    // on the signed-in browser account, then saved under the other name.
    assert.throws(() => s.saveCurrent('PERSO', {force: true}),
        /this login \(perso@example.com\) is already saved as PRO/);
    assert.deepEqual(s.listProfiles().map((x) => x.name), ['PRO']);
});

test('saveCurrent without a live login says so', () => {
    const {s} = world({live: null});
    assert.throws(() => s.saveCurrent('PRO'), /no Claude Code login/);
});

test('the store reads the older flat credential shapes and lifts them into one', () => {
    const {home, s} = world({live: null});
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({access_token: 'tok-2'}));
    assert.deepEqual(s.readLiveCredentials(), {claudeAiOauth: {accessToken: 'tok-2'}});
    assert.equal(s.liveAccessToken(), 'tok-2');
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{nope');
    assert.equal(s.readLiveCredentials(), null);
    assert.equal(s.liveAccessToken(), null);
});

test('fetchUsageWith maps every outcome; fetchLiveUsage uses the live token', async () => {
    const {io, s} = world();
    const payload = {limits: [{kind: 'session', percent: 26, severity: 'normal', is_active: true}]};
    const seen = [];
    io.fetchImpl = async (url, init) => {
        seen.push(init.headers.authorization);
        return {ok: true, status: 200, json: async () => payload};
    };
    const live = await s.fetchLiveUsage();
    assert.equal(live.ok, true);
    assert.equal(live.cards[0].key, 'session');
    assert.deepEqual(live.raw, payload);
    assert.deepEqual(seen, ['Bearer at-pro']);
    assert.deepEqual((await s.fetchUsageWith(null)).code, 'no_token');
    io.fetchImpl = async () => ({ok: false, status: 401, json: async () => ({})});
    assert.match((await s.fetchUsageWith('t')).message, /Claude session expired/);
    assert.match((await s.fetchUsageWith('t', {label: 'PERSO'})).message, /^PERSO: usage endpoint refused/);
    io.fetchImpl = async () => ({ok: false, status: 500, json: async () => ({})});
    assert.deepEqual(await s.fetchUsageWith('t'), {ok: false, code: 'transient', message: 'HTTP 500'});
    // The server's words reach the row, behind the account's name when there is one.
    io.fetchImpl = async () => ({ok: false, status: 424, json: async () => ({error: {type: 'failed_dependency', message: 'upstream down'}})});
    assert.equal((await s.fetchUsageWith('t', {label: 'PERSO'})).message,
        'PERSO: HTTP 424 failed_dependency: upstream down');
    io.fetchImpl = async () => ({ok: false, status: 404, json: async () => { throw new Error('no body'); }});
    assert.deepEqual(await s.fetchUsageWith('t'), {ok: false, code: 'http_error', message: 'HTTP 404'});
    io.fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    assert.equal((await s.fetchUsageWith('t')).code, 'network_error');
    io.fetchImpl = async () => ({ok: true, status: 200, json: async () => { throw new Error('bad json'); }});
    assert.equal((await s.fetchUsageWith('t')).code, 'parse_error');
});

test('accessTokenFor: live for the active account, stored when valid, refreshed when stale', async () => {
    const {home, calls, s} = world();
    s.saveCurrent('PRO');
    // the live token moved on; the active account must answer with the live one
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify(creds('pro', {accessToken: 'at-pro-live'})));
    assert.deepEqual(await s.accessTokenFor('PRO'), {token: 'at-pro-live', source: 'live'});
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    assert.deepEqual(await s.accessTokenFor('PERSO'), {token: 'at-perso', source: 'store'});
    s.writeProfile({version: 1, name: 'TEAM', account: account('team'),
        credentials: creds('team', {expiresAt: NOW + 1000})});
    assert.deepEqual(await s.accessTokenFor('TEAM'), {token: 'at-fresh', source: 'refreshed'});
    assert.equal(calls.length, 1);
    // the live login was never written by any of this
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-pro-live');
});

test('refreshProfile keeps the old refresh token when the server sends none', async () => {
    const {io, s} = world();
    io.fetchImpl = async () => ({ok: true, status: 200, json: async () => ({access_token: 'x', expires_in: 60})});
    const p = s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    const fresh = await s.refreshProfile(p);
    assert.equal(fresh.credentials.claudeAiOauth.refreshToken, 'rt-perso');
    assert.equal(fresh.credentials.claudeAiOauth.accessToken, 'x');
    assert.equal(fresh.credentials.claudeAiOauth.subscriptionType, 'max');
});

test('usageFor fetches with the right token and normalizes; usage cache round-trips', async () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    const seen = [];
    io.fetchImpl = async (url, init) => {
        seen.push(init.headers.authorization);
        return {ok: true, status: 200, json: async () => ({limits: [
            {kind: 'session', percent: init.headers.authorization.endsWith('perso') ? 20 : 95},
            {kind: 'weekly_all', percent: 40},
        ]})};
    };
    const r = await s.usageFor('PERSO');
    assert.equal(r.ok, true);
    assert.deepEqual(r.cards.map((c) => [c.key, c.percent]), [['session', 20], ['weekly_all', 40]]);
    assert.deepEqual(seen, ['Bearer at-perso']);

    s.writeUsageCache({PERSO: r, PRO: await s.usageFor('PRO'), X: {ok: false}});
    const cache = s.readUsageCache();
    assert.deepEqual(cache.accounts, {
        PERSO: {worst: 40, session: 20, weekly: 40}, PRO: {worst: 95, session: 95, weekly: 40},
    });
    assert.deepEqual(worstFromCache(cache), {PERSO: 40, PRO: 95});
    assert.equal(openStore({...io, nowMs: NOW + 31 * 60_000}).readUsageCache(), null, 'stale cache is ignored');
    assert.deepEqual(autoSwitchTarget({active: 'PRO', worst: worstFromCache(cache), nowMs: NOW}),
        {from: 'PRO', to: 'PERSO', activePercent: 95, targetPercent: 40});
});

test('usageFor reports a rejected token as auth_expired, not a throw', async () => {
    const {io, s} = world();
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    io.fetchImpl = async () => ({ok: false, status: 401, json: async () => ({})});
    assert.equal((await s.usageFor('PERSO')).code, 'auth_expired');
    assert.equal((await s.usageFor('NOPE')).code, 'no_token');
});

test('syncBack is a no-op for an unsaved login and rewrites only when something moved', () => {
    const {home, s} = world();
    assert.equal(s.syncBack(), null);
    s.saveCurrent('PRO');
    const file = path.join(home, '.local/state/claude-usage-panel/accounts/PRO.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(s.syncBack(), 'PRO');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('removeProfile deletes the file and refuses unknown names', () => {
    const {s} = world();
    s.saveCurrent('PRO');
    s.removeProfile('PRO');
    assert.deepEqual(s.listProfiles(), []);
    assert.throws(() => s.removeProfile('PRO'), /no saved account/);
});

test('listProfiles skips foreign, dot and mismatched files', () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    const dir = accountsDir(io);
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), '{}');
    fs.writeFileSync(path.join(dir, 'junk.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'RENAMED.json'), fs.readFileSync(path.join(dir, 'PRO.json')));
    assert.deepEqual(s.listProfiles().map((p) => p.name), ['PRO']);
});

test('runningClaudeCount counts claude processes, not lookalikes', () => {
    const ps = [
        '/home/u/.local/bin/claude', 'node /x/claude --resume abc', 'claude-usage-panel/mcp/server.js',
        'grep claude', '/usr/bin/claude-something', 'claude',
    ].join('\n');
    assert.equal(openStore({exec: () => ps}).runningClaudeCount(), 3);
    assert.equal(openStore({exec: () => { throw new Error('no ps'); }}).runningClaudeCount(), 0);
});

test('CLAUDE_CONFIG_DIR moves both the credentials and .claude.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-accounts-'));
    const cfg = path.join(home, 'alt');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify(creds('alt')));
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({oauthAccount: account('alt')}));
    const s = openStore({homedir: home, platform: 'linux', env: {CLAUDE_CONFIG_DIR: cfg}, nowMs: NOW});
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-alt');
    assert.equal(s.readLiveAccount().emailAddress, 'alt@example.com');
});

test('a pending mark left by a switch that did complete clears itself', () => {
    const {s} = world();
    s.saveCurrent('PRO');
    fs.writeFileSync(path.join(s.dir, '.switch-pending.json'), JSON.stringify({at: NOW, from: 'X', to: 'PRO'}));
    assert.equal(s.syncBack(), 'PRO');
    assert.equal(s.readPendingSwitch(), null);
});

test('syncBack keeps a profile\'s identity when ~/.claude.json has no oauthAccount', () => {
    const {home, s} = world();
    s.saveCurrent('PRO');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({numStartups: 1}));
    assert.equal(s.syncBack(), 'PRO');
    assert.deepEqual(s.readProfile('PRO').account, account('pro'));
    // ... so the twin guard still sees PRO when the same account logs in again.
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('pro', {accessToken: 'at-new'})));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('pro')}));
    assert.throws(() => s.saveCurrent('WORK'), /already saved as PRO/);
});

test('saveCurrent refuses a name that differs from a saved one only by case', () => {
    const {home, s} = world();
    s.saveCurrent('PRO');
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('perso')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('perso')}));
    assert.throws(() => s.saveCurrent('Pro'), /PRO already exists - names ignore case/);
    assert.throws(() => s.saveCurrent('pro', {force: true}), /PRO already exists/);
    assert.deepEqual(fs.readdirSync(s.dir).sort(), ['PRO.json']);
});

test('refreshProfile keeps the old expiry when expires_in is null, a string or zero', async () => {
    // Number(null) is 0: the store used to stamp expiresAt = now, so the
    // profile read stale at once and was refreshed on every use.
    for (const expiresIn of [null, '3600', '', 0, true]) {
        const {io, s} = world();
        io.fetchImpl = async () => ({ok: true, status: 200, json: async () => ({access_token: 'x', expires_in: expiresIn})});
        const p = s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
        const fresh = await s.refreshProfile(p);
        assert.equal(fresh.credentials.claudeAiOauth.expiresAt, NOW + 3_600_000, `expires_in ${JSON.stringify(expiresIn)}`);
        assert.equal(fresh.credentials.claudeAiOauth.accessToken, 'x');
    }
});

test('syncBack does not rewrite a profile when Claude Code only reordered its keys', () => {
    const {home, io, s} = world();
    s.saveCurrent('PRO');
    const file = path.join(s.dir, 'PRO.json');
    const before = fs.readFileSync(file, 'utf8');
    const reorder = (o) => Object.fromEntries(Object.entries(o).reverse());
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify({claudeAiOauth: reorder(creds('pro').claudeAiOauth)}));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: reorder(account('pro'))}));
    // A rewrite would carry a new savedAt: move the clock so it would show.
    io.nowMs = NOW + 60_000;
    assert.equal(openStore(io).syncBack(), 'PRO');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});
