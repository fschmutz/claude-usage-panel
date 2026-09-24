import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    clampPercent, severityClass, normalizeUsage, sparkline, SPARK_SAMPLES,
    formatResets, alertThreshold, poolNote,
    forecast, formatForecast, normalizeHistory, historyPercents,
    summarizeCursorSpend, summarizeCursorToday,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

test('clampPercent clamps and rounds', () => {
    assert.equal(clampPercent(42.4), 42);
    assert.equal(clampPercent(-5), 0);
    assert.equal(clampPercent(150), 100);
    assert.equal(clampPercent('nope'), 0);
});

test('severityClass maps severities', () => {
    assert.equal(severityClass('critical'), 'cu-critical');
    assert.equal(severityClass('warning'), 'cu-warning');
    assert.equal(severityClass('normal'), 'cu-normal');
    assert.equal(severityClass(undefined), 'cu-normal');
});

test('normalizeUsage reads limits[] incl per-model, sorted', () => {
    const cards = normalizeUsage({
        limits: [
            {kind: 'weekly_scoped', percent: 100, severity: 'critical',
                resets_at: '2026-07-07T06:00:00Z', is_active: true,
                scope: {model: {display_name: 'Fable'}}},
            {kind: 'session', percent: 42, severity: 'normal', is_active: false},
            {kind: 'weekly_all', percent: 72, severity: 'normal'},
        ],
    });
    assert.deepEqual(cards.map(c => c.key),
        ['session', 'weekly_all', 'weekly_scoped:Fable']);
    const fable = cards.find(c => c.key === 'weekly_scoped:Fable');
    assert.equal(fable.label, 'Weekly · Fable');
    assert.equal(fable.percent, 100);
    assert.equal(fable.severity, 'critical');
    assert.equal(fable.active, true);
});

test('per-model limit is a weekly sub-cap: inherits the pooled reset + carries a note', () => {
    const cards = normalizeUsage({
        limits: [
            {kind: 'weekly_all', group: 'weekly', percent: 28, severity: 'normal',
                resets_at: '2026-07-28T06:00:00Z', is_active: true},
            // The API leaves the scoped reset null until Fable is used this week.
            {kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
                resets_at: null, is_active: false,
                scope: {model: {display_name: 'Fable'}}},
        ],
    });
    const fable = cards.find(c => c.key === 'weekly_scoped:Fable');
    assert.equal(fable.group, 'weekly');
    assert.equal(fable.scoped, true);
    assert.equal(fable.resetsAt, '2026-07-28T06:00:00Z');
    assert.equal(poolNote(fable), 'Share of the weekly all-models limit');
    const weekly = cards.find(c => c.key === 'weekly_all');
    assert.equal(weekly.scoped, false);
    assert.equal(poolNote(weekly), '');
});

test('a scoped limit inherits a reset only from its own pool', () => {
    const cards = normalizeUsage({
        limits: [
            {kind: 'session', group: 'session', percent: 12, severity: 'normal',
                resets_at: '2026-07-26T15:50:00Z', is_active: true},
            {kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal',
                resets_at: null, is_active: false,
                scope: {model: {display_name: 'Fable'}}},
        ],
    });
    assert.equal(cards.find(c => c.key === 'weekly_scoped:Fable').resetsAt, null);
});

test('normalizeUsage falls back to legacy fields', () => {
    const cards = normalizeUsage({
        five_hour: {utilization: 10, resets_at: 'x'},
        seven_day: {utilization: 55},
    });
    assert.equal(cards.length, 2);
    assert.equal(cards[0].key, 'session');
    assert.equal(cards[0].active, true);
    assert.equal(cards[1].percent, 55);
});

test('normalizeUsage returns [] for empty payloads', () => {
    assert.deepEqual(normalizeUsage({}), []);
    assert.deepEqual(normalizeUsage({limits: []}), []);
});

test('sparkline needs >=2 samples and maps to blocks', () => {
    assert.equal(sparkline([]), '');
    assert.equal(sparkline([50]), '');
    assert.equal(sparkline([0, 100]).length, 2);
    assert.equal(sparkline([100, 100]), '██');
    assert.equal(sparkline([0, 0]).startsWith(' '), true);
});

