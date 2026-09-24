// lib/pure/poll.js: the section refresh that runs after every poll, failed
// or not, each section bounded by its deadline. GNOME only, no fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    refreshSections, sectionCards, SECTION_DEADLINE_MS,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

// ── The sections a poll refreshes ───────────────────────────────────────────

const CARDS = [{key: 'session', percent: 40}];
const LATEST = [{key: 'session', percent: 38}];

test('sectionCards: fresh cards, the last reading on a retry, else none', () => {
    assert.deepEqual(sectionCards({ok: true, cards: CARDS}, LATEST), CARDS);
    assert.deepEqual(sectionCards({ok: false, code: 'transient'}, LATEST), LATEST);
    assert.deepEqual(sectionCards({ok: false, code: 'transient'}, []), []);
    assert.deepEqual(sectionCards({ok: false, code: 'auth_expired'}, LATEST), []);
    assert.deepEqual(sectionCards({ok: false, code: 'no_token'}, LATEST), []);
});

function spySections(extra = {}) {
    const calls = [];
    const sections = {};
    for (const name of ['cost', 'sessions', 'cursor', 'accounts'])
        sections[name] = cards => { calls.push([name, cards]); };
    return {calls, sections: {...sections, ...extra}};
}

test('a failed poll still refreshes every section, the accounts with no live cards', async () => {
    for (const code of ['auth_expired', 'no_token', 'network_error']) {
        const {calls, sections} = spySections();
        const out = await refreshSections(sections, {result: {ok: false, code}, latest: LATEST});
        assert.deepEqual(calls.map(([n]) => n).sort(), ['accounts', 'cost', 'cursor', 'sessions'], code);
        assert.deepEqual(calls.find(([n]) => n === 'accounts')[1], [], code);
        assert.ok(out.every(o => o.outcome === 'done'), code);
    }
});

test('a good poll hands the accounts section the fresh cards', async () => {
    const {calls, sections} = spySections();
    await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: LATEST});
    assert.equal(calls.find(([n]) => n === 'accounts')[1], CARDS);
});

test('a section that never settles is cut off at the deadline, the others finish', async () => {
    const {calls, sections} = spySections({cost: () => new Promise(() => {})});
    const out = await refreshSections(sections, {
        result: {ok: true, cards: CARDS}, latest: [], deadlineMs: 20,
    });
    assert.deepEqual(Object.fromEntries(out.map(o => [o.section, o.outcome])),
        {cost: 'timeout', sessions: 'done', cursor: 'done', accounts: 'done'});
    assert.equal(calls.length, 3);
});

test('a section that throws is reported, never rejected', async () => {
    const boom = new Error('boom');
    const {sections} = spySections({
        cursor: () => { throw boom; },
        accounts: async () => { throw boom; },
    });
    const out = await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: []});
    const byName = Object.fromEntries(out.map(o => [o.section, o]));
    assert.equal(byName.cursor.outcome, 'failed');
    assert.equal(byName.cursor.error, boom);
    assert.equal(byName.accounts.outcome, 'failed');
});

test('every deadline timer is cleared once its section settles', async () => {
    const live = new Set();
    let id = 0;
    const timers = {
        setTimeout: () => { live.add(++id); return id; },
        clearTimeout: t => live.delete(t),
    };
    const {sections} = spySections();
    await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: [], timers});
    assert.equal(id, 4);
    assert.equal(live.size, 0);
    assert.ok(SECTION_DEADLINE_MS >= 30_000, 'a real section gets a real chance');
});
