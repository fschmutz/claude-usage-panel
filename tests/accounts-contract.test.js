// Named accounts, the pure contract: every tests/fixtures/accounts.json
// section parity.test.js does not walk, run through both JS ports
// (claude-code/accounts-contract.js and the GNOME lib/pure.js). The Swift twin
// is macos/Tests/ClaudeUsageCoreTests/AccountsParityTests.swift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';

import * as contract from '../claude-code/accounts-contract.js';
import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {FIX, NOW, sha256Hex} from './accounts-world.js';

const PORTS = [['accounts-contract.js', contract], ['pure.js', pure]];

// ── Shared fixture: the sections both JS ports must agree on ────────────────────

for (const [portName, port] of PORTS) {
    const profiles = FIX.profiles.map(port.parseProfile);
    test(`${portName} liveProfileName: the token first, then the account block`, () => {
        for (const c of FIX.liveLogin)
            assert.equal(port.liveProfileName(profiles, c.token, c.account), c.expected, c.name);
    });
    test(`${portName} syncBackPlan: never snapshots a torn, identity-less or unfinished switch`, () => {
        for (const c of FIX.syncBack) {
            assert.deepEqual(port.syncBackPlan(profiles, {token: c.token, account: c.account}, c.pending),
                c.expected, c.name);
        }
    });
    test(`${portName} sameName ignores case`, () => {
        for (const [a, b, expected] of FIX.sameName) assert.equal(port.sameName(a, b), expected, `${a}/${b}`);
    });
    test(`${portName} parkName: a valid, free name from the email`, () => {
        for (const c of FIX.parkName) {
            const got = port.parkName(c.email, c.taken);
            assert.equal(got, c.expected, c.name);
            assert.ok(port.isValidName(got), `${c.name}: ${got} is a valid name`);
        }
    });
}

test('pure.js formatAccountUsage matches the shared fixture', () => {
    for (const c of FIX.formatUsage) assert.equal(pure.formatAccountUsage(c.cards), c.expected, c.name);
});

test('keychainServices: Claude Code\'s per-config-dir item name', () => {
    for (const [input, hex] of Object.entries(FIX.keychain.sha256)) assert.equal(sha256Hex(input), hex, input);
    for (const c of FIX.keychain.cases)
        assert.deepEqual(contract.keychainServices(c.env, sha256Hex), c.expected, c.name);
});

test('worstPercent takes the fullest card, clamped', () => {
    assert.equal(contract.worstPercent([{percent: 12}, {percent: 34}]), 34);
    assert.equal(contract.worstPercent([{percent: 140}]), 100);
    assert.equal(contract.worstPercent([]), null);
});

test('keychainWriteLine: the tokens go hex-encoded on stdin, quoted names only', () => {
    for (const c of FIX.keychainWrite) {
        const got = contract.keychainWriteLine(c.account, c.service, c.secret.repeat(c.repeat ?? 1));
        if ('expectedBytes' in c) assert.equal(Buffer.byteLength(got ?? ''), c.expectedBytes, c.name);
        else assert.equal(got, c.expected, c.name);
    }
});

// ── The store decisions: what each port's I/O layer only carries out ───────────

for (const [portName, port] of PORTS) {
    const profiles = FIX.profiles.map(port.parseProfile);
    test(`${portName} saveRefusal: case variant, then a taken name unless forced, then a twin`, () => {
        for (const c of FIX.saveRefusal)
            assert.deepEqual(port.saveRefusal(profiles, c.save, c.account, c.force), c.expected, c.name);
    });
    test(`${portName} refreshedOauth: only a finite positive expires_in moves the expiry`, () => {
        for (const c of FIX.refresh) {
            const before = JSON.parse(JSON.stringify(FIX.refreshOauth));
            assert.deepEqual(port.refreshedOauth(FIX.refreshOauth, c.body, NOW), c.expected, c.name);
            assert.deepEqual(FIX.refreshOauth, before, `${c.name}: the input block is not mutated`);
        }
    });
    test(`${portName} isTorn: the account block names another saved profile`, () => {
        for (const c of FIX.torn) assert.equal(port.isTorn(profiles, c.profile, c.account), c.expected, c.name);
    });
    test(`${portName} switchPlan: from, park, and stay / repair / expired / refresh / install`, () => {
        for (const c of FIX.switchPlan) {
            const got = port.switchPlan({
                name: c.target, synced: c.synced, pending: c.pending, torn: c.torn, state: c.state,
            });
            assert.deepEqual(got, c.expected, c.name);
        }
    });
    test(`${portName} sameJSON: key order ignored, scalars strict`, () => {
        for (const [a, b, expected] of FIX.sameJSON) {
            assert.equal(port.sameJSON(a, b), expected, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
            assert.equal(port.sameJSON(b, a), expected, `${JSON.stringify(b)} / ${JSON.stringify(a)}`);
        }
    });
    test(`${portName} usageCacheEntry: worst, session and weekly-all of one account`, () => {
        for (const c of FIX.usageCacheEntry) assert.deepEqual(port.usageCacheEntry(c.cards), c.expected, c.name);
    });
}
