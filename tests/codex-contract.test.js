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
const load = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const FIX = load('codex.json');
const USAGE = load('codex-usage.json');

for (const [portName, port] of [['pure/codex.js', pure], ['codex-contract.js', codex]]) {
    test(`${portName} - the constants are the fixture's`, () => {
        assert.equal(port.CODEX_REFRESH_LEAD_MS, FIX.refreshLeadMs);
        assert.equal(port.CODEX_REFRESH_MAX_AGE_MS, FIX.refreshMaxAgeMs);
        assert.equal(port.CODEX_SNAPSHOT_MAX_AGE_MS, USAGE.snapshotMaxAgeMs);
        assert.equal(port.CODEX_AUTH_CLAIM, FIX.authClaim);
    });

    test(`${portName} - token state reads exp and last_refresh strictly`, () => {
        for (const c of FIX.tokenStateStrict.cases)
            assert.equal(port.codexTokenState({auth: c.auth}, FIX.now), c.expected, c.name);
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

    test(`${portName} - one Team workspace, two members: the user id tells them apart`, () => {
        const profiles = FIX.team.profiles.map((raw) => port.parseCodexProfile(raw, isValidName));
        for (const c of FIX.team.active)
            assert.equal(port.activeCodexName(profiles, c.live), c.expected, c.name);
        for (const c of FIX.team.identities) {
            const {email, accountId, userId, plan} = port.codexIdentity(c.auth);
            assert.deepEqual({email, accountId, userId, plan}, c.expected, c.name);
        }
    });

    test(`${portName} - window labels`, () => {
        for (const c of USAGE.windowLabels)
            assert.equal(port.codexWindowLabel(c.minutes), c.expected, String(c.minutes));
    });

    test(`${portName} - a recorded snapshot becomes cards, and nothing else does`, () => {
        for (const c of USAGE.limits) {
            const got = port.normalizeCodexLimits(c.rateLimits, c.capturedAtMs, c.nowMs ?? null);
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
        for (const c of USAGE.snapshotAge) {
            assert.equal(
                port.codexSnapshotAge(c.capturedAtMs, USAGE.now).show, c.expected, c.name);
        }
    });

    test(`${portName} - the last rate-limit reading in a transcript tail`, () => {
        for (const c of USAGE.transcripts)
            assert.deepEqual(port.lastRateLimits(c.text), c.expected, c.name);
    });

    test(`${portName} - the freshest recorded usage, or why there is none`, () => {
        for (const c of USAGE.recorded) {
            const got = port.pickRecordedCodexUsage(c.files, USAGE.now);
            assert.deepEqual(
                {reason: got.reason, capturedAt: got.capturedAt, keys: got.cards.map((x) => x.key)},
                {reason: c.expected.reason, capturedAt: c.expected.capturedAt, keys: c.expected.keys},
                c.name);
            if (c.expected.resetsAt)
                assert.deepEqual(got.cards.map((x) => x.resetsAt), c.expected.resetsAt, c.name);
        }
    });
}

// ── The switch guard and the transcript walk ────────────────────────────────

/** A fake store for codexSwitch: the fixture case scripts the codex CLI. */
function switchWorld(c) {
    const w = {version: 0, syncs: 0, writes: 0};
    const blob = () => (c.hasLive ? {tokens: {v: w.version}} : null);
    const ops = {
        syncBack: () => {
            const synced = {name: c.hasLive ? c.live : null, auth: blob()};
            if (c.rotations[w.syncs++])
                w.version++;
            return synced;
        },
        readLive: blob,
        write: () => w.writes++,
    };
    return {w, ops};
}

/** The directory listing codexSessionScan asks for, from a fixture tree. */
function treeLister(tree, visited) {
    return (segments) => {
        visited.push(segments.join('/'));
        let node = tree;
        for (const s of segments)
            node = node?.[s];
        if (!node || typeof node !== 'object')
            return null;
        return Object.entries(node).map(([name, v]) => ({
            name, dir: typeof v === 'object' && v !== null, mtimeMs: typeof v === 'number' ? v : null,
        }));
    };
}

for (const [portName, port] of [['pure/codex.js', pure], ['codex-contract.js', codex]]) {
    test(`${portName} - the switch and scan constants are the fixture's`, () => {
        assert.equal(port.CODEX_SWITCH_SYNC_TRIES, FIX.switchSyncTries);
        assert.equal(port.CODEX_SESSION_SCAN_LIMIT, USAGE.sessionScanLimit);
        assert.equal(port.CODEX_SESSIONS_MAX_DEPTH, USAGE.sessionsMaxDepth);
    });

    test(`${portName} - a token the codex CLI rotates mid-switch is synced, never overwritten`, () => {
        for (const c of FIX.switchGuard.cases) {
            const {w, ops} = switchWorld(c);
            const r = port.codexSwitch(c.target, ops);
            assert.deepEqual(
                {outcome: r.outcome, from: r.from ?? null, syncs: w.syncs, writes: w.writes},
                c.expected, c.name);
        }
    });

    test(`${portName} - the transcript walk: newest day first, bounded depth, stops at the limit`, () => {
        for (const c of USAGE.sessionScan.cases) {
            const visited = [];
            const got = port.scanCodexSessions(treeLister(c.tree, visited), c.limit);
            assert.deepEqual(got.map((f) => f.path), c.expected, c.name);
            assert.deepEqual(visited, c.visited, c.name);
        }
    });
}

test('pure/codex.js - the async walk (the GNOME shell drives it) matches the sync one', async () => {
    for (const c of USAGE.sessionScan.cases) {
        const visited = [];
        const lister = treeLister(c.tree, visited);
        const got = await pure.scanCodexSessionsAsync((s) => Promise.resolve(lister(s)), c.limit);
        assert.deepEqual(got.map((f) => f.path), c.expected, c.name);
        assert.deepEqual(visited, c.visited, c.name);
    }
});