test('formatResets formats with injected now', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    assert.equal(formatResets('2026-07-01T03:06:00Z', now), 'Resets in 3h 06m');
    assert.equal(formatResets('2026-07-05T02:00:00Z', now), 'Resets in 4d 2h');
    assert.equal(formatResets('2026-07-01T00:00:00Z', now), 'Resetting…');
    assert.equal(formatResets(null, now), '');
    assert.equal(formatResets('not-a-date', now), '');
});

test('alertThreshold buckets 0/90/100', () => {
    assert.equal(alertThreshold(0), 0);
    assert.equal(alertThreshold(89), 0);
    assert.equal(alertThreshold(90), 90);
    assert.equal(alertThreshold(99), 90);
    assert.equal(alertThreshold(100), 100);
});

test('summarizeCursorSpend without a monthly limit → spend, no percent', () => {
    const s = summarizeCursorSpend([
        {email: 'a@x', overallSpendCents: 100000},
        {email: 'b@x', overallSpendCents: 25000},
    ]);
    assert.equal(s.cycleUSD, 1250);
    assert.equal(s.members, 2);
    assert.equal(s.percent, null);
    assert.equal(s.topSpender.email, 'a@x');
    assert.equal(s.topSpender.usd, 1000);
});

test('summarizeCursorSpend with a monthly limit → % gauge', () => {
    const s = summarizeCursorSpend([
        {email: 'a@x', overallSpendCents: 6000, monthlyLimitDollars: 100},
        {email: 'b@x', overallSpendCents: 0, monthlyLimitDollars: 100},
    ]);
    assert.equal(s.cycleUSD, 60);
    assert.equal(s.limitUSD, 200);
    assert.equal(s.percent, 30);
});

test('summarizeCursorToday sums chargedCents', () => {
    assert.equal(summarizeCursorToday([{chargedCents: 150}, {chargedCents: 89}]), 2.39);
    assert.equal(summarizeCursorToday([]), 0);
});

test('formatForecast renders the alarming and calm shapes', () => {
    // Fixed instants; formatForecast prints LOCAL weekday+time, so assert shape
    // rather than an exact clock reading.
    const bad = formatForecast({
        pctPerHour: 1.8,
        projectedFullAt: '2026-08-02T03:40:00.000Z',
        exhaustsBeforeReset: true,
        marginHours: -34.3,
    });
    assert.match(bad, /^↗ 1\.8%\/h - full ~(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}, 1d10h before reset$/);
    const fine = formatForecast({
        pctPerHour: 0.6,
        projectedFullAt: '2026-08-09T00:00:00.000Z',
        exhaustsBeforeReset: false,
        marginHours: 12,
    });
    assert.equal(fine, '↗ 0.6%/h - lasts past reset');
    const noReset = formatForecast({
        pctPerHour: 4,
        projectedFullAt: '2026-08-02T00:00:00.000Z',
        exhaustsBeforeReset: false,
        marginHours: null,
    });
    assert.equal(noReset, '↗ 4%/h');
    assert.equal(formatForecast(null), '');
});

test('formatForecast rounds the lead before splitting days: never "1d24h" or "0h"', () => {
    const at = (marginHours) => formatForecast({
        pctPerHour: 1, projectedFullAt: '2026-09-24T10:00:00.000Z',
        exhaustsBeforeReset: true, marginHours,
    });
    assert.match(at(-47.6), /, 2d0h before reset$/);
    assert.match(at(-23.6), /, 1d0h before reset$/);
    assert.match(at(-0.3), /, <1h before reset$/);
    assert.match(at(-0.1), /, <1h before reset$/);
});

test('sparkline draws only the newest SPARK_SAMPLES readings', () => {
    const long = [...Array(SPARK_SAMPLES).fill(0), 100];
    assert.equal(sparkline(long).length, SPARK_SAMPLES);
    assert.equal(sparkline(long).at(-1), '█');
});

test('formatResets reaches every branch: minutes only, exactly an hour, due', () => {
    const now = Date.parse('2026-07-01T00:00:00Z');
    assert.equal(formatResets('2026-07-01T00:00:59Z', now), 'Resets in 0m');
    assert.equal(formatResets('2026-07-01T00:59:59Z', now), 'Resets in 59m');
    assert.equal(formatResets('2026-07-01T01:00:00Z', now), 'Resets in 1h 00m');
    assert.equal(formatResets('2026-07-01T23:59:40Z', now), 'Resets in 23h 59m');
    assert.equal(formatResets('2026-07-01T00:00:00.500Z', now), 'Resetting…');
});

