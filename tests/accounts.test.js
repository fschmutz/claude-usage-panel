// Named accounts: the pure contract against the shared fixture, and the store
// / switch / refresh I/O (openStore bound to a throwaway HOME). No network:
// fetch is faked. The CLI is exercised through claude-account.js's main.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    AUTO_SWITCH,
    REFRESH_LEAD_MS,
    accountSummary,
    accountsDir,
    activeAccountName,
    autoSwitchTarget,
    claudeConfigPath,
    credentialsPath,
    isValidName,
    openStore,
    parseProfile,
    tokenState,
    worstFromCache,
    worstPercent,
} from '../claude-code/accounts.js';
import {main} from '../claude-code/claude-account.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'accounts.json'), 'utf8'));
const NOW = FIX.now;

// ── Pure contract ───────────────────────────────────────────────────────────────

test('fixture constants are the module constants', () => {
    assert.equal(REFRESH_LEAD_MS, FIX.refreshLeadMs);
    assert.equal(AUTO_SWITCH.threshold, FIX.threshold);
    assert.equal(AUTO_SWITCH.margin, FIX.margin);
    assert.equal(AUTO_SWITCH.cooldownMs, FIX.cooldownMs);
});

test('parseProfile accepts the fixture profiles and rejects the invalid ones', () => {
    for (const raw of FIX.profiles) {
        const p = parseProfile(raw);
        assert.ok(p, raw.name);
        assert.equal(p.name, raw.name);
        assert.deepEqual(p.credentials, raw.credentials);
    }
    for (const raw of FIX.invalidProfiles) assert.equal(parseProfile(raw), null, JSON.stringify(raw));
});

test('name rules', () => {
    for (const n of FIX.validNames) assert.ok(isValidName(n), n);
    for (const n of FIX.invalidNames) assert.ok(!isValidName(n), n);
});

test('accountSummary + tokenState match the fixture', () => {
    const profiles = FIX.profiles.map(parseProfile);
    assert.deepEqual(profiles.map((p) => accountSummary(p, NOW)), FIX.summaries);
    for (const s of FIX.summaries) {
        assert.equal(tokenState(profiles.find((p) => p.name === s.name), NOW), s.tokenState, s.name);
    }
});

test('activeAccountName matches the fixture', () => {
    const profiles = FIX.profiles.map(parseProfile);
    for (const c of FIX.active) assert.equal(activeAccountName(profiles, c.live), c.expected, c.name);
});

test('autoSwitchTarget matches the fixture', () => {
    for (const c of FIX.autoSwitch) {
        const got = autoSwitchTarget({
            active: c.active, worst: c.worst, lastSwitchMs: c.lastSwitchMs, nowMs: NOW,
            threshold: FIX.threshold, margin: FIX.margin, cooldownMs: FIX.cooldownMs,
        });
        assert.deepEqual(got, c.expected, c.name);
    }
});

test('worstPercent takes the fullest card, clamped', () => {
    assert.equal(worstPercent([{percent: 12}, {percent: 34}]), 34);
    assert.equal(worstPercent([{percent: 140}]), 100);
    assert.equal(worstPercent([]), null);
});

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

const creds = (tag, extra = {}) => ({claudeAiOauth: {
    accessToken: `at-${tag}`, refreshToken: `rt-${tag}`,
    expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 30 * 86_400_000,
    subscriptionType: 'max', ...extra,
}});
const account = (tag) => ({accountUuid: `u-${tag}`, emailAddress: `${tag}@example.com`});

// A fake HOME with a live login (or none) and an io context bound to it.
function world({live = 'pro', extraConfig = {}} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-accounts-'));
    fs.mkdirSync(path.join(home, '.claude'));
    if (live) {
        fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds(live)));
        fs.writeFileSync(path.join(home, '.claude.json'),
            JSON.stringify({numStartups: 3, oauthAccount: account(live), ...extraConfig}));
    }
    const calls = [];
    const io = {
        homedir: home, platform: 'linux', env: {}, nowMs: NOW,
        exec: () => 'ps output with no claude in it\n',
        fetchImpl: async (url, init) => {
            calls.push({url, init});
            return {ok: true, status: 200, json: async () => ({
                access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 28800, scope: 'user:inference',
            })};
        },
    };
    return {home, io, calls, s: openStore(io)};
}

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
});

test('saveCurrent without a live login says so', () => {
    const {s} = world({live: null});
    assert.throws(() => s.saveCurrent('PRO'), /no Claude Code login/);
});

test('switchTo installs the target login and patches only oauthAccount in ~/.claude.json', async () => {
    const {home, s} = world({extraConfig: {theme: 'dark', projects: {'/x': {}}}});
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});

    const r = await s.switchTo('PERSO');
    assert.deepEqual(r, {from: 'PRO', to: 'PERSO', changed: true, running: 0, email: 'perso@example.com'});
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-perso');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'perso@example.com');
    assert.equal(cfg.theme, 'dark');
    assert.deepEqual(cfg.projects, {'/x': {}});
    assert.equal(cfg.numStartups, 3);
    assert.equal(fs.statSync(path.join(home, '.claude', '.credentials.json')).mode & 0o777, 0o600);
    assert.equal(s.liveAccountName(), 'PERSO');
    // the switch is store state: every auto-switch caller sees the same cooldown anchor
    assert.equal(s.readLastSwitchMs(), NOW);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, '.last-switch.json'), 'utf8')),
        {at: NOW, from: 'PRO', to: 'PERSO'});
    assert.equal(autoSwitchTarget({active: 'PERSO', worst: {PERSO: 95, PRO: 10}, nowMs: NOW + 1000,
        lastSwitchMs: s.readLastSwitchMs()}), null, 'cooldown from the file');
});

