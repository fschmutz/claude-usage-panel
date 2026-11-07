// The account store's step ORDER, on both JavaScript ports. The decisions are
// pinned by tests/fixtures/accounts.json; this pins the sequence that carries
// them out (lib/pure/accountStore.js): the same scenarios run through the
// Node port (claude-code/accounts.js, node:fs on a throwaway HOME) and the
// GJS port (lib/accounts.js, Gio async over an in-memory tree), every step
// that writes, moves, removes, creates or posts is recorded, and both logs
// must equal each other AND the order written out below. Reads are left out
// of the log (their count and order depend on the directory listing order),
// except the two ~/.claude.json reads a switch makes around its mark.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {memoryFs} from './gio-memory.js';
import {stub} from './gjs-stub.js';
import {openStore} from '../claude-code/accounts.js';
import {openStoreCore, runAsync, runSync} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accountStore.js';

const ACC = '.local/state/claude-usage-panel/accounts';
const FAR = 4_000_000_000_000;
const RECORDED = new Set([
    'readConfig', 'prepareCredentials', 'writePrivate', 'writeConfig', 'writeCredentials',
    'move', 'remove', 'createExclusive', 'postToken',
]);

const oauth = (tag, expiresAt = FAR) => ({accessToken: `at-${tag}`, refreshToken: `rt-${tag}`, expiresAt});
const profile = (name, tag, expiresAt = FAR) => JSON.stringify({
    version: 1, name, savedAt: null,
    account: {accountUuid: `u-${tag}`, emailAddress: `${tag}@example.com`},
    credentials: {claudeAiOauth: oauth(tag, expiresAt)},
});
const live = (tag, accountTag = tag) => ({
    '.claude/.credentials.json': JSON.stringify({claudeAiOauth: oauth(tag)}),
    '.claude.json': JSON.stringify({numStartups: 1, oauthAccount: {accountUuid: `u-${accountTag}`}}),
});
const granted = {status: 200, json: {access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600}};

/**
 * Each scenario: the tree (paths relative to HOME), optional mtimes (ms ago),
 * the sequence to run, the token endpoint's answer (`post(env)` may write to
 * the tree first, as a process that took no lock would), and the steps.
 */
const SCENARIOS = [
    {
        name: 'a switch over an unfinished one: validated, marked, re-read, written, cleared',
        files: {
            [`${ACC}/PRO.json`]: profile('PRO', 'pro'),
            [`${ACC}/PERSO.json`]: profile('PERSO', 'perso'),
            [`${ACC}/.switch-pending.json`]: JSON.stringify({at: 1, from: 'PRO', to: 'PERSO'}),
            ...live('pro'),
        },
        run: core => core.switchTo('PERSO'),
        steps: [
            ['readConfig'],
            ['prepareCredentials'],
            ['writePrivate', `~/${ACC}/.switch-pending.json`],
            ['readConfig'],
            ['writeConfig'],
            ['writeCredentials'],
            ['remove', `~/${ACC}/.switch-pending.json`],
            ['writePrivate', `~/${ACC}/.last-switch.json`],
        ],
    },
    {
        name: 'a stale lock is removed under the takeover guard, then the refresh runs under a lock of our own',
        files: {[`${ACC}/PERSO.json`]: profile('PERSO', 'perso', 1), [`${ACC}/.refresh-PERSO.lock`]: 'crashed'},
        agoMs: {[`${ACC}/.refresh-PERSO.lock`]: 60_000},
        run: (core, read) => core.refreshProfile(read('PERSO')),
        post: () => granted,
        steps: [
            ['createExclusive', `~/${ACC}/.refresh-PERSO.lock`, false],
            ['createExclusive', `~/${ACC}/.refresh-PERSO.lock.takeover`, true],
            ['remove', `~/${ACC}/.refresh-PERSO.lock`],
            ['remove', `~/${ACC}/.refresh-PERSO.lock.takeover`],
            ['createExclusive', `~/${ACC}/.refresh-PERSO.lock`, true],
            ['postToken'],
            ['writePrivate', `~/${ACC}/PERSO.json`],
            ['remove', `~/${ACC}/.refresh-PERSO.lock`],
        ],
        after: (read) => assert.equal(read('PERSO').credentials.claudeAiOauth.refreshToken, 'rt-new'),
    },
    {
        name: 'a 400 whose replacement is already on disk is a success, and writes nothing',
        files: {[`${ACC}/PERSO.json`]: profile('PERSO', 'perso', 1)},
        run: (core, read) => core.refreshProfile(read('PERSO')),
        post: env => {
            env.write(`${ACC}/PERSO.json`, profile('PERSO', 'elsewhere'));
            return {status: 400, json: null};
        },
        steps: [
            ['createExclusive', `~/${ACC}/.refresh-PERSO.lock`, true],
            ['postToken'],
            ['remove', `~/${ACC}/.refresh-PERSO.lock`],
        ],
        after: (read, result) => assert.equal(result.credentials.claudeAiOauth.accessToken, 'at-elsewhere'),
    },
    {
        name: 'a rename a crash left half done is finished: the old file goes, then the journal',
        files: {
            [`${ACC}/PRO.json`]: profile('PRO', 'pro'),
            [`${ACC}/WORK.json`]: profile('WORK', 'pro'),
            [`${ACC}/.rename-pending.json`]: JSON.stringify({at: 1, from: 'PRO', to: 'WORK'}),
        },
        sync: true,
        run: core => core.recoverRename(),
        steps: [
            ['remove', `~/${ACC}/PRO.json`],
            ['remove', `~/${ACC}/.rename-pending.json`],
        ],
    },
    {
        name: 'a torn live login (PERSO token, PRO account block) is named but never snapshotted',
        files: {
            [`${ACC}/PRO.json`]: profile('PRO', 'pro'),
            [`${ACC}/PERSO.json`]: profile('PERSO', 'perso'),
            ...live('perso', 'pro'),
        },
        sync: true,
        run: core => core.syncBack(),
        steps: [],
    },
];

