// extension.js: the poll loop itself, built by the real enable() over the
// GJS stubs (tests/gjs-stub.js) - the sections it refreshes, the next poll it
// arms, the plan it shows and the notifications it sends.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';
import {TextEncoder} from 'node:util';

import {SECTION_DEADLINE_MS} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {memoryFs} from './gio-memory.js';
import {stub} from './gjs-stub.js';

// ── The poll loop itself (extension.js) ─────────────────────────────────────

const HOME = '/home/tester';
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
async function panel(t, {token = false, flags = {}, answers = null, files = {}} = {}) {
    const rec = {timers: [], notes: [], errors: [], idles: [], files};
    const encode = o => new TextEncoder().encode(JSON.stringify(o));
    if (token)
        files[`${HOME}/.claude/.credentials.json`] = JSON.stringify(CREDENTIALS);
    // The file tree, async only: a synchronous read or write anywhere in the
    // poll loop or the enable throws here (nothing may block the Shell).
    const mem = memoryFs({files});
    stub.overrides['gi://Gio'] = mem.Gio;
    stub.overrides['gi://GLib'] = {
        ...mem.GLib,
        getenv: () => null,
        get_home_dir: () => HOME,
        timeout_add_seconds: (_p, seconds, fn) => rec.timers.push({seconds, fn}),
        idle_add: (_p, fn) => rec.idles.push(fn),
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
    rec.sessionMode = {isLocked: false};
    stub.overrides['resource:///org/gnome/shell/ui/main.js'] = {
        notify: (...a) => rec.notes.push(a),
        sessionMode: rec.sessionMode,
    };
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
    return {button, rec, ext};
}

/** Swap every section for a spy; a name in `hang` never settles. */
function spyOn(button, hang = []) {
    const calls = [];
    const make = name => (...args) => {
        calls.push([name, ...args]);
        return hang.includes(name) ? new Promise(() => {}) : Promise.resolve();
    };
    button._status.refreshCost = make('cost');
    // the session group: one read per section, each under its own deadline
    const reads = {waiting: make('waiting'), pause: make('pause'), today: make('sessions')};
    button._sessionGroup = {read: kind => reads[kind](), render: () => {}, destroy: () => {}};
    button._cursor = {refresh: make('cursor')};
    button._accounts = {refresh: make('accounts'), activeName: null, destroy: () => {}};
    button._codex = {refresh: make('codex')};
    return calls;
}

test('Quit hides the panel for this login: a lock keeps it gone, a real disable clears it', async t => {
    const {button, rec, ext} = await panel(t);
    spyOn(button);
    const spawned = [];
    stub.overrides['gi://Gio'] = {Subprocess: {new: argv => spawned.push(argv)}};
    button._quit();
    assert.equal(ext._button, button, 'not torn down inside its own menu callback');
    rec.idles.splice(0).forEach(fn => fn());
    assert.equal(ext._button, null, 'gone once the callback returned');
    assert.deepEqual(spawned, [], 'never gnome-extensions disable: that outlives the login');

    rec.sessionMode.isLocked = true;
    ext.disable();
    ext.enable();
    assert.equal(ext._button, null, 'a lock / unlock does not bring it back');

    rec.sessionMode.isLocked = false;
    ext.disable();
    ext.enable();
    assert.ok(ext._button, 'the Extensions app toggle shows it again');
    spyOn(ext._button);
    ext.disable();
});

test('a poll with no login still refreshes every section', async t => {
    const {button, rec} = await panel(t, {token: false});
    const calls = spyOn(button);
    const armed = rec.timers.length;
    await button.refresh();
    assert.deepEqual(calls.map(([n]) => n).sort(),
        ['accounts', 'codex', 'cost', 'cursor', 'pause', 'sessions', 'waiting']);
    assert.deepEqual(calls.find(([n]) => n === 'accounts')[1], [], 'no live cards to report');
    assert.equal(button._status.updatedText, 'No Claude credentials found. Sign in with Claude Code.');
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
    assert.equal(calls.length, 7, 'every section was started');
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

test('the sample history notifies through the latches: once per crossing, once per pace window', async () => {
    const {SampleHistory} = await import('../claude-usage-panel@fschmutz.github.io/lib/samples.js');
    const notes = [];
    const samples = new SampleHistory({
        settings: {get_boolean: k => k === 'alerts-enabled', get_string: () => '', set_string: () => {}},
        notify: (title, body) => notes.push(body),
    });
    const card = percent => [{key: 'session', label: 'Session', percent, resetsAt: null}];
    samples.checkAlerts(card(91));
    samples.checkAlerts(card(95));
    samples.checkAlerts(card(100));
    assert.deepEqual(notes, ['Session reached 90%', 'Session reached 100%']);
    notes.length = 0;
    samples.forecasts.set('session', {
        exhaustsBeforeReset: true, marginHours: -2, pctPerHour: 10, projectedFullAt: Date.now(),
    });
    samples.checkAlerts(card(50));
    samples.checkAlerts(card(52));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^Session is on pace to run out before it resets - /);
});

test('the 90-day history loads after enable and a moved poll appends to it, never twice', async t => {
    const history = `${HOME}/.local/state/claude-usage-panel/history.jsonl`;
    const old = {t: Date.now() - 7 * 86_400_000, limits: {session: 30}};
    const files = {[history]: `${JSON.stringify(old)}\n`};
    const {button} = await panel(t, {token: true, files});
    spyOn(button);
    await button._warehouseLoaded;
    await button._warehouseWrite;
    assert.equal(button._warehouse.length, 2, 'the kept line, then the first poll');
    assert.equal(files[history].trim().split('\n').length, 2, 'the first poll was appended once');
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
    assert.match(button._status.updatedText, /^Could not resolve host - retrying/);
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
    assert.equal(button._status.updatedText, 'HTTP 403 permission_error: missing scope user:profile');
    assert.equal(button._cards.size, 0);
    button.destroy();
});
