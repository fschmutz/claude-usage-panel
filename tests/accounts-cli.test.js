// Named accounts, the CLI: account-cli.js's main (dispatched by claudectl
// as `claudectl account ...`), against a throwaway HOME. No network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {main} from '../claude-code/account-cli.js';
import {worstFromCache} from '../claude-code/accounts-contract.js';
import {accountsDir} from '../claude-code/paths.js';
import {NOW, account, creds, world} from './accounts-world.js';

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
    assert.match((await run([], io)).text, /claudectl account list/);
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

test('CLI: refresh goes on past a dead login and exits 1', async () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    s.writeProfile({version: 1, name: 'A', account: account('a'), credentials: {claudeAiOauth: {accessToken: 'at-a'}}});
    s.writeProfile({version: 1, name: 'B', account: account('b'), credentials: creds('b')});
    const r = await run(['refresh'], io);
    assert.equal(r.code, 1);
    assert.match(r.text, /^A: no refresh token/m);
    assert.match(r.text, /^B: refreshed, valid until /m);
    assert.match(r.text, /^PRO: active login/m);
    assert.equal(s.readProfile('B').credentials.claudeAiOauth.accessToken, 'at-fresh');
});

test('CLI: help names the accounts directory of the io it was given', async () => {
    const {io, s} = world();
    const r = await run(['help'], io);
    assert.ok(r.text.includes(s.dir), r.text);
    assert.ok(!r.text.includes(accountsDir({})), 'not the real process dir');
});

test('CLI: list points at an unfinished switch', async () => {
    const {io, s} = world();
    s.saveCurrent('PRO');
    fs.writeFileSync(path.join(s.dir, '.switch-pending.json'), JSON.stringify({at: NOW, from: 'PRO', to: 'PERSO'}));
    assert.match((await run(['list'], io)).text, /switch to PERSO did not finish - `claudectl account use PERSO`/);
});

test('CLI: current reports an unsaved login with exit 1', async () => {
    const {io} = world({live: 'someone'});
    const r = await run(['current'], io);
    assert.equal(r.code, 1);
    assert.match(r.text, /not saved: someone@example.com/);
});
