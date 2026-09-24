// claude-code/login-usage.js: which login's usage, and how its failure is
// labelled. The get_usage end of it (a real store over a sandbox HOME) is
// pinned in mcp.test.js; these pin the rule itself against a fake store.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {liveLoginUsage, usageForLogin, usageLabel} from '../claude-code/login-usage.js';

// A store that records every call: accessTokenFor answers `access` (or throws
// it when it is an Error), fetchUsageWith echoes what it was given.
function fakeStore({live = 'PRO', access = {token: 't', source: 'live'}} = {}) {
    const calls = [];
    return {
        calls,
        liveAccountName: () => {
            calls.push('liveAccountName');
            return live;
        },
        accessTokenFor: async (name) => {
            calls.push(`accessTokenFor:${name}`);
            if (access instanceof Error) throw access;
            return access;
        },
        fetchUsageWith: async (token, opts) => {
            calls.push('fetchUsageWith');
            return {ok: false, code: 'auth_expired', token, label: opts.label};
        },
        fetchLiveUsage: async () => {
            calls.push('fetchLiveUsage');
            return {ok: true, cards: []};
        },
    };
}

test('usageLabel: only a live token drops the profile name', () => {
    assert.equal(usageLabel('PRO', 'live'), null);
    assert.equal(usageLabel('PRO', 'store'), 'PRO');
    assert.equal(usageLabel('PRO', 'refreshed'), 'PRO');
});

test('usageForLogin labels by token source and names the row', async () => {
    for (const [source, label] of [['live', null], ['store', 'PRO'], ['refreshed', 'PRO']]) {
        const r = await usageForLogin(fakeStore({access: {token: `t-${source}`, source}}), 'PRO');
        assert.deepEqual(r, {name: 'PRO', ok: false, code: 'auth_expired', token: `t-${source}`, label});
    }
});

test('usageForLogin turns a token it cannot get into no_token, never a throw', async () => {
    const store = fakeStore({access: new Error('PRO: login expired')});
    assert.deepEqual(await usageForLogin(store, 'PRO'),
        {name: 'PRO', ok: false, code: 'no_token', message: 'PRO: login expired'});
    assert.ok(!store.calls.includes('fetchUsageWith'));
});

test('liveLoginUsage resolves the live login once, and falls back to the live token', async () => {
    const saved = fakeStore();
    assert.equal((await liveLoginUsage(saved)).label, null);
    assert.deepEqual(saved.calls, ['liveAccountName', 'accessTokenFor:PRO', 'fetchUsageWith']);

    const unsaved = fakeStore({live: null});
    assert.deepEqual(await liveLoginUsage(unsaved), {ok: true, cards: []});
    assert.deepEqual(unsaved.calls, ['liveAccountName', 'fetchLiveUsage']);
});
