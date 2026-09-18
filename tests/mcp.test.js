// MCP server tests: the JSON-RPC request handling over a sandbox HOME (one
// `io`, the same shape openStore takes), the tool renderers, the pace and
// trend attachments, the account tools, plus one end-to-end stdio round-trip
// that spawns the real server binary. Normalization parity with the other
// ports is asserted in parity.test.js against the shared fixture; the live
// login and the usage fetch are the store's (accounts.test.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {handleRequest, VERSION} from '../mcp/server.js';
import {renderCards} from '../mcp/tools.js';
import {withPace, recordHistory, forecast} from '../claude-code/pace.js';
import {warehouseAccount, withTrend, weekOverWeek} from '../mcp/warehouse.js';
import {openStore} from '../claude-code/accounts.js';
import {sandboxHome, writeLiveLogin} from './helpers.js';

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

const NOW = Date.parse('2026-09-13T12:00:00Z');
const creds = (tag) => ({claudeAiOauth: {
    accessToken: `at-${tag}`, refreshToken: `rt-${tag}`,
    expiresAt: NOW + 3_600_000, refreshTokenExpiresAt: NOW + 30 * 86_400_000, subscriptionType: 'max',
}});
const account = (tag) => ({accountUuid: `u-${tag}`, emailAddress: `${tag}@example.com`});

// A sandbox HOME holding a live login (or none), as the io the server takes.
function world(t, {live = 'pro', fetchImpl = okFetch(LIMITS_PAYLOAD)} = {}) {
    const io = {...sandboxHome(t, {prefix: 'cu-mcp-'}), nowMs: NOW, exec: () => 'claude\n', fetchImpl};
    if (live) writeLiveLogin(io.home, creds(live), account(live));
    return io;
}

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

test('renderCards mentions an alarming pace', () => {
    const line = renderCards([{
        label: 'Weekly · all models', group: 'weekly', scoped: false, percent: 52,
        severity: 'normal', resetsAt: '2026-08-04T06:00:00Z',
        pace: {pctPerHour: 4, projectedFullAt: '2026-08-02T08:00:00.000Z',
            exhaustsBeforeReset: true, marginHours: -8},
    }], Date.parse('2026-08-01T12:00:00Z'));
    assert.match(line, /↗ 4%\/h - ON PACE TO RUN OUT 8h before reset/);
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

test('tools/list - exposes get_usage (with schemas) and the account tools', async () => {
    const r = await handleRequest({method: 'tools/list'});
    assert.deepEqual(r.tools.map(t => t.name), ['get_usage', 'list_accounts', 'save_account', 'switch_account']);
    const tool = r.tools[0];
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.outputSchema.required, ['limits']);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(r.tools[1].annotations.readOnlyHint, true);
    assert.equal(r.tools[3].annotations.readOnlyHint, false);
    assert.equal(r.tools[3].annotations.destructiveHint, false);
});

test('tools/call get_usage - text + structuredContent, from the live login', async (t) => {
    const io = world(t);
    const r = await handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, io);
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Current session.*26%/);
    assert.equal(r.structuredContent.limits.length, 2);
    assert.equal(r.structuredContent.limits[1].key, 'weekly_scoped:Fable');
    // One fresh sample can't support a projection - no pace fields yet.
    assert.equal(r.structuredContent.limits.some(l => l.pace), false);
    // vsClock needs no history: the session card carries it from the first call.
    assert.equal(typeof r.structuredContent.limits[0].vsClock, 'object');
    // An unsaved login reports account: null
    assert.equal(r.structuredContent.account, null);
    assert.doesNotMatch(r.content[0].text, /^Account:/);
});

test('tools/call get_usage - every fetch failure is a tool error, not a crash', async (t) => {
    for (const [status, code] of [[401, 'auth_expired'], [500, 'http_error']]) {
        const io = world(t, {fetchImpl: okFetch({}, status)});
        const r = await handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, io);
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, new RegExp(`^${code}:`));
    }
    const io = world(t, {live: null});
    const r = await handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, io);
    assert.match(r.content[0].text, /^no_token: No Claude credentials found/);
});

test('get_usage follows CLAUDE_CONFIG_DIR like the account store', async (t) => {
    const io = world(t, {live: null});
    const cfg = path.join(io.home, 'alt');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, '.credentials.json'), JSON.stringify(creds('cfg')));
    io.env = {CLAUDE_CONFIG_DIR: cfg};
    const r = await handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, io);
    assert.equal(r.isError, undefined);
    assert.equal(r.structuredContent.limits.length, 2);
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

