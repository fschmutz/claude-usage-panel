// MCP server unit tests: token reading, fetch + error paths, rendering, and
// the JSON-RPC request handling - plus one end-to-end stdio round-trip that
// spawns the real server binary. Normalization parity with the other ports is
// asserted in parity.test.js against the shared fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
    fetchUsage,
    handleRequest,
    readAccessToken,
    renderCards,
    resetHint,
    VERSION,
} from '../mcp/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp', 'server.js');

const LIMITS_PAYLOAD = {
    limits: [
        {
            kind: 'session', percent: 26, severity: 'normal',
            resets_at: '2026-07-19T16:00:00Z', is_active: true,
        },
        {
            kind: 'weekly_scoped', percent: 91, severity: 'warning',
            resets_at: '2026-07-23T06:00:00Z', is_active: true,
            scope: {model: {display_name: 'Fable'}},
        },
    ],
};

const okFetch = (payload, status = 200) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
});

// ── resetHint ───────────────────────────────────────────────────────────────────

test('resetHint - two most significant units', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    assert.equal(resetHint('2026-07-19T15:06:00Z', now), '3h06m');
    assert.equal(resetHint('2026-07-23T14:00:00Z', now), '4d2h');
    assert.equal(resetHint('2026-07-19T12:42:00Z', now), '42m');
});

test('resetHint - empty for past, null, and garbage', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    assert.equal(resetHint('2026-07-19T11:00:00Z', now), '');
    assert.equal(resetHint(null, now), '');
    assert.equal(resetHint('not-a-date', now), '');
});

// ── renderCards ─────────────────────────────────────────────────────────────────

test('renderCards - one line per limit with severity and reset', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    const cards = [
        {label: 'Current session', percent: 26, severity: 'normal', resetsAt: '2026-07-19T16:00:00Z'},
        {label: 'Weekly · Fable', percent: 91, severity: 'warning', resetsAt: null},
    ];
    const text = renderCards(cards, now);
    assert.match(text, /\*\*Current session\*\* - 26% · resets in 4h00m/);
    assert.match(text, /\*\*Weekly · Fable\*\* - 91% · WARNING/);
});

test('renderCards - empty input explains itself', () => {
    assert.match(renderCards([]), /No plan limits/);
});

test('renderCards - a per-model card says it draws from the weekly pool', () => {
    const now = Date.parse('2026-07-26T12:00:00Z');
    const [weekly, fable] = renderCards([
        {label: 'Weekly · all models', group: 'weekly', scoped: false, percent: 28,
            severity: 'normal', resetsAt: '2026-07-28T06:00:00Z'},
        {label: 'Weekly · Fable', group: 'weekly', scoped: true, percent: 0,
            severity: 'normal', resetsAt: '2026-07-28T06:00:00Z'},
    ], now).split('\n');
    assert.equal(weekly.includes('share of the weekly all-models limit'), false);
    assert.match(fable, /share of the weekly all-models limit$/);
});

// ── readAccessToken ─────────────────────────────────────────────────────────────

const tmpHome = contents => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-mcp-'));
    if (contents !== undefined) {
        fs.mkdirSync(path.join(dir, '.claude'));
        fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), contents);
    }
    return dir;
};

test('readAccessToken - claudeAiOauth.accessToken', () => {
    const home = tmpHome(JSON.stringify({claudeAiOauth: {accessToken: 'tok-1'}}));
    assert.equal(readAccessToken({homedir: home, platform: 'linux'}), 'tok-1');
});

test('readAccessToken - top-level access_token fallback', () => {
    const home = tmpHome(JSON.stringify({access_token: 'tok-2'}));
    assert.equal(readAccessToken({homedir: home, platform: 'linux'}), 'tok-2');
});

test('readAccessToken - missing file → null (linux)', () => {
    assert.equal(readAccessToken({homedir: tmpHome(), platform: 'linux'}), null);
});

test('readAccessToken - malformed JSON → null (linux)', () => {
    const home = tmpHome('{nope');
    assert.equal(readAccessToken({homedir: home, platform: 'linux'}), null);
});

// ── fetchUsage ──────────────────────────────────────────────────────────────────

test('fetchUsage - success normalizes cards and keeps raw', async () => {
    const r = await fetchUsage({fetchImpl: okFetch(LIMITS_PAYLOAD), token: 't'});
    assert.equal(r.ok, true);
    assert.equal(r.cards.length, 2);
    assert.equal(r.cards[1].key, 'weekly_scoped:Fable');
    assert.deepEqual(r.raw, LIMITS_PAYLOAD);
});

