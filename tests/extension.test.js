// extension.js: the poll loop itself, built by the real enable() over the
// GJS stubs (tests/gjs-stub.js) - the sections it refreshes, the next poll it
// arms, the plan it shows and the notifications it sends.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';
import {TextEncoder} from 'node:util';

import {SECTION_DEADLINE_MS} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {stub} from './gjs-stub.js';

// ── The poll loop itself (extension.js) ─────────────────────────────────────

const USAGE = {limits: [{kind: 'session', percent: 42, severity: 'normal', is_active: true}]};
const CREDENTIALS = {claudeAiOauth: {
    accessToken: 'tok', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
}};

/**
 * The panel button, built by the real enable() over stubs: a login that is
 * there or not (`token`), a usage endpoint answering `usage`, a settings
 * object answering `flags`. Returns the button once its first poll settled,
 * with every armed poll timer, notification and logged error recorded.
 */
async function panel(t, {token = false, flags = {}, answers = null} = {}) {
    const rec = {timers: [], notes: [], errors: []};
    const encode = o => new TextEncoder().encode(JSON.stringify(o));
    stub.overrides['gi://GLib'] = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        getenv: () => null,
        get_home_dir: () => '/nonexistent',
        build_filenamev: parts => parts.join('/'),
        file_get_contents: path => {
            if (token && path.endsWith('/.credentials.json'))
                return [true, encode(CREDENTIALS)];
            throw new Error('no such file');
        },
        timeout_add_seconds: (_p, seconds, fn) => rec.timers.push({seconds, fn}),
        Source: {remove: () => {}},
    };
    // `answers` scripts the endpoint, one entry per poll (the last repeats):
    // {status, body, headers} or {error} for a request that never completed.
    let answer = {status: 200, body: USAGE, headers: {}};
    const nextAnswer = () => {
        if (answers?.length)
            answer = answers.length > 1 ? answers.shift() : answers[0];
        return answer;
    };
    class Session {
        set_user_agent() {}

        abort() {}

        send_and_read_async(m, _p, _c, cb) {
            m.answer = nextAnswer();
            cb(this, m);
        }

        send_and_read_finish(m) {
            if (m.answer.error)
                throw new Error(m.answer.error);
            return {get_data: () => encode(m.answer.body)};
        }
    }
    stub.overrides['gi://Soup'] = {
        Session,
        Message: {
            new: () => {
                const m = {
                    request_headers: {append: () => {}},
                    get_status: () => m.answer?.status ?? 200,
                    get_response_headers: () => ({get_one: k => m.answer?.headers?.[k] ?? null}),
                };
                return m;
            },
        },
    };
    stub.overrides['resource:///org/gnome/shell/ui/main.js'] = {notify: (...a) => rec.notes.push(a)};
    globalThis.logError = (e, msg) => rec.errors.push(msg);
    t.after(() => {
        stub.overrides = {};
        delete globalThis.logError;
    });

    const settings = {
        get_boolean: k => flags[k] ?? false,
        get_int: () => 600,
        get_string: () => '',
        set_string: () => {},
        connectObject: () => {},
        disconnectObject: () => {},
    };
    const {default: Extension} = await import('../claude-usage-panel@fschmutz.github.io/extension.js');
    const ext = new Extension();
    Object.assign(ext, {uuid: 'test@x', metadata: {}, getSettings: () => settings});
    ext.enable();
    const button = ext._button;
    while (button._refreshing)
        await new Promise(r => setImmediate(r));
    return {button, rec};
}

/** Swap every section for a spy; a name in `hang` never settles. */
function spyOn(button, hang = []) {
    const calls = [];
    const make = name => (...args) => {
        calls.push([name, ...args]);
        return hang.includes(name) ? new Promise(() => {}) : Promise.resolve();
    };
    button._refreshCost = make('cost');
    button._waiting = {refresh: make('waiting'), destroy: () => {}};
    button._sessions = {refresh: make('sessions'), destroy: () => {}};
    button._cursor = {refresh: make('cursor')};
    button._accounts = {refresh: make('accounts'), activeName: null, destroy: () => {}};
    button._codex = {refresh: make('codex')};
    return calls;
}

test('a poll with no login still refreshes every section', async t => {
    const {button, rec} = await panel(t, {token: false});
    const calls = spyOn(button);
    const armed = rec.timers.length;
    await button.refresh();
    assert.deepEqual(calls.map(([n]) => n).sort(),
        ['accounts', 'codex', 'cost', 'cursor', 'sessions', 'waiting']);
    assert.deepEqual(calls.find(([n]) => n === 'accounts')[1], [], 'no live cards to report');
    assert.equal(button._updatedLabel.text, 'No Claude credentials found. Sign in with Claude Code.');
    assert.equal(rec.timers.length, armed + 1, 'the next poll is armed');
    button.destroy();
});