/** Wrap `port`: record every RECORDED step (HOME as ~, the random stale suffix as *). */
function recording(port, home, post, env) {
    const steps = [];
    const rel = p => p.replaceAll(home, '~').replace(/\.stale-[^/]*$/, '.stale-*');
    const wrapped = {...port, ps: () => '', postToken: () => post(env)};
    for (const op of RECORDED) {
        const inner = wrapped[op];
        wrapped[op] = (...args) => {
            const entry = [op, ...args.filter(a => typeof a === 'string' && a.startsWith(home)).map(rel)];
            steps.push(entry);
            const out = inner(...args);
            const keep = value => {
                if (op === 'createExclusive' || op === 'move')
                    entry.push(value);
                return value;
            };
            return out && typeof out.then === 'function' ? out.then(keep) : keep(out);
        };
    }
    return {port: wrapped, steps};
}

async function onNode(s) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-core-'));
    const write = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(home, rel)), {recursive: true});
        fs.writeFileSync(path.join(home, rel), text);
    };
    for (const [rel, text] of Object.entries(s.files))
        write(rel, text);
    for (const [rel, ago] of Object.entries(s.agoMs ?? {}))
        fs.utimesSync(path.join(home, rel), (Date.now() - ago) / 1000, (Date.now() - ago) / 1000);
    const store = openStore({homedir: home, platform: 'linux', env: {}});
    const {port, steps} = recording(store.port, home, s.post ?? (() => granted), {write});
    const core = openStoreCore(port, {dir: store.dir, hints: store.hints});
    const gen = s.run(core, store.readProfile);
    const result = s.sync ? runSync(port, gen) : await runAsync(port, gen);
    s.after?.(store.readProfile, result);
    return steps;
}

async function onGjs(t, s) {
    const home = '/home/tester';
    const files = Object.fromEntries(Object.entries(s.files).map(([rel, text]) => [`${home}/${rel}`, text]));
    const mtimes = Object.fromEntries(Object.entries(s.agoMs ?? {}).map(([rel, ago]) => [`${home}/${rel}`, Date.now() - ago]));
    const mem = memoryFs({files, mtimes});
    let uuid = 0;
    stub.overrides['gi://GLib'] = {
        ...mem.GLib, getenv: () => null, get_home_dir: () => home, uuid_string_random: () => `u${++uuid}`,
    };
    stub.overrides['gi://Gio'] = mem.Gio;
    globalThis.logError = () => {};
    t.after(() => {
        stub.overrides = {};
        delete globalThis.logError;
    });
    const {storePort} = await import('../claude-usage-panel@fschmutz.github.io/lib/accounts.js');
    const {dir, port: raw} = storePort();
    const write = (rel, text) => { files[`${home}/${rel}`] = text; };
    const {port, steps} = recording(raw, home, s.post ?? (() => granted), {write});
    const core = openStoreCore(port, {dir});
    const read = name => JSON.parse(files[`${dir}/${name}.json`]);
    const result = await runAsync(port, s.run(core, read));
    s.after?.(read, result);
    return steps;
}

for (const s of SCENARIOS) {
    test(`store steps: ${s.name}`, async t => {
        const node = await onNode(s);
        const gjs = await onGjs(t, s);
        assert.deepEqual(node, s.steps, 'the Node port');
        assert.deepEqual(gjs, s.steps, 'the GJS port');
    });
}
