// lib/pure/events.js: the two notification latches, pinned with Swift
// (AlertLatchTests) by tests/fixtures/alerts.json.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {URL} from 'node:url';

import {
    ALERT_REARM_BELOW, latchCrossings, latchPaceAlerts,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/alerts.json', import.meta.url), 'utf8'));

// ── The notification latches ────────────────────────────────────────────────

test('the threshold latch matches the shared fixture', () => {
    for (const c of fixture.thresholds) {
        const fired = new Map();
        c.polls.forEach((cards, i) => {
            const got = latchCrossings(fired, cards).map(({card, threshold}) => ({key: card.key, threshold}));
            assert.deepEqual(got, c.expected[i], `${c.name}, poll ${i}`);
        });
    }
});

test('the threshold latch re-arms at the same line as Swift AlertLatch.rearmBelow', () => {
    const swift = fs.readFileSync(
        new URL('../macos/Sources/ClaudeUsageCore/EventHooks.swift', import.meta.url), 'utf8');
    assert.equal(Number(/static let rearmBelow = (\d+)/.exec(swift)?.[1]), ALERT_REARM_BELOW);
});

test('the pace latch matches the shared fixture', () => {
    for (const c of fixture.pace) {
        const alerted = new Set();
        c.polls.forEach((poll, i) => {
            const cards = poll.cards.map(key => ({key, label: key, percent: 50}));
            const forecasts = new Map(Object.entries(poll.forecasts));
            const got = latchPaceAlerts(alerted, cards, forecasts).map(({card}) => card.key);
            assert.deepEqual(got, c.expected[i], `${c.name}, poll ${i}`);
        });
    }
});

test('a pace alert carries the forecast it fired on', () => {
    const fc = {exhaustsBeforeReset: true, marginHours: -2, pctPerHour: 9};
    const [hit] = latchPaceAlerts(new Set(), [{key: 'session'}], new Map([['session', fc]]));
    assert.equal(hit.forecast, fc);
});