test('a no-op switch does not stamp the last switch', async () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    assert.equal(s.readLastSwitchMs(), null);
    await s.switchTo('PRO');
    assert.equal(s.readLastSwitchMs(), null);
    assert.equal(io.nowMs, NOW);
});

test('switchTo syncs the rotated live tokens back into the profile first', async () => {
    const {home, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    // Claude Code rotated PRO's tokens since we saved it.
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify(creds('pro', {accessToken: 'at-pro-rotated', refreshToken: 'rt-pro-rotated'})));

    await s.switchTo('PERSO');
    const pro = s.listProfiles().find((p) => p.name === 'PRO');
    assert.equal(pro.credentials.claudeAiOauth.refreshToken, 'rt-pro-rotated');
    // and back again restores the rotated one, not the stale original
    await s.switchTo('PRO');
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-pro-rotated');
});

test('switchTo parks an unsaved live login instead of losing it', async () => {
    const {s} = world({live: 'admin'});
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    const r = await s.switchTo('PERSO');
    assert.equal(r.from, 'admin');
    assert.deepEqual(s.listProfiles().map((p) => p.name), ['PERSO', 'admin']);
    assert.equal(s.listProfiles().find((p) => p.name === 'admin').credentials.claudeAiOauth.accessToken, 'at-admin');
});

test('switchTo to the active account is a no-op', async () => {
    const {s} = world();
    s.saveCurrent('PRO');
    const r = await s.switchTo('PRO');
    assert.equal(r.changed, false);
    assert.equal(r.from, 'PRO');
});

test('switchTo refreshes a stale target before installing it, and stores the rotation', async () => {
    const {calls, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'),
        credentials: creds('perso', {expiresAt: NOW - 1})});
    await s.switchTo('PERSO');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /oauth\/token$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, 'rt-perso');
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-fresh');
    const stored = s.listProfiles().find((p) => p.name === 'PERSO').credentials.claudeAiOauth;
    assert.equal(stored.refreshToken, 'rt-fresh');
    assert.equal(stored.expiresAt, NOW + 28_800_000);
    assert.deepEqual(stored.scopes, ['user:inference']);
});

test('a failed refresh leaves the current login untouched', async () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'),
        credentials: creds('perso', {expiresAt: NOW - 1})});
    io.fetchImpl = async () => ({ok: false, status: 401, json: async () => ({})});
    await assert.rejects(s.switchTo('PERSO'), /token refresh rejected \(HTTP 401\)/);
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-pro');
    assert.equal(s.readLiveAccount().emailAddress, 'pro@example.com');
});

test('an expired target refuses to switch', async () => {
    const {s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'OLD', account: account('old'),
        credentials: creds('old', {refreshTokenExpiresAt: NOW - 1})});
    await assert.rejects(s.switchTo('OLD'), /login expired/);
    await assert.rejects(s.switchTo('NOPE'), /no saved account named NOPE/);
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

// ── CLI ─────────────────────────────────────────────────────────────────────────

async function run(argv, io) {
    let text = '';
    const code = await main(argv, {...io, stdout: (s) => { text += s; }});
    return {code, text};
}

test('CLI: save, list, current, use, remove', async () => {
    const {io, s} = world();
    assert.match((await run(['list'], io)).text, /no saved accounts/);
    assert.match((await run(['save', 'PRO'], io)).text, /saved PRO \(pro@example.com\)/);
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});

    const list = await run(['list'], io);
    assert.match(list.text, /^\* PRO {10}pro@example.com/m);
    assert.match(list.text, /^ {2}PERSO {8}perso@example.com/m);

    const current = await run(['current', '--json'], io);
    assert.deepEqual(JSON.parse(current.text), {name: 'PRO', email: 'pro@example.com'});

    const use = await run(['use', 'PERSO'], io);
    assert.match(use.text, /switched PRO -> PERSO \(perso@example.com\)/);
    assert.equal((await run(['current'], io)).text, 'PERSO\n');
    assert.match((await run(['use', 'PERSO'], io)).text, /already the current login/);

    const asJson = JSON.parse((await run(['list', '--json'], io)).text);
    assert.equal(asJson.active, 'PERSO');
    assert.deepEqual(asJson.accounts.map((a) => [a.name, a.active]), [['PERSO', true], ['PRO', false]]);

    assert.match((await run(['remove', 'PRO'], io)).text, /removed PRO/);
    await assert.rejects(run(['use', 'PRO'], io), /no saved account named PRO/);
    await assert.rejects(run(['bogus'], io), /unknown command bogus/);
    assert.match((await run([], io)).text, /claude-account list/);
});

test('CLI: use warns about running sessions; list --usage shows percents and fills the cache', async () => {
    const {io, s} = world();
    io.exec = () => 'claude\n/usr/local/bin/claude --resume x\n';
    await run(['save', 'PRO'], io);
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    const use = await run(['use', 'PERSO'], io);
    assert.match(use.text, /2 Claude Code sessions still running on the old login - restart to use PERSO/);

    io.fetchImpl = async () => ({ok: true, status: 200, json: async () => ({limits: [
        {kind: 'session', percent: 12}, {kind: 'weekly_all', percent: 34},
    ]})});
    const list = await run(['list', '--usage'], io);
    assert.match(list.text, /PERSO.*S 12% {2}W 34%/);
    assert.deepEqual(worstFromCache(s.readUsageCache()), {PERSO: 34, PRO: 34});
});

test('CLI: current reports an unsaved login with exit 1', async () => {
    const {io} = world({live: 'someone'});
    const r = await run(['current'], io);
    assert.equal(r.code, 1);
    assert.match(r.text, /not saved: someone@example.com/);
});
