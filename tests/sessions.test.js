// Session pings and today's sessions, across all four ports.
//
// The three JS copies of the contract - lib/pure.js (GNOME), statusline.js
// (terminal) and mcp/server.js - are asserted here against ONE fixture,
// tests/fixtures/sessions.json; the Swift copy asserts the same file in
// macos/Tests/ClaudeUsageCoreTests/SessionsParityTests.swift.
//
// TZ is pinned to UTC before anything reads a date: localDay/formatClock are
// deliberately LOCAL (the panel shows the user's wall clock), so a fixture with
// fixed expectations has to fix the zone too. The Swift twin passes UTC in.
process.env.TZ = 'UTC';

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import * as statusline from '../claude-code/statusline.js';
import * as mcp from '../mcp/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sessions.json'), 'utf8'));
const NOW = fix.nowMs;

// Which ports implement which slice of the contract. The status line only
// READS the shared index (it must stay a sub-100ms command), so it carries the
// ping/format half and not the folding half.
const stampPorts = {pure, statusline, mcp};
const foldPorts = {pure, mcp};

for (const [portName, port] of Object.entries(stampPorts)) {
    for (const c of fix.stamps) {
        test(`${portName} parseStamp - ${c.raw}`, () => {
            assert.equal(port.parseStamp(c.raw), c.atMs);
        });
        test(`${portName} formatLastPing - ${c.raw}`, () => {
            assert.equal(port.formatLastPing(c.raw, NOW), c.lastPing);
        });
    }
}

for (const c of fix.nextPing) {
    test(`pure.js nextPing - ${c.times.join(',') || 'none'}`, () => {
        assert.equal(pure.nextPing(c.times, c.days, NOW), c.expected);
    });
}

for (const [portName, port] of Object.entries(foldPorts)) {
    test(`${portName} foldSessionLine`, () => {
        const acc = port.newSessionAcc();
        for (const line of fix.fold.lines)
            port.foldSessionLine(line, acc, fix.fold.defaultDay);
        assert.equal(acc.sessionId, fix.fold.expected.sessionId);
        assert.equal(acc.cwd, fix.fold.expected.cwd);
        assert.equal(acc.title, fix.fold.expected.title);
        assert.equal(acc.lastMs, fix.fold.expected.lastMs);
        assert.deepEqual(acc.byDay, fix.fold.expected.byDay);
    });

    test(`${portName} rankSessions`, () => {
        const got = port.rankSessions(fix.rank.entries, {nowMs: NOW, limit: fix.rank.limit});
        assert.deepEqual(
            got.map((s) => ({
                sessionId: s.sessionId, label: s.label, tokens: s.tokens, when: s.when,
            })),
            fix.rank.expected);
    });

    for (const c of fix.resume) {
        test(`${portName} resumeCommand - ${c.cwd || 'no cwd'}`, () => {
            assert.equal(port.resumeCommand({cwd: c.cwd, sessionId: c.sessionId}), c.command);
        });
    }
}

for (const c of fix.resume) {
    test(`pure.js interactiveResume - ${c.cwd || 'no cwd'}`, () => {
        assert.equal(
            pure.interactiveResume({cwd: c.cwd, sessionId: c.sessionId}), c.interactive);
    });
}

for (const c of fix.compactTokens) {
    test(`pure.js compactTokens - ${c.n}`, () => {
        assert.equal(pure.compactTokens(c.n), c.expected);
    });
    test(`statusline.js formatTokens - ${c.n}`, () => {
        assert.equal(statusline.formatTokens(c.n), c.expected);
    });
}

// ── Ranking drops what it cannot resume ─────────────────────────────────────
test('a session without an id is never offered as a resume link', () => {
    const ranked = pure.rankSessions(fix.rank.entries, {nowMs: NOW, limit: 5});
    assert.ok(ranked.every((s) => s.sessionId));
    assert.ok(!ranked.some((s) => s.label === 'nameless'));
});

test('yesterday-only sessions are not listed as today', () => {
    const ranked = pure.rankSessions(fix.rank.entries, {nowMs: NOW, limit: 5});
    assert.ok(!ranked.some((s) => s.sessionId === 'C'));
});

test('the limit is respected', () => {
    assert.equal(pure.rankSessions(fix.rank.entries, {nowMs: NOW, limit: 1}).length, 1);
    assert.equal(pure.rankSessions(fix.rank.entries, {nowMs: NOW, limit: 0}).length, 0);
});

// ── Terminal argv ───────────────────────────────────────────────────────────
test('a known terminal gets its own working-directory flag, not a cd', () => {
    const argv = pure.terminalArgv('gnome-terminal', '/home/u/p', 'echo hi');
    assert.deepEqual(argv, [
        'gnome-terminal', '--working-directory=/home/u/p', '--', 'bash', '-lc', 'echo hi',
    ]);
});

test('an absolute path to a known terminal is still recognised', () => {
    const argv = pure.terminalArgv('/usr/bin/kitty', '/home/u/p', 'echo hi');
    assert.deepEqual(argv, ['/usr/bin/kitty', '--directory', '/home/u/p', 'bash', '-lc', 'echo hi']);
});