test('fetchUsage - no token', async () => {
    const r = await fetchUsage({fetchImpl: okFetch(LIMITS_PAYLOAD), token: null});
    assert.deepEqual([r.ok, r.code], [false, 'no_token']);
});

test('fetchUsage - 401 → auth_expired', async () => {
    const r = await fetchUsage({fetchImpl: okFetch({}, 401), token: 't'});
    assert.deepEqual([r.ok, r.code], [false, 'auth_expired']);
});

test('fetchUsage - 500 → http_error', async () => {
    const r = await fetchUsage({fetchImpl: okFetch({}, 500), token: 't'});
    assert.deepEqual([r.ok, r.code, r.message], [false, 'http_error', 'HTTP 500']);
});

test('fetchUsage - network failure → network_error', async () => {
    const boom = async () => {
        throw new Error('ECONNREFUSED');
    };
    const r = await fetchUsage({fetchImpl: boom, token: 't'});
    assert.deepEqual([r.ok, r.code], [false, 'network_error']);
});

test('fetchUsage - invalid JSON body → parse_error', async () => {
    const badJson = async () => ({
        ok: true, status: 200,
        json: async () => {
            throw new Error('bad json');
        },
    });
    const r = await fetchUsage({fetchImpl: badJson, token: 't'});
    assert.deepEqual([r.ok, r.code], [false, 'parse_error']);
});

// ── handleRequest ───────────────────────────────────────────────────────────────

test('initialize - echoes a supported protocol version', async () => {
    const r = await handleRequest({
        method: 'initialize', params: {protocolVersion: '2025-03-26'},
    });
    assert.equal(r.protocolVersion, '2025-03-26');
    assert.equal(r.serverInfo.name, 'claude-usage');
    assert.equal(r.serverInfo.version, VERSION);
});

test('initialize - answers newest for an unknown version', async () => {
    const r = await handleRequest({
        method: 'initialize', params: {protocolVersion: '1999-01-01'},
    });
    assert.equal(r.protocolVersion, '2025-06-18');
});

test('ping - empty result', async () => {
    assert.deepEqual(await handleRequest({method: 'ping'}), {});
});

test('tools/list - exposes get_usage with schemas', async () => {
    const r = await handleRequest({method: 'tools/list'});
    assert.equal(r.tools.length, 1);
    const tool = r.tools[0];
    assert.equal(tool.name, 'get_usage');
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.outputSchema.required, ['limits']);
    assert.equal(tool.annotations.readOnlyHint, true);
});

// tools/call records pace samples - always point it at a throwaway history
// file so tests never pollute the real shared tmp history.
const rnd = () => Math.random().toString(36).slice(2);
const paceTmp = () => ({historyPath: path.join(os.tmpdir(), `cu-mcp-hist-${rnd()}.json`)});

test('tools/call get_usage - text + structuredContent', async () => {
    const r = await handleRequest(
        {method: 'tools/call', params: {name: 'get_usage'}},
        {fetchImpl: okFetch(LIMITS_PAYLOAD), token: 't', paceOpts: paceTmp()});
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Current session.*26%/);
    assert.equal(r.structuredContent.limits.length, 2);
    // One fresh sample can't support a projection - no pace fields yet.
    assert.equal(r.structuredContent.limits.some(l => l.pace), false);
});

test('tools/call get_usage - failure is a tool error, not a crash', async () => {
    const r = await handleRequest(
        {method: 'tools/call', params: {name: 'get_usage'}},
        {fetchImpl: okFetch({}, 401), token: 't'});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /auth_expired/);
});

test('tools/call - unknown tool → -32602', async () => {
    await assert.rejects(
        handleRequest({method: 'tools/call', params: {name: 'nope'}}),
        e => e.code === -32602);
});

test('unknown method → -32601', async () => {
    await assert.rejects(
        handleRequest({method: 'no/such'}),
        e => e.code === -32601);
});

// ── stdio end-to-end ────────────────────────────────────────────────────────────

test('stdio round-trip - initialize, initialized, tools/list', async () => {
    const proc = spawn(process.execPath, [SERVER], {stdio: ['pipe', 'pipe', 'inherit']});
    const lines = [];
    let buffer = '';
    const gotTwo = new Promise(resolve => {
        proc.stdout.on('data', chunk => {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                lines.push(JSON.parse(buffer.slice(0, nl)));
                buffer = buffer.slice(nl + 1);
            }
            if (lines.length >= 2) resolve();
        });
    });
    proc.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test'}},
    })}\n`);
    proc.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
    proc.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/list'})}\n`);
    await gotTwo;
    proc.stdin.end();
    assert.equal(lines[0].id, 1);
    assert.equal(lines[0].result.protocolVersion, '2025-06-18');
    assert.equal(lines[1].id, 2);
    assert.equal(lines[1].result.tools[0].name, 'get_usage');
});

