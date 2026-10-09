// Cross-port parity. Every contract has ONE JavaScript copy - lib/pure/ -
// which the GNOME extension, the status line, the MCP server and the CLI all
// import, and one Swift copy in ClaudeUsageCore (macOS). The JS copy is
// asserted here against ONE shared fixture per contract; the Swift twins
// assert the same files in ClaudeUsageCoreTests. If the ports drift on the
// semantic core, this test or its Swift twin goes red.
//
// Labels are per port: the reset countdown below pins both the panel's
// "Resets in 3h 06m" and the terminal clients' compact "3h06m"
// (claude-code/stamps.js resetHint, rendered from the same resetParts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {resetHint} from '../claude-code/stamps.js';

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

for (const {name, input, expected} of fixture('normalize.json').cases) {
    test(`normalize - ${name}`, () => {
        assert.deepEqual(pure.normalizeUsage(input).map(core), expected);
    });
}

// ── Burn-rate forecast ──────────────────────────────────────────────────────────
// One fixture pins the numbers: pace, projected-full instant, and the
// exhausts-before-reset call.
const forecastFix = fixture('forecast.json');
for (const c of forecastFix.cases) {
    test(`forecast - ${c.name}`, () => {
        assert.deepEqual(pure.forecast(c.samples, c.resetsAt, forecastFix.now), c.expected);
    });
}

// The lead the alarming sub-line prints ("1d10h before reset"). Only the
// panels render it (GNOME here, Swift ForecastParityTests.testLeads).
for (const {marginHours, lead} of forecastFix.leads) {
    test(`pure.js forecastLead - ${marginHours} h reads ${lead}`, () => {
        assert.equal(pure.forecastLead(marginHours), lead);
    });
}

// ── Reset countdown ─────────────────────────────────────────────────────────────
// Every client prints it next to the same limit, so every client must split it
// the same way: whole seconds floored, two most significant units. Labels are
// per port - `panel` for GNOME (and Swift ResetCountdown), `compact` for the
// status line / MCP - and both are pinned so neither can round on its own.
const resetsFix = fixture('resets.json');
const resetsNow = Date.parse(resetsFix.now);
for (const c of resetsFix.cases) {
    test(`reset countdown - ${c.name}`, () => {
        assert.equal(pure.formatResets(c.resetsAt, resetsNow), c.panel, 'pure.js formatResets');
        assert.equal(resetHint(c.resetsAt, resetsNow), c.compact, 'stamps.js resetHint');
    });
}

// ── Sparkline ───────────────────────────────────────────────────────────────────
const sparkFix = fixture('sparkline.json');
test('pure.js sparkline - sample count is the fixture\'s', () => {
    assert.equal(pure.SPARK_SAMPLES, sparkFix.samples);
});
for (const c of sparkFix.cases) {
    test(`pure.js sparkline - ${c.name}`, () => {
        assert.equal(pure.sparkline(c.percents), c.expected);
    });
}

// ── Clock pace ──────────────────────────────────────────────────────────────────
// used-vs-elapsed. Window lengths are a contract, not a payload field: the
// endpoint dates the reset and never the window's start.
const paceFix = fixture('pace.json');

test('the tolerance itself is part of the pinned contract', () => {
    assert.equal(pure.PACE_TOLERANCE, paceFix.tolerance);
});