test('a section that hangs does not stop the next poll being armed', async t => {
    const {button, rec} = await panel(t, {token: true});
    const calls = spyOn(button, ['cost']);
    const warn = t.mock.method(console, 'warn', () => {});
    // A recording fake for the section deadlines only (MockTimers is still
    // experimental on Node 22 and warns); every other timer runs for real.
    const {setTimeout: realSet, clearTimeout: realClear} = globalThis;
    const deadlines = new Map();
    let nextDeadline = 0;
    globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms !== SECTION_DEADLINE_MS)
            return realSet(fn, ms, ...args);
        deadlines.set(++nextDeadline, fn);
        return `deadline-${nextDeadline}`;
    };
    globalThis.clearTimeout = h => {
        if (typeof h === 'string' && h.startsWith('deadline-'))
            deadlines.delete(Number(h.slice('deadline-'.length)));
        else
            realClear(h);
    };
    t.after(() => {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
    });
    const armed = rec.timers.length;
    let done = false;
    const polling = button.refresh().then(() => { done = true; });
    for (let i = 0; i < 20; i++)
        await new Promise(r => setImmediate(r));
    assert.equal(done, false, 'still waiting on the hung section');
    assert.equal(calls.length, 6, 'every section was started');
    assert.equal(deadlines.size, 1, 'only the hung section is still under its deadline');
    for (const fire of deadlines.values())
        fire();
    await polling;
    assert.equal(rec.timers.length, armed + 1, 'the next poll is armed');
    assert.equal(button._refreshing, false, 'the next poll can run');
    assert.deepEqual(warn.mock.calls.map(c => c.arguments[0]),
        ['claude-usage-panel: the cost section is still refreshing, polling on']);
    button.destroy();
});

test('a good poll shows the plan the live credentials name', async t => {
    const {button} = await panel(t, {token: true});
    spyOn(button);
    const plans = [];
    button._header.setPlan = p => plans.push(p);
    await button.refresh();
    assert.deepEqual(plans, ['Max 20x']);
    button.destroy();
});

test('the panel notifies through the latches: once per crossing, once per pace window', async t => {
    const {button, rec} = await panel(t, {flags: {'alerts-enabled': true}});
    rec.notes.length = 0;
    const card = percent => [{key: 'session', label: 'Session', percent, resetsAt: null}];
    button._checkAlerts(card(91));
    button._checkAlerts(card(95));
    button._checkAlerts(card(100));
    assert.deepEqual(rec.notes.map(([, body]) => body), ['Session reached 90%', 'Session reached 100%']);
    rec.notes.length = 0;
    button._forecasts.set('session', {
        exhaustsBeforeReset: true, marginHours: -2, pctPerHour: 10, projectedFullAt: Date.now(),
    });
    button._checkAlerts(card(50));
    button._checkAlerts(card(52));
    assert.equal(rec.notes.length, 1);
    assert.match(rec.notes[0][1], /^Session is on pace to run out before it resets - /);
    button.destroy();
});

// ── A failed poll with cards already on screen ──────────────────────────────

const SOON = () => new Date(Date.now() + 3_600_000).toISOString();

test('a dropped connection keeps the last cards up and retries soon, like a 429', async t => {
    const good = {status: 200, body: {limits: [
        {kind: 'session', percent: 42, severity: 'normal', resets_at: SOON(), is_active: true},
    ]}};
    const {button, rec} = await panel(t, {token: true, answers: [good, {error: 'Could not resolve host'}]});
    spyOn(button);
    await button.refresh();
    assert.equal(button._cards.size, 1, 'the card stays up');
    assert.equal(button._panelLabel.text.endsWith('42%'), true);
    assert.match(button._updatedLabel.text, /^Could not resolve host - retrying/);
    assert.equal(rec.timers.at(-1).seconds, 60, 'retried in a minute, not at the 10-minute base');
    button.destroy();
});

test('consecutive 429s back off and honour Retry-After', async t => {
    const good = {status: 200, body: {limits: [
        {kind: 'session', percent: 42, severity: 'normal', resets_at: SOON(), is_active: true},
    ]}};
    const busy = {status: 429, body: {error: {type: 'rate_limit_error'}}, headers: {}};
    const later = {status: 429, body: null, headers: {'Retry-After': '600'}};
    const {button, rec} = await panel(t, {token: true, answers: [good, busy, busy, later]});
    spyOn(button);
    await button.refresh();
    assert.equal(rec.timers.at(-1).seconds, 60);
    await button.refresh();
    assert.equal(rec.timers.at(-1).seconds, 120, 'the second failure in a row doubles it');
    await button.refresh();
    assert.equal(rec.timers.at(-1).seconds, 600, 'the server asked for ten minutes');
    button.destroy();
});

test('a window that resets during a 429 turns to the dash without waiting for a success', async t => {
    const resetsAt = new Date(Date.now() + 2_000).toISOString();
    const stale = {status: 200, body: {limits: [
        {kind: 'session', percent: 96, severity: 'critical', resets_at: resetsAt, is_active: true},
    ]}};
    const busy = {status: 429, body: null, headers: {}};
    const {button} = await panel(t, {token: true, answers: [stale, busy]});
    spyOn(button);
    assert.equal(button._panelLabel.text.endsWith('96%'), true);
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    t.after(() => { Date.now = realNow; });
    await button.refresh();
    assert.equal(button._panelLabel.text.endsWith('–'), true, button._panelLabel.text);
    button.destroy();
});

test('a 403 is its own failure: the server words, no refresh hint, cards blanked', async t => {
    const good = {status: 200, body: USAGE};
    const refused = {status: 403, body: {error: {type: 'permission_error', message: 'missing scope user:profile'}}};
    const {button} = await panel(t, {token: true, answers: [good, refused]});
    spyOn(button);
    await button.refresh();
    assert.equal(button._updatedLabel.text, 'HTTP 403 permission_error: missing scope user:profile');
    assert.equal(button._cards.size, 0);
    button.destroy();
});
