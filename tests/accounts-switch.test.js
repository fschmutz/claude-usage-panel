// Named accounts, switching: installLogin order, torn and unfinished
// switches, refresh-before-install, parking an unsaved login, and the macOS
// Keychain path through a fake /usr/bin/security. openStore is bound to a
// throwaway HOME; fetch and exec are faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {openStore} from '../claude-code/accounts.js';
import {autoSwitchTarget, keychainServices} from '../claude-code/accounts-contract.js';
import {NOW, account, creds, fakeSecurity, sha256Hex, world} from './accounts-world.js';

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

test('a switch that cannot write ~/.claude.json changes nothing and loses nothing', async () => {
    const {home, io, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    // The config is validated before the first write: a file that is not a
    // JSON object aborts the switch with the live login untouched.
    fs.writeFileSync(path.join(home, '.claude.json'), '[1, 2, 3]');
    await assert.rejects(s.switchTo('PERSO'), /is not a JSON object/);
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-pro');
    assert.equal(s.readLastSwitchMs(), null);
    // And a write that fails mid-way: the account block is a directory, so
    // the atomic rename over it throws after validation - creds still old.
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('pro')}));
    fs.rmSync(path.join(home, '.claude.json'));
    fs.mkdirSync(path.join(home, '.claude.json'));
    await assert.rejects(s.switchTo('PERSO'));
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-pro');
    const pro = s.listProfiles().find((p) => p.name === 'PRO').credentials.claudeAiOauth;
    assert.equal(pro.refreshToken, 'rt-pro', "PRO's refresh token survives");
    assert.equal(io.nowMs, NOW);
});

test('an interrupted switch is recognized by its token and finished, never snapshotted across', async () => {
    const {home, io, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    // Simulate the torn state a crash between the two writes leaves: the
    // account block already says PERSO, the credentials are still PRO's.
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: account('perso')}));
    assert.equal(s.liveAccountName(), 'PRO', 'the installed token decides');
    // syncBack names the login but refuses to write a torn pair anywhere.
    assert.equal(s.syncBack(), 'PRO');
    assert.equal(s.listProfiles().find((p) => p.name === 'PERSO').credentials.claudeAiOauth.accessToken, 'at-perso');
    assert.equal(s.listProfiles().find((p) => p.name === 'PRO').credentials.claudeAiOauth.accessToken, 'at-pro');
    // Re-running the switch completes it.
    const r = await s.switchTo('PERSO');
    assert.equal(r.changed, true);
    assert.equal(s.readLiveCredentials().claudeAiOauth.accessToken, 'at-perso');
    assert.equal(s.readLiveAccount().emailAddress, 'perso@example.com');
    assert.equal(io.nowMs, NOW);
});