test('stdio - pending tools/call still answers after stdin EOF', async (t) => {
    // HOME points at an empty dir so tools/call resolves quickly (no_token)
    // but still asynchronously - the server must drain it before exiting.
    const proc = spawn(process.execPath, [SERVER], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {...process.env, HOME: sandboxHome(t).home, CLAUDE_CONFIG_DIR: ''},
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

// ── Pace projection ─────────────────────────────────────────────────────────────
// tools/call records pace samples - always point it at a throwaway history
// file so tests never pollute the real shared tmp history.
const rnd = () => Math.random().toString(36).slice(2);
const paceTmp = () => ({historyPath: path.join(os.tmpdir(), `cu-mcp-hist-${rnd()}.json`)});

test('withPace attaches pace once history supports a projection', () => {
    const now = 1800000000000;
    const opts = paceTmp();
    const card = {
        key: 'weekly_all', label: 'Weekly · all models', group: 'weekly', scoped: false,
        percent: 52, severity: 'normal',
        resetsAt: new Date(now + 20 * 3600_000).toISOString(), active: true,
    };
    // Seed 6 earlier samples 30 min apart (the call itself appends the 7th).
    for (let i = 0; i < 6; i++) {
        recordHistory([{...card, percent: 40 + 2 * i}],
            {nowMs: now - (6 - i) * 1800_000, historyPath: opts.historyPath});
    }
    const [out] = withPace([card], {nowMs: now, ...opts});
    assert.equal(out.pace.pctPerHour, 4);
    assert.equal(out.pace.exhaustsBeforeReset, true);
    assert.equal(out.pace.marginHours, -8);
    assert.equal(out.pace.projectedFullAt, new Date(now + 12 * 3600_000).toISOString());
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

test('get_usage records its samples in the io tmpdir and projects from them', async (t) => {
    const io = world(t);
    const call = (nowMs) => handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, {...io, nowMs});
    for (let i = 0; i < 6; i++) {
        io.fetchImpl = okFetch({limits: [{kind: 'weekly_all', percent: 40 + 2 * i, severity: 'normal',
            resets_at: new Date(NOW + 20 * 3600_000).toISOString(), is_active: true}]});
        await call(NOW - (6 - i) * 1800_000);
    }
    io.fetchImpl = okFetch({limits: [{kind: 'weekly_all', percent: 52, severity: 'normal',
        resets_at: new Date(NOW + 20 * 3600_000).toISOString(), is_active: true}]});
    const r = await call(NOW);
    assert.equal(r.structuredContent.limits[0].pace.pctPerHour, 4);
    assert.ok(fs.existsSync(path.join(io.home, 'claude-usage-history.json')), 'history lives in the sandbox');
});

// ── Warehouse-backed trend ──────────────────────────────────────────────────────
// The desktop panels write the 90-day history; the server only reads it, and
// must degrade to "no trend" rather than an error when there is no file.

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
            JSON.stringify({t: now - 2 * day, a: 'u-other', limits: {weekly_all: 100}}),
            JSON.stringify({t: now - 2 * day, a: 'u-mine', limits: {weekly_all: 12}}),
            'torn line, still writing',
        ].join('\n') + '\n');

    // No account known: the untagged rows, never a login's own.
    const [card] = withTrend([{key: 'weekly_all', percent: 71}], {nowMs: now, warehouse: file});
    assert.deepEqual(card.trend, {thisWeekPeak: 71, lastWeekPeak: 84, deltaPoints: -13});
    // One login's rows: the other login's 100% is not its peak.
    const [mine] = withTrend([{key: 'weekly_all', percent: 12}],
        {nowMs: now, warehouse: file, account: 'u-mine'});
    assert.deepEqual(mine.trend, {thisWeekPeak: 12, lastWeekPeak: null, deltaPoints: null});
    assert.equal(warehouseAccount({accountUuid: 'u-1', emailAddress: 'a@x'}), 'u-1');
    assert.equal(warehouseAccount({emailAddress: 'a@x'}), 'a@x');
    assert.equal(warehouseAccount(null), null);
    fs.rmSync(dir, {recursive: true, force: true});
});

