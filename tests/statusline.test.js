import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import os from 'node:os';
import path from 'node:path';

import {
    gauge, render, contextSegment, cardsFromStdin, limitsSegment,
    formatTokens, sumTranscriptTokens, transcriptTokens, tokensSegment, transcriptTotals,
    parseConfig, accountSegment, renderLine,
} from '../claude-code/statusline.js';
import {resetHint} from '../claude-code/stamps.js';
import {openStore} from '../claude-code/accounts.js';

// Strip ANSI so we can assert on the visible glyphs. Built via RegExp
// constructor to keep the ESC control char out of a regex literal.
const ESC = String.fromCharCode(27);
const strip = (s) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

// A cache path unique per call so token tests don't share the on-disk cache.
const rnd = () => Math.random().toString(36).slice(2);
const noCache = () => path.join(os.tmpdir(), `cus-test-${rnd()}${rnd()}.json`);

test('gauge is full at 100%, empty at 0%', () => {
    assert.match(strip(gauge(100, '')), /^█{6}$/);
    assert.match(strip(gauge(0, '')), /^░{6}$/);
    assert.equal(strip(gauge(50, '')).split('█').length - 1, 3);
});

test('gauge shows a sub-cell sliver for small non-zero values', () => {
    assert.ok(!/^░{6}$/.test(strip(gauge(4, ''))));
});

test('gauge clamps out-of-range instead of overflowing or throwing', () => {
    // >100 must not exceed the 6-cell width; negative must not throw (RangeError).
    assert.match(strip(gauge(130, '')), /^█{6}$/);
    assert.match(strip(gauge(-5, '')), /^░{6}$/);
});

test('resetHint formats the two most significant units, blank when past', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    assert.equal(resetHint(null, now), '');
    assert.equal(resetHint('2026-07-21T13:00:00Z', now), '2d1h');
    assert.equal(resetHint('2026-07-19T15:06:00Z', now), '3h06m');
    assert.equal(resetHint('2026-07-19T11:59:59Z', now), '');
});

test('contextSegment renders a gauge card, clamps, blank when absent', () => {
    assert.match(strip(contextSegment('{"context_window":{"used_percentage":8}}')),
        /^Context [█▏▎▍▌▋▊▉░]{6} 8%$/);
    assert.match(strip(contextSegment('{"context_window":{"used_percentage":73.6}}')),
        /^Context [█▏▎▍▌▋▊▉░]{6} 74%$/);
    // Over 100 / negative are clamped to the displayed value, never crash.
    assert.match(strip(contextSegment('{"context_window":{"used_percentage":130}}')),
        /^Context █{6} 100%$/);
    assert.match(strip(contextSegment('{"context_window":{"used_percentage":-5}}')),
        /^Context ░{6} 0%$/);
    assert.equal(contextSegment('{}'), '');
    assert.equal(contextSegment('not json'), '');
});

test('cardsFromStdin builds Session/Week cards from rate_limits', () => {
    const in3h = Math.floor((Date.now() + 3 * 60 * 60 * 1000) / 1000); // epoch seconds
    const in2d = Math.floor((Date.now() + 2 * 24 * 60 * 60 * 1000) / 1000);
    const cards = cardsFromStdin(JSON.stringify({
        rate_limits: {
            five_hour: {used_percentage: 14, resets_at: in3h},
            seven_day: {used_percentage: 92, resets_at: in2d},
        },
    }));
    assert.deepEqual(cards.map((c) => c.label), ['Session', 'Week']);
    assert.equal(cards[0].percent, 14);
    assert.equal(cards[0].severity, 'normal'); // local threshold
    assert.equal(cards[1].severity, 'critical'); // 92% ≥ 90
    assert.match(strip(render(cards)), /Session [█▏▎▍▌▋▊▉░]{6} 14% \dh\d{2}m/);
    assert.deepEqual(cardsFromStdin('{}'), []);
    assert.deepEqual(cardsFromStdin('not json'), []);
});

