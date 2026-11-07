// The shared Awake contract: lib/pure/awake.js against tests/fixtures/awake.json,
// the same file the Swift AwakeParityTests assert. Session arithmetic, the
// battery / thermal floors, the recovery journal and every platform argv.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'awake.json'), 'utf8'));
const NOW = fix.nowMs;

test('awake constants match the fixture', () => {
    assert.equal(pure.AWAKE_VERSION, fix.version);
    assert.deepEqual([...pure.AWAKE_HOLDS], fix.holds);
    assert.deepEqual([...pure.AWAKE_JOURNAL_KEYS], fix.journalKeys);
    assert.equal(pure.AWAKE_MIN_SECONDS, fix.minSeconds);
    assert.equal(pure.AWAKE_MAX_SECONDS, fix.maxSeconds);
    assert.equal(pure.AWAKE_BACKSTOP_GRACE_MS, fix.backstopGraceMs);
    assert.equal(pure.AWAKE_POLL_SECONDS, fix.pollSeconds);
    assert.deepEqual({...pure.AWAKE_DEFAULTS}, fix.defaults);
    assert.deepEqual(pure.AWAKE_SUDO_COMMANDS.map((c) => [...c]), fix.sudoCommands);
    assert.equal(pure.AWAKE_DEFAULT_SECONDS, fix.defaultSeconds);
});

test('every darwin sudo argv is one of the granted commands, behind sudo -n', () => {
    const granted = fix.sudoCommands.map((c) => c.join(' '));
    const used = [true, false].flatMap((on) => [
        pure.awakeLidArgv('darwin', on), pure.awakeLowPowerArgv('darwin', on),
    ]);
    for (const argv of used) {
        assert.deepEqual(argv.slice(0, 2), ['/usr/bin/sudo', '-n']);
        assert.ok(granted.includes(argv.slice(2).join(' ')), argv.join(' '));
    }
    assert.deepEqual(new Set(used.map((a) => a.slice(2).join(' '))), new Set(granted), 'all four used');
    assert.equal(pure.awakeSudoArgv('somethingElse', true), null, 'nothing outside the rule');
});

test('one owner reading for a session and a journal alike', () => {
    const raw = {pid: -3, host: 7, kind: 'cli'};
    const want = {pid: 0, host: '', kind: 'cli'};
    assert.deepEqual(pure.parseAwakeOwner(raw), want);
    assert.deepEqual(pure.parseAwakeSession({startedAt: 1, endsAt: 2, owner: raw}).owner, want);
    assert.deepEqual(pure.parseAwakeJournal({owner: raw}).owner, want);
    assert.deepEqual(pure.newAwakeSession({owner: raw}).owner, want);
    assert.deepEqual(pure.awakeJournalEntry({owner: raw}).owner, want);
    assert.equal(pure.parseAwakeOwner([]), null);
    assert.deepEqual(pure.awakeJournalEntry({}).owner, {pid: 0, host: '', kind: ''});
});

test('awakeStartError: one sentence per refusal, the end hint per surface', () => {
    const held = {ok: false, reason: 'already-held', owner: {pid: 42}};
    assert.equal(pure.awakeStartError(held, {endHint: 'use action "off" to end it'}),
        'already awake, held by pid 42 - use action "off" to end it');
    assert.equal(pure.awakeStartError(held), 'already awake, held by pid 42');
    assert.match(pure.awakeStartError({reason: 'recovery-pending', steps: ['sleepDisabled']}),
        /left sleepDisabled to give back - run `claudectl awake recover --force` first/);
    assert.match(pure.awakeStartError({reason: 'busy'}), /holds the lock - nothing was started/);
    assert.equal(pure.awakeStartError({reason: 'no-holder', log: 'x\ny'}), 'the holder did not start:\nx\ny');
    assert.equal(pure.awakeStartError({reason: 'no-holder'}), 'the holder did not start');
});

for (const c of fix.parseDuration) {
    test(`parseAwakeDuration ${JSON.stringify(c.text)}`, () =>
        assert.equal(pure.parseAwakeDuration(c.text), c.expected));
}

for (const c of fix.formatDuration) {
    test(`formatAwakeDuration ${c.seconds}`, () =>
        assert.equal(pure.formatAwakeDuration(c.seconds), c.expected));
}

