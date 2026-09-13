// Named accounts: the pure contract against the shared fixture, and the store
// / switch / refresh I/O against a throwaway HOME. No network: fetch is faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    AUTO_SWITCH,
    REFRESH_LEAD_MS,
    accessTokenFor,
    accountSummary,
    accountsDir,
    activeAccountName,
    autoSwitchTarget,
    headroom,
    isValidName,
    limitPercents,
    listProfiles,
    liveAccountName,
    main,
    parseProfile,
    readLiveAccount,
    readLiveCredentials,
    readUsageCache,
    refreshProfile,
    removeProfile,
    runningClaudeCount,
    saveCurrent,
    switchTo,
    syncBack,
    tokenState,
    usageFor,
    worstFromCache,
    worstPercent,
    writeProfile,
    writeUsageCache,
} from '../claude-code/accounts.js';

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

test('headroom matches the fixture', () => {
    for (const c of FIX.headroom) assert.equal(headroom(c.cards), c.expected, c.name);
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

test('limitPercents reads limits[] (scoped keyed by model) and the legacy fields', () => {
    assert.deepEqual(limitPercents({
        limits: [
            {kind: 'session', percent: 26.4},
            {kind: 'weekly_scoped', percent: 91, scope: {model: {display_name: 'Fable'}}},
            {kind: 'weekly_all', utilization: 140},
        ],
    }), {'session': 26, 'weekly_scoped:Fable': 91, 'weekly_all': 100});
    assert.deepEqual(limitPercents({five_hour: {utilization: 12}, seven_day: {utilization: 34}}),
        {session: 12, weekly_all: 34});
    assert.deepEqual(limitPercents(null), {});
    assert.equal(worstPercent([{percent: 12}, {percent: 34}]), 34);
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
    return {home, io, calls};
}

test('saveCurrent writes a 0600 profile from the live login; list + current see it', () => {
    const {home, io} = world();
    const p = saveCurrent('PRO', io);
    assert.equal(p.account.emailAddress, 'pro@example.com');
    const file = path.join(home, '.local/state/claude-usage-panel/accounts/PRO.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(listProfiles(io).map((x) => x.name), ['PRO']);
    assert.equal(liveAccountName(io), 'PRO');
});

test('saveCurrent refuses a taken name, a twin, and a bad name; --force overrides', () => {
    const {home, io} = world();
    saveCurrent('PRO', io);
    assert.throws(() => saveCurrent('PERSO', io), /already saved as PRO/);
    assert.throws(() => saveCurrent('bad name', io), /invalid name/);
    // another login under a name that belongs to a different account
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('perso')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('perso')}));
    assert.throws(() => saveCurrent('PRO', io), /PRO is already pro@example.com/);
    saveCurrent('PRO', io, {force: true});
    assert.equal(listProfiles(io)[0].account.emailAddress, 'perso@example.com');
});

test('saveCurrent without a live login says so', () => {
    const {io} = world({live: null});
    assert.throws(() => saveCurrent('PRO', io), /no Claude Code login/);
});

test('switchTo installs the target login and patches only oauthAccount in ~/.claude.json', async () => {
    const {home, io} = world({extraConfig: {theme: 'dark', projects: {'/x': {}}}});
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);

    const r = await switchTo('PERSO', io);
    assert.deepEqual(r, {from: 'PRO', to: 'PERSO', changed: true, running: 0, email: 'perso@example.com'});
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-perso');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.oauthAccount.emailAddress, 'perso@example.com');
    assert.equal(cfg.theme, 'dark');
    assert.deepEqual(cfg.projects, {'/x': {}});
    assert.equal(cfg.numStartups, 3);
    assert.equal(fs.statSync(path.join(home, '.claude', '.credentials.json')).mode & 0o777, 0o600);
    assert.equal(liveAccountName(io), 'PERSO');
});

test('switchTo syncs the rotated live tokens back into the profile first', async () => {
    const {home, io} = world();
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    // Claude Code rotated PRO's tokens since we saved it.
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify(creds('pro', {accessToken: 'at-pro-rotated', refreshToken: 'rt-pro-rotated'})));

    await switchTo('PERSO', io);
    const pro = listProfiles(io).find((p) => p.name === 'PRO');
    assert.equal(pro.credentials.claudeAiOauth.refreshToken, 'rt-pro-rotated');
    // and back again restores the rotated one, not the stale original
    await switchTo('PRO', io);
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-pro-rotated');
});