test('render draws one gauge per shown limit and a shared reset only once', () => {
    // Two cards whose resets render to the same value share one countdown.
    const base = Date.now() + 25 * 60 * 60 * 1000; // ~1d1h out
    const mk = (label, percent, ms) => ({
        key: label, kind: label, label, percent, severity: 'normal',
        resetsAt: new Date(base + ms).toISOString(), active: true,
    });
    const out = strip(render([mk('Week', 22, 1), mk('Session', 29, 400)]));
    assert.match(out, /Week [█▏▎▍▌▋▊▉░]{6} 22%  Session/); // Week has no countdown of its own
    assert.match(out, /Session [█▏▎▍▌▋▊▉░]{6} 29% 1d1h/); // shared countdown after the last
    assert.equal((out.match(/1d1h/g) || []).length, 1); // exactly once
});

test('formatTokens is compact and promotes at the unit boundary', () => {
    assert.equal(formatTokens(847), '847');
    assert.equal(formatTokens(16_700), '16.7k');
    assert.equal(formatTokens(1_240_000), '1.2M');
    assert.equal(formatTokens(999_999), '1.0M'); // must not be "1000.0k"
});

test('sumTranscriptTokens sums usage, cache reads optional, dedups by id only', () => {
    const jsonl = [
        '{"message":{"id":"a","usage":{"input_tokens":100,"output_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":1000}}}',
        '{"message":{"id":"a","usage":{"input_tokens":999,"output_tokens":999}}}', // dup id → skipped
        '{"message":{"usage":{"input_tokens":200,"output_tokens":20}}}', // no id → counted
        '{"message":{"usage":{"input_tokens":7,"output_tokens":3}}}', // no id → also counted
        'partial-while-writing', // unparseable line → skipped
    ].join('\n');
    assert.equal(sumTranscriptTokens(jsonl), 100 + 10 + 5 + 1000 + 200 + 20 + 7 + 3); // all
    assert.equal(sumTranscriptTokens(jsonl, false), 100 + 10 + 5 + 200 + 20 + 7 + 3); // no cache read
    assert.equal(sumTranscriptTokens(''), 0);
    // one pass yields both figures
    assert.deepEqual(transcriptTokens(jsonl), {all: 1345, fresh: 345});
});

// Injected transcript I/O: stat reports the real byte size, readFrom serves the
// requested byte range and counts how many bytes each call read.
function fakeFiles(files) {
    const reads = [];
    return {
        reads,
        statFile: (p) => {
            if (!(p in files)) throw new Error('ENOENT');
            const f = files[p];
            return {mtimeMs: f.mtimeMs ?? 1, size: Buffer.byteLength(f.text), ino: f.ino ?? 7};
        },
        readFrom: (p, start, end) => {
            reads.push({p, start, end});
            return Buffer.from(files[p].text).subarray(start, end);
        },
    };
}

test('tokensSegment reads transcript_path and renders ∑ N tok, blank when empty', () => {
    const jsonl = '{"message":{"id":"x","usage":{"input_tokens":16000,"output_tokens":700}}}';
    const stdin = '{"transcript_path":"/x.jsonl"}';
    const inj = (text) => ({...fakeFiles({'/x.jsonl': {text}}), cachePath: noCache()});
    assert.match(strip(tokensSegment(stdin, inj(jsonl))), /^∑ 16\.7k tok$/);
    assert.equal(tokensSegment('{}', inj(jsonl)), ''); // no transcript_path
    assert.equal(tokensSegment('not json', inj(jsonl)), '');
    assert.equal(tokensSegment(stdin, inj('')), ''); // empty transcript → 0 → blank
    // Transcript not on disk yet (stat throws) → blank, never crash.
    assert.equal(tokensSegment(stdin, {statFile: () => { throw new Error('ENOENT'); }, cachePath: noCache()}), '');
});

