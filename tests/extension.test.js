// extension.js: the poll loop itself, built by the real enable() over the
// GJS stubs (tests/gjs-stub.js) - the sections it refreshes, the next poll it
// arms, the plan it shows and the notifications it sends.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';
import {TextEncoder} from 'node:util';

import {SECTION_DEADLINE_MS} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {load, stub} from './gjs-stub.js';

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
async function panel(t, {token = false, flags = {}} = {}) {
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
    class Session {
        set_user_agent() {}

        abort() {}

        send_and_read_async(_m, _p, _c, cb) {
            cb(this, null);
        }

        send_and_read_finish() {
            return {get_data: () => encode(USAGE)};
        }
    }
    stub.overrides['gi://Soup'] = {
        Session,
        Message: {new: () => ({request_headers: {append: () => {}}, get_status: () => 200})},
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
    const {default: Extension} = await load('extension.js');
    const ext = new Extension();
    Object.assign(ext, {uuid: 'test@x', metadata: {}, getSettings: () => settings});
    ext.enable();
    const button = ext._button;
    while (button._refreshing)
        await new Promise(r => setImmediate(r));
    return {button, rec};
}

/** Swap the four sections for spies; a name in `hang` never settles. */
function spyOn(button, hang = []) {
    const calls = [];
    const make = name => (...args) => {
        calls.push([name, ...args]);
        return hang.includes(name) ? new Promise(() => {}) : Promise.resolve();
    };
    button._refreshCost = make('cost');
    button._sessions = {refresh: make('sessions'), destroy: () => {}};
    button._cursor = {refresh: make('cursor')};
    button._accounts = {refresh: make('accounts'), activeName: null};
    return calls;
}

test('a poll with no login still refreshes the accounts, sessions, Cursor and cost', async t => {
    const {button, rec} = await panel(t, {token: false});
    const calls = spyOn(button);
    const armed = rec.timers.length;
    await button.refresh();
    assert.deepEqual(calls.map(([n]) => n).sort(), ['accounts', 'cost', 'cursor', 'sessions']);
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
    assert.equal(calls.length, 4);
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
