// Named accounts, the pure contract: every tests/fixtures/accounts.json
// section parity.test.js does not walk, run through lib/pure/accounts.js, the
// one JS copy (GNOME and the Node CLI / MCP / status line import it). The Swift
// twin is macos/Tests/ClaudeUsageCoreTests/AccountsParityTests.swift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';

import * as accounts from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {FIX, NOW, sha256Hex} from './accounts-world.js';

// ── Shared fixture ──────────────────────────────────────────────────────────────

const profiles = FIX.profiles.map(accounts.parseProfile);
test('liveProfileName: the token first, then the account block', () => {
    for (const c of FIX.liveLogin)
        assert.equal(accounts.liveProfileName(profiles, c.token, c.account), c.expected, c.name);
});
test('syncBackPlan: never snapshots a torn, identity-less or unfinished switch', () => {
    for (const c of FIX.syncBack) {
        assert.deepEqual(accounts.syncBackPlan(profiles, {token: c.token, account: c.account}, c.pending),
            c.expected, c.name);
    }
});
test('sameName ignores case', () => {
    for (const [a, b, expected] of FIX.sameName) assert.equal(accounts.sameName(a, b), expected, `${a}/${b}`);
});
test('parkName: a valid, free name from the email', () => {
    for (const c of FIX.parkName) {
        const got = accounts.parkName(c.email, c.taken);
        assert.equal(got, c.expected, c.name);
        assert.ok(accounts.isValidName(got), `${c.name}: ${got} is a valid name`);
    }
});

// Every card is read through usageReading at the fixture's `now`: a
// placeholder or a window that already rolled over has no honest reading.
test('formatAccountUsage matches the shared fixture', () => {
    for (const c of FIX.formatUsage) assert.equal(accounts.formatAccountUsage(c.cards, NOW, c.keptResetMs ?? null), c.expected, c.name);
});
test('worstPercent skips a card with no honest reading', () => {
    for (const c of FIX.worstPercent) assert.equal(accounts.worstPercent(c.cards, NOW), c.expected, c.name);
});
test('refresh lock: one file name and timing for every port', () => {
    const {name, file, ...timing} = FIX.refreshLock;
    assert.equal(accounts.refreshLockFile(name), file);
    assert.deepEqual(accounts.REFRESH_LOCK, timing);
});
test('refreshFailureCode: only 400/401 asks for a new sign-in', () => {
    for (const [status, code] of FIX.refreshFailure) assert.equal(accounts.refreshFailureCode(status), code, String(status));
});
test('refreshRaced: another process already spent the refresh token', () => {
    for (const c of FIX.refreshRaced) assert.equal(accounts.refreshRaced(c.sent, c.stored), c.expected, c.name);
});

test('keychainServices: Claude Code\'s per-config-dir item name', () => {
    for (const [input, hex] of Object.entries(FIX.keychain.sha256)) assert.equal(sha256Hex(input), hex, input);
    for (const c of FIX.keychain.cases)
        assert.deepEqual(accounts.keychainServices(c.env, sha256Hex), c.expected, c.name);
});

test('worstPercent reads by JSON type: a percent that is not a number is no reading', () => {
    assert.equal(accounts.worstPercent([{percent: 12}, {percent: 34}], NOW), 34);
    assert.equal(accounts.worstPercent([{percent: '96'}, {percent: null}, {percent: true}], NOW), null);
});

test('keychainWriteLine: the tokens go hex-encoded on stdin, quoted names only', () => {
    for (const c of FIX.keychainWrite) {
        const got = accounts.keychainWriteLine(c.account, c.service, c.secret.repeat(c.repeat ?? 1));
        if ('expectedBytes' in c) assert.equal(Buffer.byteLength(got ?? ''), c.expectedBytes, c.name);
        else assert.equal(got, c.expected, c.name);
    }
});

// ── The store decisions: what each port's I/O layer only carries out ───────────

test('saveRefusal: case variant, then a taken name unless forced, then a twin', () => {
    for (const c of FIX.saveRefusal)
        assert.deepEqual(accounts.saveRefusal(profiles, c.save, c.account, c.force), c.expected, c.name);
});
test('refreshedOauth: only a finite positive expires_in moves the expiry', () => {
    for (const c of FIX.refresh) {
        const before = JSON.parse(JSON.stringify(FIX.refreshOauth));
        assert.deepEqual(accounts.refreshedOauth(FIX.refreshOauth, c.body, NOW), c.expected, c.name);
        assert.deepEqual(FIX.refreshOauth, before, `${c.name}: the input block is not mutated`);
    }
});
test('isTorn: the account block names another saved profile', () => {
    for (const c of FIX.torn) assert.equal(accounts.isTorn(profiles, c.profile, c.account), c.expected, c.name);
});
test('switchPlan: from, park, and stay / repair / expired / refresh / install', () => {
    for (const c of FIX.switchPlan) {
        const got = accounts.switchPlan({
            name: c.target, synced: c.synced, pending: c.pending, torn: c.torn, state: c.state,
        });
        assert.deepEqual(got, c.expected, c.name);
    }
});
test('sameJSON: key order ignored, scalars strict', () => {
    for (const [a, b, expected] of FIX.sameJSON) {
        assert.equal(accounts.sameJSON(a, b), expected, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
        assert.equal(accounts.sameJSON(b, a), expected, `${JSON.stringify(b)} / ${JSON.stringify(a)}`);
    }
});
test('keepWeeklyResets matches the shared fixture', () => {
    for (const c of FIX.weeklyResets) assert.deepEqual(accounts.keepWeeklyResets(c.prev, c.fresh, c.names, NOW), c.expected, c.name);
});

test('usageCacheEntry: worst, session and weekly-all of one account', () => {
    for (const c of FIX.usageCacheEntry) assert.deepEqual(accounts.usageCacheEntry(c.cards, NOW), c.expected, c.name);
});