test('tokensSegment honors --tokens=fresh (excludes cache reads)', () => {
    const jsonl = '{"message":{"id":"y","usage":{"input_tokens":1200,"cache_read_input_tokens":500000}}}';
    const stdin = '{"transcript_path":"/y.jsonl"}';
    const base = () => fakeFiles({'/y.jsonl': {text: jsonl}});
    assert.match(strip(tokensSegment(stdin, {...base(), cachePath: noCache()})), /^∑ 501\.2k tok$/);
    assert.match(strip(tokensSegment(stdin, {...base(), includeCacheRead: false, cachePath: noCache()})),
        /^∑ 1\.2k tok$/);
});

test('transcriptTotals caches by path+mtime+size, skipping re-read when unchanged', () => {
    const cachePath = noCache();
    const io = fakeFiles({'/z.jsonl': {text: '{"message":{"id":"z","usage":{"input_tokens":10}}}\n'}});
    const a = transcriptTotals('/z.jsonl', {...io, cachePath});
    const b = transcriptTotals('/z.jsonl', {...io, cachePath}); // same signature → served from cache
    assert.deepEqual(a, b);
    assert.equal(a.all, 10);
    assert.equal(io.reads.length, 1); // transcript read once, not twice
});

const turn = (id, input, cacheRead = 0) =>
    `${JSON.stringify({message: {id, usage: {input_tokens: input, cache_read_input_tokens: cacheRead}}})}\n`;

test('transcriptTotals keeps one entry per transcript: parallel sessions do not evict each other', () => {
    const cachePath = noCache();
    const io = fakeFiles({'/a.jsonl': {text: turn('a1', 5)}, '/b.jsonl': {text: turn('b1', 9)}});
    for (let i = 0; i < 10; i++) {
        assert.equal(transcriptTotals('/a.jsonl', {...io, cachePath, nowMs: i}).all, 5);
        assert.equal(transcriptTotals('/b.jsonl', {...io, cachePath, nowMs: i}).all, 9);
    }
    assert.deepEqual(io.reads.map((r) => r.p), ['/a.jsonl', '/b.jsonl']); // one read each, ever
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals evicts the least recently used transcript past 16 entries', () => {
    const cachePath = noCache();
    const files = {};
    for (let i = 0; i < 17; i++) files[`/t${i}.jsonl`] = {text: turn(`m${i}`, i + 1)};
    const io = fakeFiles(files);
    for (let i = 0; i < 17; i++) transcriptTotals(`/t${i}.jsonl`, {...io, cachePath, nowMs: 1000 * i});
    const kept = Object.keys(JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries);
    assert.equal(kept.length, 16);
    assert.ok(!kept.includes('/t0.jsonl')); // the oldest one went
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals reads only the bytes appended since the last refresh', () => {
    const cachePath = noCache();
    const files = {'/g.jsonl': {text: turn('m1', 100, 1000) + turn('m1', 100, 1000), mtimeMs: 1}};
    const io = fakeFiles(files);
    assert.deepEqual(transcriptTotals('/g.jsonl', {...io, cachePath}), {all: 1100, fresh: 100});
    const firstEnd = Buffer.byteLength(files['/g.jsonl'].text);
    // A replay of m1 right across the offset is still deduped; m2 is new.
    files['/g.jsonl'] = {text: files['/g.jsonl'].text + turn('m1', 100, 1000) + turn('m2', 7), mtimeMs: 2};
    const t = transcriptTotals('/g.jsonl', {...io, cachePath});
    assert.deepEqual(t, transcriptTokens(files['/g.jsonl'].text)); // same as a full parse
    assert.deepEqual(t, {all: 1107, fresh: 107});
    assert.equal(io.reads[1].start, firstEnd); // the second read began where the first stopped
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals counts a trailing line once, before and after its newline lands', () => {
    const cachePath = noCache();
    const done = turn('m1', 10);
    const files = {'/p.jsonl': {text: done + turn('m2', 20).trimEnd(), mtimeMs: 1}};
    const io = fakeFiles(files);
    assert.equal(transcriptTotals('/p.jsonl', {...io, cachePath}).all, 30); // complete JSON, no newline yet
    files['/p.jsonl'] = {text: `${done + turn('m2', 20).trimEnd()}\n`, mtimeMs: 2};
    assert.equal(transcriptTotals('/p.jsonl', {...io, cachePath}).all, 30); // not double-counted
    // A half-written line is skipped, then counted once it completes.
    const half = turn('m3', 5);
    files['/p.jsonl'] = {text: files['/p.jsonl'].text + half.slice(0, 12), mtimeMs: 3};
    assert.equal(transcriptTotals('/p.jsonl', {...io, cachePath}).all, 30);
    files['/p.jsonl'] = {text: files['/p.jsonl'].text + half.slice(12), mtimeMs: 4};
    assert.equal(transcriptTotals('/p.jsonl', {...io, cachePath}).all, 35);
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals re-folds from scratch when the file shrank or was replaced', () => {
    const cachePath = noCache();
    const files = {'/r.jsonl': {text: turn('m1', 10) + turn('m2', 20), mtimeMs: 1}};
    const io = fakeFiles(files);
    assert.equal(transcriptTotals('/r.jsonl', {...io, cachePath}).all, 30);
    files['/r.jsonl'] = {text: turn('n1', 4), mtimeMs: 2}; // truncated + rewritten
    assert.equal(transcriptTotals('/r.jsonl', {...io, cachePath}).all, 4);
    // Same path, a new inode that happens to be larger: never appended to the old sum.
    files['/r.jsonl'] = {text: turn('k1', 1) + turn('k2', 2) + turn('k3', 3), mtimeMs: 3, ino: 8};
    assert.equal(transcriptTotals('/r.jsonl', {...io, cachePath}).all, 6);
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals ignores a pre-v2 single-slot cache file', () => {
    const cachePath = noCache();
    fs.writeFileSync(cachePath, JSON.stringify({sig: '/v.jsonl:1:1', all: 999, fresh: 999}));
    const io = fakeFiles({'/v.jsonl': {text: turn('m1', 3)}});
    assert.equal(transcriptTotals('/v.jsonl', {...io, cachePath}).all, 3);
    fs.rmSync(cachePath, {force: true});
});