for (const c of paceFix.cases) {
    test(`clockPace - ${c.name}`, () => {
        assert.deepEqual(pure.clockPace(c.card, paceFix.now), c.expected);
    });
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

for (const c of extraFix.cases) {
    test(`extra usage - ${c.name}`, () => {
        assert.deepEqual(extraCore(pure.normalizeExtraUsage(c.payload)), c.expected);
    });
}
test('labels unknown kinds', () => {
    for (const l of extraFix.labels)
        assert.equal(pure.kindLabel(l.kind), l.expected, l.kind);
});

// ── HTTP failures ───────────────────────────────────────────────────────────────
// What a non-2xx answer from the usage endpoint becomes: which statuses keep
// the last reading up and retry, and how the server's own words reach the UI.
const httpFix = fixture('httpfailure.json');

for (const c of httpFix.cases) {
    test(`httpFailure - ${c.name}`, () => {
        assert.deepEqual(pure.httpFailure(c.status, c.body), {ok: false, ...c.expected});
    });
}
test('isTransientStatus', () => {
    for (const s of httpFix.transient)
        assert.equal(pure.isTransientStatus(s), true, String(s));
    for (const s of httpFix.notTransient)
        assert.equal(pure.isTransientStatus(s), false, String(s));
});

// ── The usage endpoint's non-2xx contract ───────────────────────────────────────
// One call per port turns a status into the three things a client acts on:
// whether the credentials are finished (nothing retries out of that), whether
// the last reading may stay up, and what to put on screen. The Swift twin is
// UsageFailureTests.
const endpointFix = fixture('usage-endpoint.json');

test(`usageFailure - the live-login message is the fixture's`, () => {
    assert.equal(pure.AUTH_EXPIRED_MESSAGE, endpointFix.authExpiredMessage);
});
for (const c of endpointFix.cases) {
    test(`usageFailure - ${c.name}`, () => {
        assert.deepEqual(
            pure.usageFailure(c.status, c.body, {
                label: c.label, retryAfter: c.retryAfter ?? null,
                nowMs: Date.parse(endpointFix.now),
            }),
            {ok: false, ...c.expected});
    });
}

// ── Honest readings ─────────────────────────────────────────────────────────────
// When a percentage may NOT be printed: no number in the payload, or a window
// that has already rolled over. The Swift twin is UsageReadingTests.
const readingFix = fixture('reading.json');
const readingNow = Date.parse(readingFix.now);

test(`the em dash is the fixture's`, () => {
    assert.equal(pure.NO_READING, readingFix.noReading);
});
for (const c of readingFix.normalize) {
    test(`percentKnown - ${c.name}`, () => {
        assert.deepEqual(
            pure.normalizeUsage(c.input).map(
                (card) => ({
                    kind: card.key.split(':')[0],
                    percent: card.percent,
                    percentKnown: card.percentKnown,
                })),
            c.expected);
    });
}
for (const c of readingFix.cases) {
    test(`usageReading - ${c.name}`, () => {
        assert.deepEqual(pure.usageReading(c.card, readingNow), c.expected);
    });
}
for (const c of readingFix.panelCard) {
    test(`panelCard - ${c.name}`, () => {
        assert.equal(pure.panelCard(c.cards, c.mode, readingNow)?.key ?? null, c.expected);
    });
}

// ── The top-bar gauge ───────────────────────────────────────────────────────────
// The logo's arc, drawn live in both top bars. The Swift twin is PanelGaugeTests.
const gaugeFix = fixture('gauge.json');

test('panelGauge - the fill colors are the fixture\'s', () => {
    assert.deepEqual(pure.GAUGE_COLORS, gaugeFix.colors);
});
for (const c of gaugeFix.cases) {
    test(`panelGauge - ${c.name}`, () => {
        assert.deepEqual(pure.panelGauge(c.reading, c.severity, c.exhaustsBeforeReset), c.expected);
    });
}

// ── Named accounts ──────────────────────────────────────────────────────────────
// What a valid profile is, which saved login is the live one, whether a stored
// token is still usable, and when to move to another account.
const accountsFix = fixture('accounts.json');

test('accounts - constants', () => {
    assert.equal(pure.REFRESH_LEAD_MS, accountsFix.refreshLeadMs);
    assert.equal(pure.AUTO_SWITCH.threshold, accountsFix.threshold);
    assert.equal(pure.AUTO_SWITCH.margin, accountsFix.margin);
    assert.equal(pure.AUTO_SWITCH.cooldownMs, accountsFix.cooldownMs);
});
test('accounts - profile validity and names', () => {
    for (const raw of accountsFix.profiles) {
        const p = pure.parseProfile(raw);
        assert.ok(p, raw.name);
        assert.equal(p.name, raw.name);
        assert.deepEqual(p.credentials, raw.credentials);
    }
    for (const raw of accountsFix.invalidProfiles)
        assert.equal(pure.parseProfile(raw), null, JSON.stringify(raw));
    for (const n of accountsFix.validNames) assert.ok(pure.isValidName(n), n);
    for (const n of accountsFix.invalidNames) assert.ok(!pure.isValidName(n), n);
});
const profiles = accountsFix.profiles.map(pure.parseProfile);
test('accounts - summaries and token state', () => {
    assert.deepEqual(profiles.map(p => pure.accountSummary(p, accountsFix.now)), accountsFix.summaries);
    for (const s of accountsFix.summaries) {
        assert.equal(pure.tokenState(profiles.find((p) => p.name === s.name), accountsFix.now),
            s.tokenState, s.name);
    }
});
for (const c of accountsFix.active) {
    test(`accounts - active: ${c.name}`, () => {
        assert.equal(pure.activeAccountName(profiles, c.live), c.expected);
    });
}
for (const c of accountsFix.autoSwitch) {
    test(`accounts - auto-switch: ${c.name}`, () => {
        assert.deepEqual(pure.autoSwitchTarget({
            active: c.active, worst: c.worst, lastSwitchMs: c.lastSwitchMs,
            nowMs: accountsFix.now, threshold: accountsFix.threshold,
            margin: accountsFix.margin, cooldownMs: accountsFix.cooldownMs,
        }), c.expected);
    });
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

// ── Session snapshots ───────────────────────────────────────────────────────────
// The claudectl snapshot store as the panels summarise it (GNOME pure here;
// the Swift twin is SnapshotsParityTests).

test('snapshots: every case of the shared fixture', () => {
    for (const c of fixture('snapshots.json').cases) {
        const got = pure.summarizeSnapshots(c.files);
        const newest = got.newest && {
            label: got.newest.label, savedAt: got.newest.savedAt, names: got.newest.sessions.map(r => r.name),
        };
        assert.deepEqual({count: got.count, autos: got.autos, newest}, c.expect, c.name);
    }
});

// ── One JS copy ─────────────────────────────────────────────────────────────────
// The Node clients import lib/pure/; they never carry a copy of it. A top-level
// definition under claude-code/, mcp/, linux/ or scripts/ that reuses the name
// of a lib/pure export is how a second copy starts (normalize.js,
// accounts-contract.js, notices.js and codex-contract.js each began that way),
// so it fails here: import the pure one, or give a genuinely different thing a
// different name.
test('no Node file redefines a lib/pure export', () => {
    const root = path.join(here, '..');
    const pureDir = path.join(root, 'claude-usage-panel@fschmutz.github.io', 'lib', 'pure');
    const exported = new Set();
    for (const f of fs.readdirSync(pureDir)) {
        const src = fs.readFileSync(path.join(pureDir, f), 'utf8');
        for (const m of src.matchAll(/^export (?:async )?(?:function\*? ?|const |let |class )([\w$]+)/gm))
            exported.add(m[1]);
    }
    assert.ok(exported.size > 100, `only ${exported.size} pure exports found`);
    const copies = [];
    for (const dir of ['claude-code', 'mcp', 'linux', 'scripts']) {
        for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => /\.m?js$/.test(n))) {
            const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
            for (const m of src.matchAll(/^(?:export )?(?:async )?(?:function\*? ?|const |let |class )([\w$]+)/gm))
                if (exported.has(m[1])) copies.push(`${dir}/${f}: ${m[1]}`);
        }
    }
    assert.deepEqual(copies, []);
});
