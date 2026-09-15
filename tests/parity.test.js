// Cross-port parity. Every contract lives in hand-written copies - lib/pure.js
// (GNOME, GJS), the Node modules under claude-code/ (the MCP server, the status
// line, the CLI all import those), and ClaudeUsageCore (macOS, Swift) - and
// every copy is asserted against ONE shared fixture per contract; the Swift
// twins assert the same files in ClaudeUsageCoreTests. If a port drifts on the
// semantic core, this test and its Swift twin go red.
//
// The Node side has exactly one copy of each contract: normalize.js, pace.js,
// stamps.js (sessions.test.js), accounts-contract.js. The status line and the
// MCP server import them; they are not ports of their own.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import * as normalize from '../claude-code/normalize.js';
import * as pace from '../claude-code/pace.js';
import * as accounts from '../claude-code/accounts-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

// ── Normalization ───────────────────────────────────────────────────────────────
// Project a port's card onto the presentation-agnostic core the fixture pins.
// `key` is "kind:model"; labels are port-specific and not compared.
const core = (c) => ({
    kind: c.key.split(':')[0],
    group: c.group,
    scoped: c.scoped,
    percent: c.percent,
    severity: c.severity,
    resetsAt: c.resetsAt ?? null,
    active: c.active,
});

for (const [portName, fn] of [['pure.js', pure.normalizeUsage], ['normalize.js', normalize.normalizeUsage]]) {
    for (const {name, input, expected} of fixture('normalize.json').cases) {
        test(`${portName} normalize - ${name}`, () => {
            assert.deepEqual(fn(input).map(core), expected);
        });
    }
}

// ── Burn-rate forecast ──────────────────────────────────────────────────────────
// One fixture pins the numbers: pace, projected-full instant, and the
// exhausts-before-reset call.
const forecastFix = fixture('forecast.json');
for (const [portName, fn] of [['pure.js', pure.forecast], ['pace.js', pace.forecast]]) {
    for (const c of forecastFix.cases) {
        test(`${portName} forecast - ${c.name}`, () => {
            assert.deepEqual(fn(c.samples, c.resetsAt, forecastFix.now), c.expected);
        });
    }
}

// ── Clock pace ──────────────────────────────────────────────────────────────────
// used-vs-elapsed. Window lengths are a contract, not a payload field: the
// endpoint dates the reset and never the window's start.
const paceFix = fixture('pace.json');

test('the tolerance itself is part of the pinned contract', () => {
    assert.equal(pure.PACE_TOLERANCE, paceFix.tolerance);
    assert.equal(pace.PACE_TOLERANCE, paceFix.tolerance);
});

for (const [portName, fn] of [['pure.js', pure.clockPace], ['pace.js', pace.clockPace]]) {
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
const extraFix = fixture('extra-usage.json');

// The key/label are port-facing; the fixture pins the numbers and the sentence.
const extraCore = (e) => e && {
    percent: e.percent, severity: e.severity, usedAmount: e.usedAmount,
    limitAmount: e.limitAmount ?? null, currency: e.currency, detail: e.detail,
};

for (const [portName, extra, label] of [
    ['pure.js', pure.normalizeExtraUsage, pure.kindLabel],
    ['normalize.js', normalize.normalizeExtraUsage, normalize.kindLabel],
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

// ── Named accounts ──────────────────────────────────────────────────────────────
// What a valid profile is, which saved login is the live one, whether a stored
// token is still usable, and when to move to another account.
const accountsFix = fixture('accounts.json');

for (const [portName, port] of [['pure.js', pure], ['accounts-contract.js', accounts]]) {
    test(`${portName} accounts - constants`, () => {
        assert.equal(port.REFRESH_LEAD_MS, accountsFix.refreshLeadMs);
        assert.equal(port.AUTO_SWITCH.threshold, accountsFix.threshold);
        assert.equal(port.AUTO_SWITCH.margin, accountsFix.margin);
        assert.equal(port.AUTO_SWITCH.cooldownMs, accountsFix.cooldownMs);
    });
    test(`${portName} accounts - profile validity and names`, () => {
        for (const raw of accountsFix.profiles) {
            const p = port.parseProfile(raw);
            assert.ok(p, raw.name);
            assert.equal(p.name, raw.name);
            assert.deepEqual(p.credentials, raw.credentials);
        }
        for (const raw of accountsFix.invalidProfiles)
            assert.equal(port.parseProfile(raw), null, JSON.stringify(raw));
        for (const n of accountsFix.validNames) assert.ok(port.isValidName(n), n);
        for (const n of accountsFix.invalidNames) assert.ok(!port.isValidName(n), n);
    });
    const profiles = accountsFix.profiles.map(port.parseProfile);
    test(`${portName} accounts - summaries and token state`, () => {
        assert.deepEqual(profiles.map(p => port.accountSummary(p, accountsFix.now)), accountsFix.summaries);
        for (const s of accountsFix.summaries) {
            assert.equal(port.tokenState(profiles.find((p) => p.name === s.name), accountsFix.now),
                s.tokenState, s.name);
        }
    });
    for (const c of accountsFix.active) {
        test(`${portName} accounts - active: ${c.name}`, () => {
            assert.equal(port.activeAccountName(profiles, c.live), c.expected);
        });
    }
    for (const c of accountsFix.autoSwitch) {
        test(`${portName} accounts - auto-switch: ${c.name}`, () => {
            assert.deepEqual(port.autoSwitchTarget({
                active: c.active, worst: c.worst, lastSwitchMs: c.lastSwitchMs,
                nowMs: accountsFix.now, threshold: accountsFix.threshold,
                margin: accountsFix.margin, cooldownMs: accountsFix.cooldownMs,
            }), c.expected);
        });
    }
}

// ── Top-bar readout ─────────────────────────────────────────────────────────────
// The bar's character budget. Only pure.js renders it today (the status line
// has a terminal's width); the Swift twin is PanelTextParityTests.
const panelFix = fixture('panel.json');
test('pure.js panelText - budget is the fixture\'s', () => {
    assert.equal(pure.PANEL_MAX_CHARS, panelFix.maxChars);
});
for (const c of panelFix.cases) {
    test(`pure.js panelText - ${c.name}`, () => {
        assert.equal(pure.panelText({
            account: c.account, label: c.label, percent: c.percent, max: panelFix.maxChars,
        }), c.expected);
    });
}