test('transcriptTotals reads a real file incrementally through the default reader', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cus-tr-'));
    const f = path.join(dir, 't.jsonl');
    const cachePath = path.join(dir, 'cache.json');
    fs.writeFileSync(f, turn('m1', 10) + turn('é', 1)); // multi-byte id: offsets are bytes
    assert.equal(transcriptTotals(f, {cachePath}).all, 11);
    fs.appendFileSync(f, turn('m2', 100));
    assert.equal(transcriptTotals(f, {cachePath}).all, 111);
    fs.rmSync(dir, {recursive: true, force: true});
});

test('parseConfig picks segments/order and token mode, dropping unknowns', () => {
    // `ping` ships in the default list but renders nothing until session pings
    // are scheduled, so it costs an unconfigured line no width. `account` is
    // opt-in.
    assert.deepEqual(
        parseConfig([]),
        {segments: ['context', 'limits', 'tokens', 'ping'], includeCacheRead: true});
    assert.deepEqual(parseConfig(['--segments=account,limits']).segments, ['account', 'limits']);
    assert.deepEqual(parseConfig(['--segments=tokens,context']).segments, ['tokens', 'context']);
    assert.deepEqual(parseConfig(['--segments=limits,bogus,tokens']).segments, ['limits', 'tokens']);
    assert.deepEqual(
        parseConfig(['--segments=nope,']).segments, ['context', 'limits', 'tokens', 'ping']);
    assert.deepEqual(parseConfig(['--segments=sessions']).segments, ['sessions']);
    assert.equal(parseConfig(['--tokens=fresh']).includeCacheRead, false);
    assert.equal(parseConfig(['--tokens=all']).includeCacheRead, true);
});

// ── Burn-rate forecast + shared history ─────────────────────────────────────────
import fs from 'node:fs';
import {forecast, recordHistory} from '../claude-code/pace.js';
import {exhaustionMarker} from '../claude-code/statusline.js';