for (const c of fix.countdown) {
    test(`awakeCountdown ${c.remainingMs}`, () =>
        assert.equal(pure.awakeCountdown(c.remainingMs), c.expected));
}

for (const c of fix.clampDuration) {
    test(`clampAwakeDuration ${c.seconds} max ${c.maxSeconds}`, () =>
        assert.equal(pure.clampAwakeDuration(c.seconds, c.maxSeconds), c.expected));
}

for (const [i, c] of fix.normalizeConfig.entries()) {
    test(`normalizeAwakeConfig case ${i}`, () =>
        assert.deepEqual(pure.normalizeAwakeConfig(c.config), c.expected));
}

for (const [i, c] of fix.newSession.entries()) {
    test(`newAwakeSession case ${i}`, () => {
        const s = pure.newAwakeSession({nowMs: NOW, ...c.args});
        assert.equal(s.version, fix.version);
        assert.equal(s.startedAt, c.expected.startedAt);
        assert.equal(s.endsAt, c.expected.endsAt);
        assert.equal(s.timed, c.expected.timed);
        assert.equal(s.whileSessions, c.expected.whileSessions);
        assert.equal(s.lid, c.expected.lid);
    });
}

test('newAwakeSession records its owner when given one', () => {
    const s = pure.newAwakeSession({nowMs: NOW, seconds: 3600, owner: {pid: 7, host: 'h', kind: 'cli'}});
    assert.deepEqual(s.owner, {pid: 7, host: 'h', kind: 'cli'});
    assert.equal(pure.newAwakeSession({nowMs: NOW, seconds: 3600}).owner, null);
});

for (const [i, c] of fix.parseSession.entries()) {
    test(`parseAwakeSession case ${i}`, () => {
        const got = pure.parseAwakeSession(c.raw);
        if (c.expected === null) {
            assert.equal(got, null);
            return;
        }
        assert.equal(got.startedAt, c.expected.startedAt);
        assert.equal(got.endsAt, c.expected.endsAt);
        assert.equal(got.timed, c.expected.timed);
        assert.equal(got.whileSessions, c.expected.whileSessions);
        assert.equal(got.lid, c.expected.lid);
        assert.equal(got.owner?.pid ?? 0, c.expected.ownerPid);
        assert.equal(got.owner?.kind ?? '', c.expected.ownerKind);
    });
}

for (const [i, c] of fix.extend.entries()) {
    test(`extendAwakeSession case ${i}`, () =>
        assert.equal(pure.extendAwakeSession(c.session, c.extraSeconds, NOW).endsAt,
            c.expectedEndsAt));
}

test('extendAwakeSession on nothing stays nothing', () => {
    assert.equal(pure.extendAwakeSession(null, 3600, NOW), null);
});

for (const c of fix.state) {
    test(`awakeState - ${c.name}`, () => {
        const state = pure.awakeState({session: c.session, sessions: c.sessions, nowMs: NOW});
        assert.equal(state.active, c.expected.active);
        assert.deepEqual(state.holds, c.expected.holds);
        assert.equal(state.countdown, c.expected.countdown);
        assert.equal(state.endReason, c.expected.endReason);
        assert.equal(pure.awakeBadge(state), c.expected.badge);
    });
}

test('awakeRemainingMs floors at zero and ignores a bad session', () => {
    assert.equal(pure.awakeRemainingMs({startedAt: NOW, endsAt: NOW + 5000}, NOW), 5000);
    assert.equal(pure.awakeRemainingMs({startedAt: NOW, endsAt: NOW - 5000}, NOW), 0);
    assert.equal(pure.awakeRemainingMs(null, NOW), 0);
});

test('awakeEndReason with no session at all is the user ending it', () => {
    assert.equal(pure.awakeEndReason(null, {nowMs: NOW}), 'user');
});

test('awakeHolds is what awakeState lists, and empty past the deadline', () => {
    const both = {startedAt: NOW, endsAt: NOW + 1000, timed: true, whileSessions: true};
    assert.deepEqual(pure.awakeHolds(both, {nowMs: NOW, sessions: 1}), ['timer', 'sessions']);
    assert.deepEqual(pure.awakeHolds(both, {nowMs: NOW, sessions: 0}), ['timer']);
    assert.deepEqual(pure.awakeHolds(both, {nowMs: NOW + 1000, sessions: 1}), []);
    assert.deepEqual(pure.awakeHolds(null, {nowMs: NOW}), []);
});