test('stdio - pending tools/call still answers after stdin EOF', async () => {
    // HOME points at an empty dir so tools/call resolves quickly (no_token)
    // but still asynchronously - the server must drain it before exiting.
    const proc = spawn(process.execPath, [SERVER], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {...process.env, HOME: tmpHome()},
    });
    let out = '';
    proc.stdout.on('data', chunk => {
        out += chunk;
    });
    const exited = new Promise(resolve => proc.on('exit', resolve));
    proc.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'get_usage'}})}\n`);
    proc.stdin.end();
    assert.equal(await exited, 0);
    const lines = out.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, 1);
    assert.equal(lines[0].result.isError, true);
    assert.match(lines[0].result.content[0].text, /no_token/);
});

// ── Pace projection on tools/call ───────────────────────────────────────────────
import {withPace, recordHistory, forecast} from '../mcp/server.js';

test('withPace attaches pace once history supports a projection', () => {
    const NOW = 1800000000000;
    const opts = paceTmp();
    const card = {
        key: 'weekly_all', label: 'Weekly · all models', group: 'weekly', scoped: false,
        percent: 52, severity: 'normal',
        resetsAt: new Date(NOW + 20 * 3600_000).toISOString(), active: true,
    };
    // Seed 6 earlier samples 30 min apart (the call itself appends the 7th).
    for (let i = 0; i < 6; i++) {
        recordHistory([{...card, percent: 40 + 2 * i}],
            {nowMs: NOW - (6 - i) * 1800_000, historyPath: opts.historyPath});
    }
    const [out] = withPace([card], {nowMs: NOW, ...opts});
    assert.equal(out.pace.pctPerHour, 4);
    assert.equal(out.pace.exhaustsBeforeReset, true);
    assert.equal(out.pace.marginHours, -8);
    assert.equal(out.pace.projectedFullAt, new Date(NOW + 12 * 3600_000).toISOString());
});

test('withPace stays silent without enough history', () => {
    const opts = paceTmp();
    const card = {
        key: 'session', label: 'Current session', group: 'session', scoped: false,
        percent: 10, severity: 'normal', resetsAt: null, active: true,
    };
    const [out] = withPace([card], opts);
    assert.equal(out.pace, undefined);
    assert.equal(forecast([], null, 0), null);
});

test('renderCards mentions an alarming pace', () => {
    const line = renderCards([{
        label: 'Weekly · all models', group: 'weekly', scoped: false, percent: 52,
        severity: 'normal', resetsAt: '2026-08-04T06:00:00Z',
        pace: {pctPerHour: 4, projectedFullAt: '2026-08-02T08:00:00.000Z',
            exhaustsBeforeReset: true, marginHours: -8},
    }], Date.parse('2026-08-01T12:00:00Z'));
    assert.match(line, /↗ 4%\/h - ON PACE TO RUN OUT 8h before reset/);
});

// ── Warehouse-backed trend ──────────────────────────────────────────────────────
// The desktop panels write the 90-day history; the server only reads it, and
// must degrade to "no trend" rather than an error when there is no file.
import {withTrend, weekOverWeek as weekOverWeekMcp} from '../mcp/server.js';

test('withTrend attaches a week-over-week peak from the warehouse', () => {
    const now = 1800000000000;
    const day = 86_400_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-wh-'));
    const file = path.join(dir, 'history.jsonl');
    fs.writeFileSync(
        file,
        [
            JSON.stringify({t: now - 9 * day, limits: {weekly_all: 84}}),
            JSON.stringify({t: now - 1 * day, limits: {weekly_all: 71}}),
            'torn line, still writing',
        ].join('\n') + '\n');

    const [card] = withTrend([{key: 'weekly_all', percent: 71}], {nowMs: now, warehouse: file});
    assert.deepEqual(card.trend, {thisWeekPeak: 71, lastWeekPeak: 84, deltaPoints: -13});
    fs.rmSync(dir, {recursive: true, force: true});
});

test('no warehouse file means no trend, not an error', () => {
    const cards = [{key: 'session', percent: 4}];
    assert.deepEqual(
        withTrend(cards, {nowMs: Date.now(), warehouse: '/nonexistent/history.jsonl'}), cards);
    assert.equal(weekOverWeekMcp([], 'session', Date.now()), null);
});