test('recordHistory appends per-key samples to the shared file and caps them', () => {
    const p = noCache();
    const cards = [
        {key: 'session', percent: 20},
        {key: 'weekly_all', percent: 50},
    ];
    let hist = recordHistory(cards, {nowMs: 1000, historyPath: p});
    hist = recordHistory(cards, {nowMs: 2000, historyPath: p});
    assert.deepEqual(hist.session, [[1000, 20], [2000, 20]]);
    assert.deepEqual(hist.weekly_all, [[1000, 50], [2000, 50]]);
    // Round-trips through the file, and caps at 200 samples per key.
    for (let i = 0; i < 250; i++)
        hist = recordHistory([{key: 'session', percent: 30}], {nowMs: 3000 + i, historyPath: p});
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).session.length, 200);
    // No cards: nothing to add, the file is not rewritten.
    const before = fs.statSync(p).mtimeMs;
    recordHistory([], {nowMs: 9999, historyPath: p});
    assert.equal(fs.statSync(p).mtimeMs, before);
    fs.rmSync(p, {force: true});
});

test('recordHistory survives a corrupt or unwritable history file', () => {
    const p = noCache();
    fs.writeFileSync(p, 'not json');
    const hist = recordHistory([{key: 'session', percent: 10}], {nowMs: 1, historyPath: p});
    assert.deepEqual(hist.session, [[1, 10]]);
});

test('the limits segment keys its history like the MCP server (by card key)', () => {
    const p = noCache();
    const nowMs = 1800000000000;
    const stdin = JSON.stringify({rate_limits: {
        five_hour: {used_percentage: 12, resets_at: nowMs / 1000 + 3600},
        seven_day: {used_percentage: 30, resets_at: nowMs / 1000 + 86400},
    }});
    // No live login at all: the bare card key.
    const io = {homedir: '/nonexistent', platform: 'linux', env: {}};
    assert.match(strip(limitsSegment(stdin, {nowMs, historyPath: p, io})), /^Session .*12% 1h00m  Week .*30% 1d0h$/);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))), ['session', 'weekly_all']);
    fs.rmSync(p, {force: true});
});

test('exhaustionMarker warns only for the alarming case', () => {
    assert.equal(exhaustionMarker(null), '');
    assert.equal(exhaustionMarker({exhaustsBeforeReset: false, marginHours: 4}), '');
    const m = strip(exhaustionMarker({
        exhaustsBeforeReset: true,
        projectedFullAt: '2026-08-02T03:40:00.000Z',
        marginHours: -8,
    }));
    assert.match(m, /^ ⚠full (Sun|Mon|Tue|Wed|Thu|Fri|Sat)\d{2}:\d{2}$/);
});

test('render appends the marker to the matching limit', () => {
    const NOW = 1800000000000;
    const cards = [{
        key: 'weekly_all', kind: 'weekly_all', label: 'Week', percent: 52,
        severity: 'normal', resetsAt: new Date(NOW + 20 * 3600_000).toISOString(), active: true,
    }];
    const samples = Array.from({length: 7}, (_, i) => [NOW - (6 - i) * 1800_000, 40 + 2 * i]);
    const fc = forecast(samples, cards[0].resetsAt, NOW);
    assert.equal(fc.exhaustsBeforeReset, true);
    const line = strip(render(cards, {forecasts: new Map([['weekly_all', fc]])}));
    assert.match(line, /Week .*52%.*⚠full /);
    // Without a forecast the line is unchanged.
    assert.doesNotMatch(strip(render(cards)), /⚠full/);
});

// ── account segment ─────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-09-13T12:00:00Z');
function accountWorld() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cus-acc-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({claudeAiOauth: {
        accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000}}));
    fs.writeFileSync(path.join(home, '.claude.json'),
        JSON.stringify({oauthAccount: {accountUuid: 'u-pro', emailAddress: 'pro@example.com'}}));
    return {homedir: home, platform: 'linux', env: {}, nowMs: NOW};
}
const rateLimits = (session, week) => JSON.stringify({rate_limits: {
    five_hour: {used_percentage: session, resets_at: NOW / 1000 + 3600},
    seven_day: {used_percentage: week, resets_at: NOW / 1000 + 86400},
}});

