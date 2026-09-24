// The Node forecast history: one tmp file the status line and the MCP server
// both append to. It sits in a shared tmp dir, so it has to survive whatever
// else wrote it, and it has to keep two logins' quota pools apart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {forecastMap, recordHistory, sanitizeHistory, withPace} from '../claude-code/pace.js';

const tmpHistory = (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-pace-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return path.join(dir, 'claude-usage-history.json');
};

const NOW = 1800000000000;
const HOUR = 3600_000;
const card = (percent, key = 'session') => ({
    key, group: 'session', percent, resetsAt: new Date(NOW + 4 * HOUR).toISOString(),
});

test('a foreign entry in the history file costs its sample, never the forecast', (t) => {
    const p = tmpHistory(t);
    for (const bad of [[5], null, 'x', [1, 2, 3], [NaN, 4], {t: 1}]) {
        fs.writeFileSync(p, JSON.stringify({session: [[NOW - HOUR, 40], bad, [NOW - HOUR / 2, 45]]}));
        const fc = forecastMap([card(50)], {nowMs: NOW, historyPath: p});
        assert.ok(fc.get('session'), `forecast survives ${JSON.stringify(bad)}`);
        // The bad entry is not written back: the next reader sees clean pairs.
        const saved = JSON.parse(fs.readFileSync(p, 'utf8')).session;
        assert.deepEqual(saved, [[NOW - HOUR, 40], [NOW - HOUR / 2, 45], [NOW, 50]]);
    }
});

test('a history file that is not a plain object starts a fresh history', (t) => {
    const p = tmpHistory(t);
    for (const bad of ['[1,2]', '42', '"x"', 'null', '{"session": 5}']) {
        fs.writeFileSync(p, bad);
        const hist = recordHistory([card(10)], {nowMs: NOW, historyPath: p});
        assert.deepEqual(hist.session, [[NOW, 10]], bad);
        // An array top level used to swallow every new sample (JSON.stringify
        // drops keys set on an array), so the forecast stayed dead for good.
        assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {session: [[NOW, 10]]}, bad);
    }
});

test('sanitizeHistory keeps only [finite t, finite p] pairs of a plain object', () => {
    assert.deepEqual(sanitizeHistory([[1, 2]]), {});
    assert.deepEqual(sanitizeHistory(null), {});
    assert.deepEqual({...sanitizeHistory({a: [[1, 2], [3]], b: 'x', c: [null]})}, {a: [[1, 2]]});
    const proto = sanitizeHistory(JSON.parse('{"__proto__": [[1, 2]]}'));
    assert.equal(Object.getPrototypeOf(proto), null);
    assert.deepEqual(proto.__proto__, [[1, 2]]);
});

test('a switch to another account never regresses across both pools', (t) => {
    const p = tmpHistory(t);
    // PERSO climbs 10 -> 12 % over 40 min...
    for (const [i, pct] of [10, 11, 12].entries())
        recordHistory([card(pct)], {nowMs: NOW - (40 - 20 * i) * 60_000, historyPath: p, account: 'perso-uuid'});
    // ...then the login switches to PRO, flat at 60 %.
    const [pro] = withPace([card(60)], {nowMs: NOW + 60_000, historyPath: p, account: 'pro-uuid'});
    assert.equal(pro.pace, undefined, 'one PRO sample is no pace, and PERSO\'s samples are not PRO\'s');
    // Without the account the same sequence reads as a 40-point burn.
    const q = tmpHistory(t);
    for (const [i, pct] of [10, 11, 12].entries())
        recordHistory([card(pct)], {nowMs: NOW - (40 - 20 * i) * 60_000, historyPath: q});
    const [mixed] = withPace([card(60)], {nowMs: NOW + 60_000, historyPath: q});
    assert.equal(mixed.pace?.exhaustsBeforeReset, true);
});

test('each account keeps densifying its own series in the shared file', (t) => {
    const p = tmpHistory(t);
    recordHistory([card(10)], {nowMs: 1, historyPath: p, account: 'a'});
    recordHistory([card(70)], {nowMs: 2, historyPath: p, account: 'b'});
    const hist = recordHistory([card(11)], {nowMs: 3, historyPath: p, account: 'a'});
    assert.deepEqual(hist.session, [[1, 10], [3, 11]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')),
        {'a|session': [[1, 10], [3, 11]], 'b|session': [[2, 70]]});
});
