// Session-window planner contract, GNOME side. The macOS twin
// (ClaudeUsageCoreTests/WindowPlanParityTests) asserts the SAME fixture, so a port
// that drifts turns this file - or its Swift twin - red.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    planWindows,
    evaluateWindows,
    parseHHMM,
    formatHHMM,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'window-plan.json'), 'utf8'));

for (const c of fx.plan) {
    test(`plan: ${c.name}`, () => {
        const got = planWindows(c.day, c.count);
        assert.deepEqual(got.pingTimes, c.pingTimes);
        assert.equal(got.coveredMinutes, c.coveredMinutes);
        assert.equal(got.coveragePercent, c.coveragePercent);
        assert.deepEqual(got.workDay, c.workDay);
        assert.equal(got.summary, c.summary);
    });
}

for (const c of fx.evaluate) {
    test(`evaluate: ${c.name}`, () => {
        const got = evaluateWindows(c.pingTimes, c.day);
        if (c.none) {
            assert.equal(got, null);
            return;
        }
        assert.deepEqual(got.pingTimes, c.pingTimes);
        assert.equal(got.coveredMinutes, c.coveredMinutes);
        assert.equal(got.coveragePercent, c.coveragePercent);
        assert.deepEqual(got.workDay, c.workDay);
        assert.equal(got.summary, c.summary);
    });
}

test('parse: time strings match the shared fixture', () => {
    for (const [text, want] of fx.parse.cases)
        assert.equal(parseHHMM(text), want, JSON.stringify(text));
});

test('time formatting round-trips and wraps', () => {
    assert.equal(formatHHMM(330), '05:30');
    assert.equal(formatHHMM(1440 + 330), '05:30');
    assert.equal(formatHHMM(-30), '23:30');
});

test('an unusable day object plans against 09:00-18:00, never a negative coverage', () => {
    for (const day of [undefined, {}, {startMinute: 1.5, endMinute: 600}, {startMinute: -60, endMinute: 600},
        {startMinute: 540, endMinute: 1500}]) {
        const got = planWindows(day, 2);
        assert.deepEqual(got.workDay, {startMinute: 540, endMinute: 1080}, JSON.stringify(day));
        assert.ok(got.coveredMinutes >= 0);
    }
});