test('normalizeHistory migrates bare percents to [0, p] pairs', () => {
    assert.deepEqual(normalizeHistory([40, 50]), [[0, 40], [0, 50]]);
    assert.deepEqual(normalizeHistory([[1000, 42.4], [2000, 44]]), [[1000, 42], [2000, 44]]);
    assert.deepEqual(normalizeHistory('junk'), []);
    // Bare-percent entries have no timestamp, so forecast ignores them entirely.
    assert.equal(forecast(normalizeHistory([40, 44, 48, 52]), null, 1800000000000), null);
});

test('historyPercents projects pairs back to the sparkline series', () => {
    assert.deepEqual(historyPercents([[1, 40], [2, 50]]), [40, 50]);
    assert.deepEqual(historyPercents(undefined), []);
});

// ── Adaptive polling ────────────────────────────────────────────────────────────
// Same fixture the Swift PollScheduleParityTests asserts.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    nextPollSeconds, nextResetMs, sameUsage, POLL_IDLE_AFTER, POLL_RETRY_SECONDS,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const pollFix = JSON.parse(
    fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'poll.json'),
        'utf8'));

test('the idle threshold is part of the pinned contract', () => {
    assert.equal(POLL_IDLE_AFTER, pollFix.idleAfter);
    assert.equal(POLL_RETRY_SECONDS, pollFix.retrySeconds);
});

for (const c of pollFix.cases) {
    test(`nextPollSeconds - ${c.name}`, () => {
        assert.equal(
            nextPollSeconds({
                baseSeconds: c.baseSeconds, idleStreak: c.idleStreak,
                nextResetMs: c.nextResetMs, nowMs: pollFix.now, retry: c.retry ?? false,
            }),
            c.expected);
    });
}

test('the soonest reset wins, and no resets means no deadline', () => {
    assert.equal(
        nextResetMs([
            {resetsAt: '2027-01-16T14:00:00.000Z'},
            {resetsAt: '2027-01-15T06:00:00.000Z'},
            {resetsAt: null},
        ]),
        Date.parse('2027-01-15T06:00:00.000Z'));
    assert.equal(nextResetMs([{resetsAt: null}]), null);
    assert.equal(nextResetMs([]), null);
});

test('an idle poll is one where no limit moved', () => {
    const a = [{key: 'session', percent: 10}, {key: 'weekly_all', percent: 30}];
    assert.equal(sameUsage(a, [{key: 'session', percent: 10}, {key: 'weekly_all', percent: 30}]), true);
    assert.equal(sameUsage(a, [{key: 'session', percent: 11}, {key: 'weekly_all', percent: 30}]), false);
    assert.equal(sameUsage(a, [{key: 'session', percent: 10}]), false);
    assert.equal(sameUsage(null, []), true);
});

// ── Event hooks ─────────────────────────────────────────────────────────────────
// Same fixture the Swift EventHooksParityTests asserts.
import {
    detectEvents, expandEventCommand,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const eventFix = JSON.parse(
    fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'events.json'),
        'utf8'));

for (const c of eventFix.cases) {
    test(`detectEvents - ${c.name}`, () => {
        assert.deepEqual(detectEvents(c.previous, c.current), c.expected);
    });
}

for (const c of eventFix.expansions) {
    test(`expandEventCommand - ${c.name}`, () => {
        assert.equal(expandEventCommand(c.template, c.event), c.expected);
    });
}

// ── Usage warehouse ─────────────────────────────────────────────────────────────
// Same fixture the Swift WarehouseParityTests asserts.
import {
    warehouseLine, parseWarehouse, pruneWarehouse, weekOverWeek, formatWeekOverWeek,
    warehouseAccount, WAREHOUSE_KEEP_DAYS,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const houseFix = JSON.parse(
    fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'warehouse.json'),
        'utf8'));

test('the retention window is part of the pinned contract', () => {
    assert.equal(WAREHOUSE_KEEP_DAYS, houseFix.keepDays);
});