test('accountSegment never reads a token: no Keychain fork on macOS', () => {
    const io = accountWorld();
    const store = openStore({...io, nowMs: NOW});
    store.saveCurrent('PRO');
    fs.rmSync(path.join(io.homedir, '.claude', '.credentials.json')); // macOS keeps it in the Keychain
    const calls = [];
    const mac = {...io, dir: store.dir, platform: 'darwin', exec: (...a) => { calls.push(a); throw new Error('no item'); }};
    assert.equal(strip(accountSegment(rateLimits(10, 10), {io: mac, nowMs: NOW})), '[PRO]');
    assert.deepEqual(calls, []);
});

test('the limits segment files its history under the live login, like the MCP server', () => {
    const io = accountWorld();
    const p = path.join(io.homedir, 'hist.json');
    const keys = () => Object.keys(JSON.parse(fs.readFileSync(p, 'utf8'))).sort();
    limitsSegment(rateLimits(10, 20), {nowMs: NOW, historyPath: p, io});
    assert.deepEqual(keys(), ['u-pro|session', 'u-pro|weekly_all']);
    // No uuid: the email. And the account block alone - no token is read.
    fs.writeFileSync(path.join(io.homedir, '.claude.json'),
        JSON.stringify({oauthAccount: {emailAddress: 'perso@example.com'}}));
    const calls = [];
    const mac = {...io, platform: 'darwin', exec: (...a) => { calls.push(a); throw new Error('no item'); }};
    limitsSegment(rateLimits(10, 20), {nowMs: NOW, historyPath: p, io: mac});
    assert.deepEqual(keys(), ['perso@example.com|session', 'perso@example.com|weekly_all',
        'u-pro|session', 'u-pro|weekly_all']);
    assert.deepEqual(calls, []);
});

test('one throwing segment blanks only itself, never the whole line', () => {
    const segments = {
        a: () => 'A',
        boom: () => { throw new Error('corrupt file'); },
        b: () => 'B',
        empty: () => '',
    };
    assert.equal(renderLine('{}', {segments: ['a', 'boom', 'empty', 'b']}, segments), 'A  B');
});

test('accountSegment is blank for an unsaved login, and never throws', () => {
    const io = accountWorld();
    assert.equal(accountSegment(rateLimits(10, 10), {io, nowMs: NOW}), '');
    assert.equal(accountSegment('{}', {io: {homedir: '/nonexistent', platform: 'linux', env: {}}}), '');
});

test('accountSegment names the active account, and points at a freer one from the cache', () => {
    const io = accountWorld();
    const store = openStore({...io, nowMs: NOW});
    store.saveCurrent('PRO');
    assert.equal(strip(accountSegment(rateLimits(10, 10), {io, nowMs: NOW})), '[PRO]');
    store.writeProfile({version: 1, name: 'PERSO', account: {accountUuid: 'u-perso'},
        credentials: {claudeAiOauth: {accessToken: 'x', refreshToken: 'y'}}});
    store.writeUsageCache({PERSO: {ok: true, cards: [{key: 'session', percent: 20}, {key: 'weekly_all', percent: 30}]}});
    // own usage from stdin (fresh) beats the cache: at 95% here, PERSO has room
    assert.equal(strip(accountSegment(rateLimits(95, 40), {io, nowMs: NOW})), '[PRO ⇢ PERSO]');
    assert.equal(strip(accountSegment(rateLimits(50, 40), {io, nowMs: NOW})), '[PRO]');
    // a stale cache says nothing about the others
    assert.equal(strip(accountSegment(rateLimits(95, 40), {io, nowMs: NOW + 3_600_000})), '[PRO]');
    // a switch just made (by anyone) holds the hint back for the cooldown
    store.writeLastSwitch({from: 'PERSO', to: 'PRO'});
    assert.equal(strip(accountSegment(rateLimits(95, 40), {io, nowMs: NOW + 60_000})), '[PRO]');
});