for (const c of fix.floors) {
    test(`awakeFloorActions - ${c.name}`, () =>
        assert.deepEqual(pure.awakeFloorActions(c.input), c.expected));
}

test('awakeLowPowerCause ranks thermal over battery over the lid', () => {
    const base = {percent: 5, charging: false, lidClosed: true};
    assert.equal(pure.awakeLowPowerCause({...base, thermal: 'serious'}), 'thermal');
    assert.equal(pure.awakeLowPowerCause({...base, thermal: 'nominal'}), 'battery');
    assert.equal(pure.awakeLowPowerCause({percent: 100, charging: true, lidClosed: true}), 'lid');
    assert.equal(pure.awakeLowPowerCause({percent: 100, charging: true}), null);
});

for (const c of fix.journal) {
    test(`awake journal - ${c.name}`, () => {
        assert.equal(pure.parseAwakeJournal(c.raw) !== null, c.parsed);
        assert.equal(pure.awakeJournalDirty(c.raw), c.dirty);
        assert.deepEqual(pure.awakeRecoverySteps(c.raw), c.steps);
    });
}

test('awakeJournalEntry writes every key, defaulted off', () => {
    const entry = pure.awakeJournalEntry({nowMs: NOW, endsAt: NOW + 1000, owner: {pid: 9, host: 'h', kind: 'cli'}});
    assert.deepEqual(entry, {
        version: fix.version, at: NOW, endsAt: NOW + 1000,
        owner: {pid: 9, host: 'h', kind: 'cli'},
        sleepDisabled: false, lowPower: false,
    });
    assert.equal(pure.awakeJournalDirty(entry), false);
});

for (const c of fix.backstopDue) {
    test(`awakeBackstopDue - ${c.name}`, () =>
        assert.equal(pure.awakeBackstopDue(c.journal, c.nowMs, {force: c.force}), c.expected));
}

for (const c of fix.recoveryNotice) {
    test(`awakeRecoveryNotice - ${c.name}`, () => {
        const got = pure.awakeRecoveryNotice(c.journal, c.nowMs);
        if (c.expected === null) {
            assert.equal(got, null);
            return;
        }
        assert.deepEqual(got, c.expected);
    });
}

for (const c of fix.inhibitArgv) {
    test(`awakeInhibitArgv ${c.platform}`, () =>
        assert.deepEqual(pure.awakeInhibitArgv(c.platform, c.args), c.expected));
}

for (const c of fix.lidArgv) {
    test(`awakeLidArgv ${c.platform} ${c.on}`, () =>
        assert.deepEqual(pure.awakeLidArgv(c.platform, c.on, c.args ?? {}), c.expected));
}

for (const c of fix.lowPowerArgv) {
    test(`awakeLowPowerArgv ${c.platform} ${c.on}`, () =>
        assert.deepEqual(pure.awakeLowPowerArgv(c.platform, c.on), c.expected));
}

test('awakeSudoersBody is exactly the four commands', () => {
    assert.equal(pure.awakeSudoersBody(fix.sudoersBody.user), fix.sudoersBody.expected);
});

for (const [i, c] of fix.sleepDisabled.entries()) {
    test(`parseSleepDisabled case ${i}`, () =>
        assert.equal(pure.parseSleepDisabled(c.output), c.expected));
}

for (const [i, c] of fix.pmsetBattery.entries()) {
    test(`parsePmsetBattery case ${i}`, () =>
        assert.deepEqual(pure.parsePmsetBattery(c.output), c.expected));
}

for (const [i, c] of fix.sysfsBattery.entries()) {
    test(`parseSysfsBattery case ${i}`, () =>
        assert.deepEqual(pure.parseSysfsBattery(c.input), c.expected));
}

for (const c of fix.thermalMilli) {
    test(`thermalFromMillidegrees ${c.milli}`, () =>
        assert.equal(pure.thermalFromMillidegrees(c.milli), c.expected));
}

for (const [i, c] of fix.thermalSpeedLimit.entries()) {
    test(`thermalFromSpeedLimit case ${i}`, () =>
        assert.equal(pure.thermalFromSpeedLimit(c.output), c.expected));
}
