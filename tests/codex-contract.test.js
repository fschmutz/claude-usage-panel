// The Codex contract, asserted against the shared fixture in both JS ports
// (the Swift twin is macos/Tests/ClaudeUsageCoreTests/CodexParityTests.swift).
// Nothing here touches the disk or the network: every decision is a pure
// function of an auth blob, a clock, and a recorded rate-limit snapshot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import * as codex from '../claude-code/codex-contract.js';
import {isValidName} from '../claude-code/accounts-contract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'codex.json'), 'utf8'));

for (const [portName, port] of [['pure/codex.js', pure], ['codex-contract.js', codex]]) {
    test(`${portName} - the constants are the fixture's`, () => {
        assert.equal(port.CODEX_REFRESH_LEAD_MS, FIX.refreshLeadMs);
        assert.equal(port.CODEX_REFRESH_MAX_AGE_MS, FIX.refreshMaxAgeMs);
        assert.equal(port.CODEX_SNAPSHOT_MAX_AGE_MS, FIX.snapshotMaxAgeMs);
        assert.equal(port.CODEX_AUTH_CLAIM, FIX.authClaim);
    });

    test(`${portName} - JWT claims are read, never verified`, () => {
        for (const c of FIX.jwt)
            assert.deepEqual(port.jwtClaims(c.token), c.expected, c.name);
        // The real tokens in the fixture carry what the identity is built from.
        assert.equal(port.jwtClaims(FIX.tokens.idPlus).email, 'plus@example.com');
        assert.equal(port.jwtClaims(FIX.tokens.accessValid).exp, 1789310000);
    });

    test(`${portName} - plan labels`, () => {
        for (const c of FIX.planLabels)
            assert.equal(port.codexPlanLabel(c.plan), c.expected, JSON.stringify(c.plan));
    });

    test(`${portName} - profiles parse and summarize`, () => {
        const profiles = FIX.profiles.map((raw) => port.parseCodexProfile(raw, isValidName));
        for (const [i, p] of profiles.entries())
            assert.ok(p, FIX.profiles[i].name);
        assert.deepEqual(profiles.map((p) => port.codexSummary(p, FIX.now)), FIX.summaries);
        for (const raw of FIX.invalidProfiles) {
            assert.equal(port.parseCodexProfile(raw, isValidName), null, JSON.stringify(raw));
        }
    });

    test(`${portName} - which saved login is live`, () => {
        const profiles = FIX.profiles.map((raw) => port.parseCodexProfile(raw, isValidName));
        for (const c of FIX.active)
            assert.equal(port.activeCodexName(profiles, c.live), c.expected, c.name);
    });

    test(`${portName} - window labels`, () => {
        for (const c of FIX.windowLabels)
            assert.equal(port.codexWindowLabel(c.minutes), c.expected, String(c.minutes));
    });

    test(`${portName} - a recorded snapshot becomes cards, and nothing else does`, () => {
        for (const c of FIX.limits) {
            const got = port.normalizeCodexLimits(c.rateLimits, c.capturedAtMs);
            assert.deepEqual(
                got.map((x) => ({
                    key: x.key, label: x.label, group: x.group, percent: x.percent,
                    percentKnown: x.percentKnown, resetsAt: x.resetsAt, active: x.active,
                })),
                c.expected, c.name);
            // Every Codex figure this project shows says where it came from.
            for (const card of got) {
                assert.equal(card.provenance, 'estimated');
                assert.equal(card.capturedAt, new Date(c.capturedAtMs).toISOString());
            }
        }
    });

    test(`${portName} - a snapshot too old to mean anything is not shown`, () => {
        for (const c of FIX.snapshotAge) {
            assert.equal(
                port.codexSnapshotAge(c.capturedAtMs, FIX.now).show, c.expected, c.name);
        }
    });
}
