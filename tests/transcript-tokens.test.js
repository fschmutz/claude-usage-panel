// Transcript token totals (claude-code/transcript-tokens.js): the per-turn
// rule shared with the session index, the one-pass fold, and the incremental
// on-disk cache the status line reads through. tokensSegment's rendering is
// in statusline.test.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    sumTranscriptTokens, transcriptTokens, transcriptTotals, turnTokens,
} from '../claude-code/transcript-tokens.js';
import {turnTokens as indexTurnTokens} from '../mcp/sessions.js';
import {fakeFiles, noCache} from './transcript-fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sessions.json'), 'utf8'));

test('turnTokens is the session index rule: cache reads excluded, junk reads as 0', () => {
    const cases = [
        null, undefined, {},
        {input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 9000},
        {input_tokens: '7', output_tokens: 'x', cache_creation_input_tokens: null},
    ];
    assert.deepEqual(cases.map(turnTokens), [0, 0, 0, 125, 7]);
    // the MCP session index counts a turn exactly the same way
    assert.deepEqual(cases.map(turnTokens), cases.map(indexTurnTokens));
});

test('transcriptTokens agrees with the shared session fold fixture', () => {
    // Same lines, same dedupe by message id: `fresh` is what the session index
    // books across the days, `all` adds the cache reads back.
    const t = transcriptTokens(fix.fold.lines.join('\n'));
    const booked = Object.values(fix.fold.expected.byDay).reduce((a, b) => a + b, 0);
    assert.equal(t.fresh, booked);
    assert.equal(t.all, booked + 9000);
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