test('an unknown terminal falls back to -e with a quoted cd', () => {
    const argv = pure.terminalArgv('weird-term', "/home/u/it's", 'claude --resume x');
    assert.deepEqual(argv, [
        'weird-term', '-e', 'bash', '-lc', `cd '/home/u/it'\\''s' && claude --resume x`,
    ]);
});

test('no terminal means no launch', () => {
    assert.equal(pure.terminalArgv('', '/tmp', 'echo'), null);
});

// ── The shared on-disk index ────────────────────────────────────────────────
// The node builder is what keeps the index warm for the status line, so it is
// asserted end to end against a throwaway projects tree.
test('the index folds a transcript once and then only its appended tail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-sessions-'));
    const projects = path.join(root, 'projects');
    const project = path.join(projects, '-home-u-p');
    fs.mkdirSync(project, {recursive: true});
    const transcript = path.join(project, 'S1.jsonl');
    const indexPath = path.join(root, 'index.json');
    const stamp = new Date(NOW).toISOString();
    const line = (id, tokens) => JSON.stringify({
        type: 'assistant', timestamp: stamp,
        message: {id, usage: {input_tokens: tokens, output_tokens: 0}},
    });

    fs.writeFileSync(transcript, [
        JSON.stringify({type: 'custom-title', customTitle: 'P', sessionId: 'S1'}),
        JSON.stringify({type: 'user', sessionId: 'S1', cwd: '/home/u/p'}),
        line('m1', 100),
        '',
    ].join('\n'));

    const first = mcp.refreshSessions({nowMs: NOW, projectsDir: projects, indexPath});
    assert.equal(first.length, 1);
    assert.equal(first[0].tokens, 100);
    assert.equal(first[0].label, 'P');
    assert.equal(first[0].resumeCommand, `cd '/home/u/p' && claude --resume 'S1'`);

    // Appending must add, never re-count: a re-fold from offset 0 would double.
    fs.appendFileSync(transcript, `${line('m2', 50)}\n`);
    const second = mcp.refreshSessions({nowMs: NOW, projectsDir: projects, indexPath});
    assert.equal(second[0].tokens, 150);

    // Unchanged file, unchanged numbers.
    const third = mcp.refreshSessions({nowMs: NOW, projectsDir: projects, indexPath});
    assert.equal(third[0].tokens, 150);

    // A truncated/replaced transcript is folded from the start again.
    fs.writeFileSync(transcript, `${JSON.stringify({type: 'user', sessionId: 'S1', cwd: '/home/u/p'})}\n${line('m9', 7)}\n`);
    const fourth = mcp.refreshSessions({nowMs: NOW, projectsDir: projects, indexPath});
    assert.equal(fourth[0].tokens, 7);

    fs.rmSync(root, {recursive: true, force: true});
});

test('a half-written last line is folded once the rest arrives, not twice', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-sessions-'));
    const project = path.join(root, 'projects', '-home-u-p');
    fs.mkdirSync(project, {recursive: true});
    const transcript = path.join(project, 'S2.jsonl');
    const indexPath = path.join(root, 'index.json');
    const stamp = new Date(NOW).toISOString();
    const full = JSON.stringify({
        type: 'assistant', timestamp: stamp, sessionId: 'S2', cwd: '/home/u/p',
        message: {id: 'm1', usage: {input_tokens: 40, output_tokens: 2}},
    });

    fs.writeFileSync(transcript, full.slice(0, 30)); // no trailing newline yet
    const partial = mcp.refreshSessions({
        nowMs: NOW, projectsDir: path.join(root, 'projects'), indexPath});
    assert.equal(partial.length, 0);

    fs.writeFileSync(transcript, `${full}\n`);
    const complete = mcp.refreshSessions({
        nowMs: NOW, projectsDir: path.join(root, 'projects'), indexPath});
    assert.equal(complete.length, 1);
    assert.equal(complete[0].tokens, 42);

    fs.rmSync(root, {recursive: true, force: true});
});

// ── Status line segments ────────────────────────────────────────────────────
test('the ping segment is silent when no ping was ever scheduled', () => {
    assert.equal(statusline.pingSegment({
        nowMs: NOW,
        readFile: () => {
            throw new Error('ENOENT');
        },
    }), '');
});

test('the ping segment shows the last ping when there is one', () => {
    const out = statusline.pingSegment({nowMs: NOW, readFile: () => fix.stamps[1].raw});
    assert.ok(out.includes('ping 11:00'), out);
});

test('the sessions segment names the biggest spender of the day', () => {
    const index = {
        version: 1,
        files: {
            a: {sessionId: 'A', cwd: '/home/u/small', byDay: {[mcp.localDay(NOW)]: 1000}},
            b: {sessionId: 'B', title: 'BIG', cwd: '/home/u/big', byDay: {[mcp.localDay(NOW)]: 900000}},
        },
    };
    const out = statusline.sessionsSegment({nowMs: NOW, readFile: () => JSON.stringify(index)});
    assert.ok(out.includes('BIG'), out);
    assert.ok(out.includes('900.0k'), out);
});

test('the sessions segment is silent without an index', () => {
    assert.equal(statusline.sessionsSegment({
        nowMs: NOW,
        readFile: () => {
            throw new Error('ENOENT');
        },
    }), '');
});
