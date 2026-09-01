import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
    gauge, resetHint, render, contextSegment, cardsFromStdin,
    formatTokens, sumTranscriptTokens, tokensSegment, transcriptTotals, parseConfig,
} from '../claude-code/statusline.js';

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
    assert.equal(resetHint(null), '');
    const future = Date.now() + 2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
    assert.equal(resetHint(new Date(future).toISOString()), ' 2d1h');
    assert.equal(resetHint(new Date(Date.now() - 1000).toISOString()), '');
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
        kind: label, label, percent, severity: 'normal',
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
});

test('tokensSegment reads transcript_path and renders ∑ N tok, blank when empty', () => {
    const jsonl = '{"message":{"id":"x","usage":{"input_tokens":16000,"output_tokens":700}}}';
    const stdin = '{"transcript_path":"/x.jsonl"}';
    const inj = (text) => ({statFile: () => ({mtimeMs: 1, size: 1}), readFile: () => text, cachePath: noCache()});
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
    const base = {statFile: () => ({mtimeMs: 1, size: 1}), readFile: () => jsonl};
    assert.match(strip(tokensSegment(stdin, {...base, cachePath: noCache()})), /^∑ 501\.2k tok$/);
    assert.match(strip(tokensSegment(stdin, {...base, includeCacheRead: false, cachePath: noCache()})),
        /^∑ 1\.2k tok$/);
});

test('transcriptTotals caches by path+mtime+size, skipping re-read when unchanged', () => {
    const cachePath = noCache();
    let reads = 0;
    const opts = {
        statFile: () => ({mtimeMs: 42, size: 99}),
        readFile: () => { reads++; return '{"message":{"id":"z","usage":{"input_tokens":10}}}'; },
        cachePath,
    };
    const a = transcriptTotals('/z.jsonl', opts);
    const b = transcriptTotals('/z.jsonl', opts); // same signature → served from cache
    assert.deepEqual(a, b);
    assert.equal(a.all, 10);
    assert.equal(reads, 1); // transcript read once, not twice
});

test('parseConfig picks segments/order and token mode, dropping unknowns', () => {
    // `ping` ships in the default list but renders nothing until session pings
    // are scheduled, so it costs an unconfigured line no width.
    assert.deepEqual(
        parseConfig([]),
        {segments: ['context', 'limits', 'tokens', 'ping'], includeCacheRead: true});
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
import {forecast, recordHistory, exhaustionMarker} from '../claude-code/statusline.js';

test('recordHistory appends per-kind samples to the shared file and caps them', () => {
    const p = noCache();
    const cards = [
        {kind: 'session', percent: 20},
        {kind: 'weekly_all', percent: 50},
    ];
    let hist = recordHistory(cards, {nowMs: 1000, historyPath: p});
    hist = recordHistory(cards, {nowMs: 2000, historyPath: p});
    assert.deepEqual(hist.session, [[1000, 20], [2000, 20]]);
    assert.deepEqual(hist.weekly_all, [[1000, 50], [2000, 50]]);
    // Round-trips through the file, and caps at 200 samples per kind.
    for (let i = 0; i < 250; i++)
        hist = recordHistory([{kind: 'session', percent: 30}], {nowMs: 3000 + i, historyPath: p});
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).session.length, 200);
    fs.rmSync(p, {force: true});
});

test('recordHistory survives a corrupt or unwritable history file', () => {
    const p = noCache();
    fs.writeFileSync(p, 'not json');
    const hist = recordHistory([{kind: 'session', percent: 10}], {nowMs: 1, historyPath: p});
    assert.deepEqual(hist.session, [[1, 10]]);
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
        kind: 'weekly_all', label: 'Week', percent: 52,
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