for (const c of houseFix.cases) {
    test(`weekOverWeek - ${c.name}`, () => {
        assert.deepEqual(
            weekOverWeek(houseFix.entries, c.key, houseFix.now, c.account ?? null), c.expected);
    });
}

for (const c of houseFix.accounts) {
    test(`warehouseAccount - ${c.name}`, () => {
        assert.equal(warehouseAccount(c.live), c.expected);
    });
}

for (const c of houseFix.formats) {
    test(`formatWeekOverWeek - ${c.name}`, () => {
        assert.equal(formatWeekOverWeek(c.value), c.expected);
    });
}

test('a torn or garbage line is skipped, never fatal', () => {
    const line = warehouseLine([{key: 'session', percent: 42}], houseFix.now);
    const parsed = parseWarehouse(`${line}\n{ not json\n\n`);
    assert.deepEqual(parsed, [{t: houseFix.now, limits: {session: 42}}]);
    // The account tag survives the round trip; an empty one is dropped.
    const tagged = warehouseLine([{key: 'session', percent: 1}], houseFix.now, 'u-1');
    assert.deepEqual(parseWarehouse(`${tagged}\n{"t":1,"a":"","limits":{}}`),
        [{t: houseFix.now, a: 'u-1', limits: {session: 1}}, {t: 1, limits: {}}]);
    // Older than the retention window, so it does not survive a prune.
    const old = {t: houseFix.now - 91 * 86_400_000, limits: {session: 1}};
    assert.deepEqual(pruneWarehouse([...parsed, old], houseFix.now), parsed);
});

// ── Named accounts - the GNOME-only helpers ─────────────────────────────────────
// The shared contract (profiles, active login, token state, auto-switch) is
// asserted for BOTH JS ports in parity.test.js against tests/fixtures/accounts.json;
// here only what has no twin: the row colouring and the row usage text.
import {
    formatAccountUsage, rowError, thresholdClass, usageSeverity, warehouseEntry,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

test('accounts: rowError drops the profile-name prefix the row already shows', () => {
    assert.equal(rowError('PRO', 'PRO: token refresh rejected (HTTP 400) - log in again and save it'),
        'token refresh rejected (HTTP 400) - log in again and save it');
    assert.equal(rowError('PRO', 'HTTP 424'), 'HTTP 424');
    assert.equal(rowError('PRO', 'PROD: nope'), 'PROD: nope');
    assert.equal(rowError('PRO', null), '');
});

test('accounts: usageSeverity colours by the 70 / 90 thresholds', () => {
    assert.equal(usageSeverity(null), 'normal');
    assert.equal(usageSeverity(69), 'normal');
    assert.equal(usageSeverity(70), 'warning');
    assert.equal(usageSeverity(90), 'critical');
});

test('accounts: formatAccountUsage reads the session and weekly-all cards only', () => {
    assert.equal(formatAccountUsage([
        {key: 'session', percent: 42}, {key: 'weekly_all', percent: 12.4},
        {key: 'weekly_scoped:Fable', percent: 99},
    ]), 'S 42% · W 12%');
    assert.equal(formatAccountUsage([{key: 'weekly_all', percent: 140}]), 'W 100%');
    assert.equal(formatAccountUsage([]), '');
    assert.equal(formatAccountUsage(null), '');
});

test('thresholdClass colours a bare percent by the alert buckets', () => {
    assert.equal(thresholdClass(0), 'cu-normal');
    assert.equal(thresholdClass(89), 'cu-normal');
    assert.equal(thresholdClass(90), 'cu-warning');
    assert.equal(thresholdClass(100), 'cu-critical');
});

test('warehouseEntry is the object warehouseLine serializes', () => {
    const cards = [{key: 'session', percent: 42.4}, {key: 'weekly_all', percent: 140}];
    assert.deepEqual(warehouseEntry(cards, 1000.6), {t: 1001, limits: {session: 42, weekly_all: 100}});
    assert.equal(warehouseLine(cards, 1000.6), JSON.stringify(warehouseEntry(cards, 1000.6)));
    // Filed under the login when one is known - `a` sits before the limits on the line.
    assert.equal(warehouseLine(cards, 1000.6, 'u-1'),
        '{"t":1001,"a":"u-1","limits":{"session":42,"weekly_all":100}}');
});
