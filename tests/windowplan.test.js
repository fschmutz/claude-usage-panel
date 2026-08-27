// Session-window planner contract, GNOME side. The macOS twin
// (ClaudeUsageCoreTests/WindowPlannerTests) asserts the SAME fixture, so a port
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
    });
}

for (const c of fx.evaluate) {
    test(`evaluate: ${c.name}`, () => {
        const got = evaluateWindows(c.pingTimes, c.day);
        assert.equal(got.coveredMinutes, c.coveredMinutes);
        assert.equal(got.coveragePercent, c.coveragePercent);
    });
}

test('time parsing round-trips and rejects nonsense', () => {
    assert.equal(parseHHMM('05:30'), 330);
    assert.equal(formatHHMM(330), '05:30');
    assert.equal(parseHHMM('24:00'), null);
    assert.equal(parseHHMM('9:60'), null);
    assert.equal(parseHHMM('nope'), null);
});

test('an empty or garbage schedule has no coverage to report', () => {
    assert.equal(evaluateWindows([], {startMinute: 540, endMinute: 1080}), null);
    assert.equal(evaluateWindows(['nope'], {startMinute: 540, endMinute: 1080}), null);
});
