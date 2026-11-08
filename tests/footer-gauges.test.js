// The footer's gauges against the contract every port answers to: the same
// fixtures (reading.json, gauge.json) the GNOME, macOS and Node clients are
// held to, run through footer/hooks/gauges.js - the module the footer's hooks
// draw with - so the footer cannot keep thresholds or a percent of its own.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    accountFromConfig, addSample, gauge, latchFromStore, limitCard, mergeSamples, sampleKey,
    SAMPLE_MAX, SAMPLE_TTL_MS,
} from '../footer/hooks/gauges.js';
import {GAUGE_COLORS, usageReading} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

const readingFix = fixture('reading.json');
const readingNow = Date.parse(readingFix.now);
for (const c of readingFix.cases) {
    test(`footer gauge reads like usageReading - ${c.name}`, () => {
        const g = gauge({key: 'seven_day', severity: 'normal', ...c.card}, [], readingNow);
        const {known, percent, fill, text, reason} = g;
        assert.deepEqual({known, percent, fill, text, reason}, c.expected);
        if (!c.expected.known) {
            assert.equal(g.fraction, 0, 'no reading is an empty bar');
            assert.equal(g.tone, 'normal', 'and no tone of its own');
            assert.equal(g.runningDry, false, 'and no forecast');
        }
    });
}

// A card whose reading is the fixture's, and samples whose forecast runs dry
// before the reset exactly when the fixture says it does.
const gaugeFix = fixture('gauge.json');
const NOW = Date.parse('2026-07-20T12:00:00Z');
const resetsAt = new Date(NOW + 48 * 3600_000).toISOString();
function cardFor(c) {
    return c.reading.known
        ? {key: 'seven_day', percent: c.reading.percent, percentKnown: true, severity: c.severity, resetsAt}
        : {key: 'seven_day', percent: 96, percentKnown: false, severity: c.severity, resetsAt};
}
function samplesFor(c) {
    if (!c.exhaustsBeforeReset) return [];
    const p = c.reading.known ? c.reading.percent : 96;
    // 20 points an hour: dry long before a reset 48 h away.
    return [[NOW - 2 * 3600_000, Math.max(0, p - 40)], [NOW - 3600_000, Math.max(0, p - 20)], [NOW, p]];
}

test('footer gauge colors are the fixture\'s', () => {
    assert.deepEqual(GAUGE_COLORS, gaugeFix.colors);
});
for (const c of gaugeFix.cases) {
    test(`footer gauge tone and fill - ${c.name}`, () => {
        const g = gauge(cardFor(c), samplesFor(c), NOW);
        assert.deepEqual({fraction: g.fraction, tone: g.tone}, c.expected);
        assert.equal(g.color, gaugeFix.colors[c.expected.tone]);
    });
}

test('a limit is a card read by JSON type; severity is the limit\'s, else usageSeverity\'s', () => {
    assert.deepEqual(limitCard({kind: 'seven_day', percentUsed: 41.5, resetsAt: 'x'}),
        {key: 'seven_day', percent: 42, percentKnown: true, severity: 'normal', resetsAt: 'x'});
    for (const junk of [null, undefined, '50', NaN, Infinity]) {
        const card = limitCard({kind: 'five_hour', percentUsed: junk});
        assert.equal(card.percentKnown, false, String(junk));
        assert.equal(usageReading(card, NOW).text, readingFix.noReading);
    }
    assert.equal(limitCard({kind: 'k', percentUsed: 69}).severity, 'normal');
    assert.equal(limitCard({kind: 'k', percentUsed: 70}).severity, 'warning');
    assert.equal(limitCard({kind: 'k', percentUsed: 90}).severity, 'critical');
    assert.equal(limitCard({kind: 'k', percentUsed: 20, severity: 'critical'}).severity, 'critical');
    assert.equal(limitCard({kind: 'k', percentUsed: 95, severity: 'bogus'}).severity, 'critical');
});

test('samples are keyed <account>|<kind>, and the login is read from ~/.claude.json', () => {
    assert.equal(sampleKey('u1/o1', 'seven_day'), 'u1/o1|seven_day');
    assert.equal(sampleKey(null, 'seven_day'), '|seven_day');
    const cfg = JSON.stringify({oauthAccount: {accountUuid: 'u1', organizationUuid: 'o1', emailAddress: 'a@b'}});
    assert.equal(accountFromConfig(cfg), 'u1/o1');
    assert.equal(accountFromConfig('{"oauthAccount": {"emailAddress": "a@b"}}'), 'a@b');
    assert.equal(accountFromConfig('not json'), null);
    assert.equal(accountFromConfig('{}'), null);
});

test('samples merge on write: another session\'s are kept, junk and old ones dropped', () => {
    const now = NOW;
    const stored = {
        'A|seven_day': [[now - 3600_000, 10], [now - 1800_000, 12]],
        'B|seven_day': [[now - 600_000, 50]],
        'A|five_hour': [[now - SAMPLE_TTL_MS - 1, 5], ['x', 'y'], 'junk'],
    };
    const mine = {'A|seven_day': [[now - 1800_000, 12], [now, 14]]};
    assert.deepEqual(mergeSamples(stored, mine, now), {
        'A|seven_day': [[now - 3600_000, 10], [now - 1800_000, 12], [now, 14]],
        'B|seven_day': [[now - 600_000, 50]],
    });
    assert.deepEqual(mergeSamples('not an object', {}, now), {});
    const long = Array.from({length: SAMPLE_MAX + 10}, (_, i) => [now - i * 1000, 1]);
    assert.equal(mergeSamples({k: long}, {}, now).k.length, SAMPLE_MAX);
});

test('a sample is taken on a change, or after five minutes of the same value', () => {
    const now = NOW;
    assert.deepEqual(addSample([], 10, now), [[now, 10]]);
    assert.deepEqual(addSample([[now - 60_000, 10]], 10, now), [[now - 60_000, 10]]);
    assert.deepEqual(addSample([[now - 60_000, 10]], 11, now), [[now - 60_000, 10], [now, 11]]);
    assert.equal(addSample([[now - 6 * 60_000, 10]], 10, now).length, 2);
});

test('the toast latch comes back from $.store as latchCrossings\' Map, junk dropped', () => {
    assert.deepEqual([...latchFromStore({'|seven_day': 90, bad: 'x', nan: null})], [['|seven_day', 90]]);
    assert.equal(latchFromStore(undefined).size, 0);
    assert.equal(latchFromStore([90, 100]).size, 0, 'an array is not a latch');
});