test('no warehouse file means no trend, not an error', () => {
    const cards = [{key: 'session', percent: 4}];
    assert.deepEqual(
        withTrend(cards, {nowMs: Date.now(), warehouse: '/nonexistent/history.jsonl'}), cards);
    assert.equal(weekOverWeek([], 'session', Date.now()), null);
});

test('get_usage reads the trend from the warehouse under the io state dir', async (t) => {
    const io = world(t);
    const day = 86_400_000;
    const wh = path.join(io.home, '.local', 'state', 'claude-usage-panel', 'history.jsonl');
    fs.mkdirSync(path.dirname(wh), {recursive: true});
    // Filed under the live login (u-pro); another login's rows and pre-1.13
    // untagged rows are not this account's peak.
    fs.writeFileSync(wh, [
        JSON.stringify({t: NOW - 9 * day, a: 'u-pro', limits: {session: 84}}),
        JSON.stringify({t: NOW - 1 * day, a: 'u-pro', limits: {session: 26}}),
        JSON.stringify({t: NOW - 1 * day, a: 'u-perso', limits: {session: 100}}),
        JSON.stringify({t: NOW - 1 * day, limits: {session: 99}}),
    ].join('\n') + '\n');
    const r = await handleRequest({method: 'tools/call', params: {name: 'get_usage'}}, io);
    assert.deepEqual(r.structuredContent.limits[0].trend, {thisWeekPeak: 26, lastWeekPeak: 84, deltaPoints: -58});
});

// ── Named accounts ──────────────────────────────────────────────────────────────
// The tools sit on the store bound to the same io (the store's own behavior is
// covered in accounts.test.js).

test('save_account / list_accounts / switch_account round-trip through the server', async (t) => {
    const io = world(t, {fetchImpl: async (url, init) => ({ok: true, status: 200, json: async () => ({limits: [
        {kind: 'session', percent: init.headers.authorization.endsWith('perso') ? 20 : 95,
            severity: 'normal', resets_at: '2026-09-13T16:00:00Z', is_active: true},
    ]})})});
    const store = openStore(io);
    const call = (name, args) => handleRequest({method: 'tools/call', params: {name, arguments: args}}, io);

    let r = await call('list_accounts');
    assert.match(r.content[0].text, /No saved accounts yet/);
    assert.deepEqual(r.structuredContent, {active: null, accounts: []});

    r = await call('save_account', {name: 'PRO'});
    assert.match(r.content[0].text, /Saved the current login as \*\*PRO\*\* \(pro@example.com\)/);
    assert.deepEqual(r.structuredContent, {name: 'PRO', email: 'pro@example.com', plan: 'max'});

    r = await call('save_account', {name: 'bad name'});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /invalid name/);

    store.writeProfile({version: 1, name: 'PERSO', account: account('perso'), credentials: creds('perso')});

    r = await call('list_accounts');
    assert.equal(r.structuredContent.active, 'PRO');
    const rows = r.structuredContent.accounts;
    assert.deepEqual(rows.map(a => [a.name, a.active, a.tokenState]), [['PERSO', false, 'valid'], ['PRO', true, 'valid']]);
    assert.equal(rows[0].limits[0].percent, 20);
    assert.equal(rows[1].limits[0].percent, 95);
    assert.match(r.content[0].text, /● \*\*PRO\*\*.*Current session 95%/);
    assert.match(r.content[0].text, /○ \*\*PERSO\*\*.*Current session 20%/);

    // get_usage now says which saved account the numbers are for
    r = await call('get_usage');
    assert.deepEqual(r.structuredContent.account, {name: 'PRO', email: 'pro@example.com', plan: 'max'});
    assert.match(r.content[0].text, /^Account: \*\*PRO\*\* \(pro@example.com, max\)/);

    r = await call('switch_account', {name: 'PERSO'});
    assert.equal(r.isError, undefined);
    assert.match(r.content[0].text, /Switched PRO → \*\*PERSO\*\* \(perso@example.com\)\. 1 Claude Code session is still running/);
    assert.equal(r.structuredContent.changed, true);
    assert.equal(store.liveAccountName(), 'PERSO');

    r = await call('switch_account', {name: 'PERSO'});
    assert.match(r.content[0].text, /already the current login/);
    r = await call('switch_account', {name: 'NOPE'});
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no saved account named NOPE/);
});