test('the other torn state (credentials installed, account block behind) is repaired in place', async () => {
    const {home, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('perso')));
    assert.equal(s.liveAccountName(), 'PERSO');
    const r = await s.switchTo('PERSO');
    assert.equal(r.changed, false);
    assert.equal(s.readLiveAccount().emailAddress, 'perso@example.com', 'account block caught up');
    assert.equal(s.listProfiles().find((p) => p.name === 'PRO').credentials.claudeAiOauth.accessToken, 'at-pro');
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

test('a switch whose credentials write fails leaves a pending mark; a rotation cannot corrupt PERSO', async () => {
    // macOS without a credentials file: the Keychain holds the live login.
    const {home, io} = world();
    fs.rmSync(path.join(home, '.claude', '.credentials.json'));
    const keychain = new Map([['Claude Code-credentials', JSON.stringify(creds('pro'))]]);
    let failWrites = true;
    io.platform = 'darwin';
    const sec = fakeSecurity(keychain, {denied: () => failWrites});
    io.exec = sec.exec;
    const store = openStore(io);
    store.saveCurrent('PRO');
    store.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    // `security -i` exits 0 on the denied write; the read-back catches it.
    await assert.rejects(store.switchTo('PERSO'), /could not write the Keychain item Claude Code-credentials/);
    assert.equal(store.readLiveAccount().emailAddress, 'perso@example.com', 'account block went in');
    assert.equal(store.liveAccessToken(), 'at-pro', 'credentials did not');
    assert.deepEqual(store.readPendingSwitch(), {at: NOW, from: 'PRO', to: 'PERSO'});
    // A running Claude Code refreshes PRO's token: no profile holds it now.
    keychain.set('Claude Code-credentials', JSON.stringify(creds('pro', {accessToken: 'at-pro-rot', refreshToken: 'rt-pro-rot'})));
    assert.equal(store.syncBack(), 'PERSO');
    const perso = store.readProfile('PERSO').credentials.claudeAiOauth;
    assert.equal(perso.refreshToken, 'rt-perso', "PERSO keeps its own refresh token");
    assert.equal((await store.listAccounts()).pendingSwitch.to, 'PERSO');
    // Re-running the switch finishes it and clears the mark.
    failWrites = false;
    const r = await store.switchTo('PERSO');
    assert.deepEqual([r.from, r.to, r.changed], ['PRO', 'PERSO', true]);
    assert.equal(store.liveAccessToken(), 'at-perso');
    assert.equal(store.readPendingSwitch(), null);
    assert.deepEqual(sec.argvs.filter((a) => /at-|rt-/.test(a)), [], 'no token ever sits in an argv');
});

test('a Keychain write security -i cannot take is refused before the live login is touched', async () => {
    const big = {...creds('perso'), mcpOAuth: {server: {accessToken: 'x'.repeat(2100)}}};
    for (const [what, acct, credentials] of [
        ['an unquotable account name', 'me\\x', creds('perso')],
        ['a blob over the 4096-byte command line', 'me', big],
    ]) {
        const {home, io} = world();
        fs.rmSync(path.join(home, '.claude', '.credentials.json'));
        const keychain = new Map([['Claude Code-credentials', JSON.stringify(creds('pro'))]]);
        io.platform = 'darwin';
        const sec = fakeSecurity(keychain, {acct});
        io.exec = sec.exec;
        const store = openStore(io);
        store.saveCurrent('PRO');
        store.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials});
        const config = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
        await assert.rejects(store.switchTo('PERSO'), /cannot write the Keychain item Claude Code-credentials/, what);
        assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), config, `${what}: account block untouched`);
        assert.equal(store.liveAccessToken(), 'at-pro', `${what}: credentials untouched`);
        assert.equal(store.readPendingSwitch(), null, `${what}: no pending mark`);
        assert.deepEqual(sec.argvs.filter((a) => a.startsWith('-i')), [], `${what}: security -i never ran`);
    }
});

test('switchTo parks an unsaved login whose email starts with an underscore', async () => {
    const {home, s} = world({live: null});
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify(creds('ops')));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({oauthAccount: {accountUuid: 'u-ops', emailAddress: '_ops@x.com'}}));
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    const r = await s.switchTo('PERSO');
    assert.equal(r.from, 'ops');
    assert.equal(s.readProfile('ops').credentials.claudeAiOauth.accessToken, 'at-ops');
});

test('CLAUDE_CONFIG_DIR on macOS reads and writes that dir\'s own Keychain item', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-accounts-'));
    const cfg = path.join(home, 'work');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({oauthAccount: account('work')}));
    const [service] = keychainServices({CLAUDE_CONFIG_DIR: cfg}, sha256Hex);
    const keychain = new Map([
        ['Claude Code-credentials', JSON.stringify(creds('default'))],
        [service, JSON.stringify(creds('work'))],
    ]);
    const io = {
        homedir: home, platform: 'darwin', env: {CLAUDE_CONFIG_DIR: cfg}, nowMs: NOW,
        exec: fakeSecurity(keychain).exec,
    };
    const s = openStore(io);
    assert.equal(s.liveAccessToken(), 'at-work');
    s.saveCurrent('WORK');
    s.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});
    await s.switchTo('PERSO');
    assert.equal(JSON.parse(keychain.get(service)).claudeAiOauth.accessToken, 'at-perso');
    assert.equal(JSON.parse(keychain.get('Claude Code-credentials')).claudeAiOauth.accessToken, 'at-default',
        'the default dir\'s login is untouched');
});
