// Cross-port parity: the OAuth-usage normalization contract lives in three
// hand-written copies - lib/pure.js (GNOME), ClaudeUsageCore/Model.swift
// (macOS), and mcp/server.js (MCP). All are asserted against ONE shared fixture
// set: tests/fixtures/normalize.json (the Swift port asserts the same file in
// ClaudeUsageCoreTests). If any port drifts on the semantic core (kinds, order,
// percent, severity, reset, active), this test - and its Swift twin - go red.
//
// The Claude Code status line is intentionally NOT a party to this contract: it
// renders purely from Claude Code's stdin and never normalizes an OAuth payload,
// so it has no normalizeUsage to keep in sync.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {normalizeUsage as normalizePure} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {normalizeUsage as normalizeMcp} from '../mcp/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const {cases} = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'normalize.json'), 'utf8'));

// Project a port's card onto the presentation-agnostic core the fixture pins.
// `key` is pure.js's "kind:model"; labels are port-specific and not compared.
const core = (c) => ({
    kind: c.key.split(':')[0],
    group: c.group,
    scoped: c.scoped,
    percent: c.percent,
    severity: c.severity,
    resetsAt: c.resetsAt ?? null,
    active: c.active,
});

for (const {name, input, expected} of cases) {
    test(`pure.js normalize - ${name}`, () => {
        assert.deepEqual(normalizePure(input).map(core), expected);
    });
    test(`mcp/server.js normalize - ${name}`, () => {
        assert.deepEqual(normalizeMcp(input).map(core), expected);
    });
}

// ── Burn-rate forecast parity ───────────────────────────────────────────────────
// The forecast lives in three JS copies (pure.js, statusline.js, mcp/server.js)
// plus Swift (ForecastParityTests asserts the same fixture). One fixture pins
// the numbers: pace, projected-full instant, and the exhausts-before-reset call.
import {forecast as forecastPure} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {forecast as forecastStatusline} from '../claude-code/statusline.js';
import {forecast as forecastMcp} from '../mcp/server.js';

const forecastFix = JSON.parse(
    fs.readFileSync(path.join(here, 'fixtures', 'forecast.json'), 'utf8'));

for (const [portName, fn] of [
    ['pure.js', forecastPure],
    ['statusline.js', forecastStatusline],
    ['mcp/server.js', forecastMcp],
]) {
    for (const c of forecastFix.cases) {
        test(`${portName} forecast - ${c.name}`, () => {
            assert.deepEqual(fn(c.samples, c.resetsAt, forecastFix.now), c.expected);
        });
    }
}

// ── Clock-pace parity ───────────────────────────────────────────────────────────
// used-vs-elapsed, pinned across the three JS copies (Swift asserts the same
// file in ClockPaceParityTests). Window lengths are a contract, not a payload
// field: the endpoint dates the reset and never the window's start.
import {clockPace as pacePure, PACE_TOLERANCE} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {clockPace as paceStatusline} from '../claude-code/statusline.js';
import {clockPace as paceMcp} from '../mcp/server.js';

const paceFix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pace.json'), 'utf8'));

test('the tolerance itself is part of the pinned contract', () => {
    assert.equal(PACE_TOLERANCE, paceFix.tolerance);
});

for (const [portName, fn] of [
    ['pure.js', pacePure],
    ['statusline.js', paceStatusline],
    ['mcp/server.js', paceMcp],
]) {
    for (const c of paceFix.cases) {
        test(`${portName} clockPace - ${c.name}`, () => {
            assert.deepEqual(fn(c.card, paceFix.now), c.expected);
        });
    }
}

// ── Extra usage + unknown-kind labels ───────────────────────────────────────────
// `spend` is prepaid credit, not a limit: no window, no reset, and only real
// while the account has it enabled. Labels for kinds we do not know yet are
// part of the same fixture - the endpoint already carries placeholders for
// kinds nobody has enabled (seven_day_cowork and friends).
import {
    normalizeExtraUsage as extraPure, kindLabel as labelPure,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {
    normalizeExtraUsage as extraMcp, kindLabel as labelMcp,
} from '../mcp/server.js';

const extraFix = JSON.parse(
    fs.readFileSync(path.join(here, 'fixtures', 'extra-usage.json'), 'utf8'));

// The key/label are port-facing; the fixture pins the numbers and the sentence.
const extraCore = (e) => e && {
    percent: e.percent, severity: e.severity, usedAmount: e.usedAmount,
    limitAmount: e.limitAmount ?? null, currency: e.currency, detail: e.detail,
};

for (const [portName, extra, label] of [
    ['pure.js', extraPure, labelPure],
    ['mcp/server.js', extraMcp, labelMcp],
]) {
    for (const c of extraFix.cases) {
        test(`${portName} extra usage - ${c.name}`, () => {
            assert.deepEqual(extraCore(extra(c.payload)), c.expected);
        });
    }
    test(`${portName} labels unknown kinds`, () => {
        for (const l of extraFix.labels)
            assert.equal(label(l.kind), l.expected, l.kind);
    });
}