test('switchTo parks an unsaved live login instead of losing it', async () => {
    const {io} = world({live: 'admin'});
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    const r = await switchTo('PERSO', io);
    assert.equal(r.from, 'admin');
    assert.deepEqual(listProfiles(io).map((p) => p.name), ['PERSO', 'admin']);
    assert.equal(listProfiles(io).find((p) => p.name === 'admin').credentials.claudeAiOauth.accessToken, 'at-admin');
});

test('switchTo to the active account is a no-op', async () => {
    const {io} = world();
    saveCurrent('PRO', io);
    const r = await switchTo('PRO', io);
    assert.equal(r.changed, false);
    assert.equal(r.from, 'PRO');
});

test('switchTo refreshes a stale target before installing it, and stores the rotation', async () => {
    const {io, calls} = world();
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'),
        credentials: creds('perso', {expiresAt: NOW - 1})}, io);
    await switchTo('PERSO', io);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /oauth\/token$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.grant_type, 'refresh_token');
    assert.equal(body.refresh_token, 'rt-perso');
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-fresh');
    const stored = listProfiles(io).find((p) => p.name === 'PERSO').credentials.claudeAiOauth;
    assert.equal(stored.refreshToken, 'rt-fresh');
    assert.equal(stored.expiresAt, NOW + 28_800_000);
    assert.deepEqual(stored.scopes, ['user:inference']);
});

test('a failed refresh leaves the current login untouched', async () => {
    const {io} = world();
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'),
        credentials: creds('perso', {expiresAt: NOW - 1})}, io);
    io.fetchImpl = async () => ({ok: false, status: 401, json: async () => ({})});
    await assert.rejects(switchTo('PERSO', io), /token refresh rejected \(HTTP 401\)/);
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-pro');
    assert.equal(readLiveAccount(io).emailAddress, 'pro@example.com');
});

test('an expired target refuses to switch', async () => {
    const {io} = world();
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'OLD', account: account('old'),
        credentials: creds('old', {refreshTokenExpiresAt: NOW - 1})}, io);
    await assert.rejects(switchTo('OLD', io), /login expired/);
    await assert.rejects(switchTo('NOPE', io), /no saved account named NOPE/);
});

test('accessTokenFor: live for the active account, stored when valid, refreshed when stale', async () => {
    const {home, io, calls} = world();
    saveCurrent('PRO', io);
    // the live token moved on; the active account must answer with the live one
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
        JSON.stringify(creds('pro', {accessToken: 'at-pro-live'})));
    assert.deepEqual(await accessTokenFor('PRO', io), {token: 'at-pro-live', source: 'live'});
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    assert.deepEqual(await accessTokenFor('PERSO', io), {token: 'at-perso', source: 'store'});
    writeProfile({version: 1, name: 'TEAM', account: account('team'),
        credentials: creds('team', {expiresAt: NOW + 1000})}, io);
    assert.deepEqual(await accessTokenFor('TEAM', io), {token: 'at-fresh', source: 'refreshed'});
    assert.equal(calls.length, 1);
    // the live login was never written by any of this
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-pro-live');
});

test('refreshProfile keeps the old refresh token when the server sends none', async () => {
    const {io} = world();
    io.fetchImpl = async () => ({ok: true, status: 200, json: async () => ({access_token: 'x', expires_in: 60})});
    const p = writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    const fresh = await refreshProfile(p, io);
    assert.equal(fresh.credentials.claudeAiOauth.refreshToken, 'rt-perso');
    assert.equal(fresh.credentials.claudeAiOauth.accessToken, 'x');
    assert.equal(fresh.credentials.claudeAiOauth.subscriptionType, 'max');
});

test('usageFor fetches with the right token and summarizes percents; usage cache round-trips', async () => {
    const {io} = world();
    saveCurrent('PRO', io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    const seen = [];
    io.fetchImpl = async (url, init) => {
        seen.push(init.headers.authorization);
        return {ok: true, status: 200, json: async () => ({limits: [
            {kind: 'session', percent: init.headers.authorization.endsWith('perso') ? 20 : 95},
            {kind: 'weekly_all', percent: 40},
        ]})};
    };
    const r = await usageFor('PERSO', io);
    assert.equal(r.ok, true);
    assert.deepEqual(r.percents, {session: 20, weekly_all: 40});
    assert.deepEqual(seen, ['Bearer at-perso']);

    writeUsageCache({PERSO: r, PRO: await usageFor('PRO', io), X: {ok: false}}, io);
    const cache = readUsageCache(io);
    assert.deepEqual(cache.accounts, {
        PERSO: {worst: 40, session: 20, weekly: 40}, PRO: {worst: 95, session: 95, weekly: 40},
    });
    assert.deepEqual(worstFromCache(cache), {PERSO: 40, PRO: 95});
    assert.equal(readUsageCache({...io, nowMs: NOW + 31 * 60_000}), null, 'stale cache is ignored');
    assert.deepEqual(autoSwitchTarget({active: 'PRO', worst: worstFromCache(cache), nowMs: NOW}),
        {from: 'PRO', to: 'PERSO', activePercent: 95, targetPercent: 40});
});

test('usageFor reports a rejected token as auth_expired, not a throw', async () => {
    const {io} = world();
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    io.fetchImpl = async () => ({ok: false, status: 401, json: async () => ({})});
    assert.equal((await usageFor('PERSO', io)).code, 'auth_expired');
    assert.equal((await usageFor('NOPE', io)).code, 'no_token');
});

test('syncBack is a no-op for an unsaved login and rewrites only when something moved', () => {
    const {home, io} = world();
    assert.equal(syncBack(io), null);
    saveCurrent('PRO', io);
    const file = path.join(home, '.local/state/claude-usage-panel/accounts/PRO.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(syncBack(io), 'PRO');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('removeProfile deletes the file and refuses unknown names', () => {
    const {io} = world();
    saveCurrent('PRO', io);
    removeProfile('PRO', io);
    assert.deepEqual(listProfiles(io), []);
    assert.throws(() => removeProfile('PRO', io), /no saved account/);
});

test('listProfiles skips foreign, dot and mismatched files', () => {
    const {io} = world();
    saveCurrent('PRO', io);
    const dir = accountsDir(io);
    fs.writeFileSync(path.join(dir, '.usage-cache.json'), '{}');
    fs.writeFileSync(path.join(dir, 'junk.json'), '{nope');
    fs.writeFileSync(path.join(dir, 'RENAMED.json'), fs.readFileSync(path.join(dir, 'PRO.json')));
    assert.deepEqual(listProfiles(io).map((p) => p.name), ['PRO']);
});

test('runningClaudeCount counts claude processes, not lookalikes', () => {
    const io = {exec: () => [
        '/home/u/.local/bin/claude', 'node /x/claude --resume abc', 'claude-usage-mcp.mjs',
        'grep claude', '/usr/bin/claude-something', 'claude',
    ].join('\n')};
    assert.equal(runningClaudeCount(io), 3);
    assert.equal(runningClaudeCount({exec: () => { throw new Error('no ps'); }}), 0);
});

test('CLAUDE_CONFIG_DIR moves both the credentials and .claude.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-accounts-'));
    const cfg = path.join(home, 'alt');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify(creds('alt')));
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({oauthAccount: account('alt')}));
    const io = {homedir: home, platform: 'linux', env: {CLAUDE_CONFIG_DIR: cfg}, nowMs: NOW};
    assert.equal(readLiveCredentials(io).claudeAiOauth.accessToken, 'at-alt');
    assert.equal(readLiveAccount(io).emailAddress, 'alt@example.com');
});

// ── CLI ─────────────────────────────────────────────────────────────────────────

async function run(argv, io) {
    let text = '';
    const code = await main(argv, {...io, stdout: (s) => { text += s; }});
    return {code, text};
}

test('CLI: save, list, current, use, remove', async () => {
    const {io} = world();
    assert.match((await run(['list'], io)).text, /no saved accounts/);
    assert.match((await run(['save', 'PRO'], io)).text, /saved PRO \(pro@example.com\)/);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);

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
    const {io} = world();
    io.exec = () => 'claude\n/usr/local/bin/claude --resume x\n';
    await run(['save', 'PRO'], io);
    writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')}, io);
    const use = await run(['use', 'PERSO'], io);
    assert.match(use.text, /2 Claude Code sessions still running on the old login - restart to use PERSO/);

    io.fetchImpl = async () => ({ok: true, status: 200, json: async () => ({limits: [
        {kind: 'session', percent: 12}, {kind: 'weekly_all', percent: 34},
    ]})});
    const list = await run(['list', '--usage'], io);
    assert.match(list.text, /PERSO.*S 12% {2}W 34%/);
    assert.deepEqual(worstFromCache(readUsageCache(io)), {PERSO: 34, PRO: 34});
});

test('CLI: current reports an unsaved login with exit 1', async () => {
    const {io} = world({live: 'someone'});
    const r = await run(['current'], io);
    assert.equal(r.code, 1);
    assert.match(r.text, /not saved: someone@example.com/);
});
