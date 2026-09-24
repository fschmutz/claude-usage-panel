// The GNOME extension's poll-side behavior: the two notification latches
// (pinned with Swift by tests/fixtures/alerts.json), the section refresh that
// runs after every poll, and the GJS I/O around it - run() with its timeout,
// the Cursor section's keyring gate, the plan label and the translated
// errors. The GJS files are loaded under plain node through a module hook
// that answers gi://, resource:/// and 'gettext' with scriptable stubs; each
// test installs the few GObject members it exercises.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {registerHooks} from 'node:module';
import {setImmediate} from 'node:timers';
import {URL} from 'node:url';
import {TextEncoder} from 'node:util';

import {
    ALERT_REARM_BELOW, latchCrossings, latchPaceAlerts, refreshSections, sectionCards,
    SECTION_DEADLINE_MS,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const EXT = new URL('../claude-usage-panel@fschmutz.github.io/', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/alerts.json', import.meta.url), 'utf8'));

// ── GJS stubs ───────────────────────────────────────────────────────────────
// A namespace member nobody overrode is a class that constructs, can be
// extended, called, and read any property of - enough for a widget tree to
// build. What a test cares about it sets in `stub.overrides`.
// Never a thenable: `await widget` must not wait forever on a stub `then`.
const opaque = prop => typeof prop !== 'string' || prop === 'then';

function anything(name) {
    const cache = new Map();
    class Widget {
        constructor(...args) {
            const self = new Proxy(this, {
                get: (target, prop, receiver) => {
                    if (!(prop in target) && !opaque(prop))
                        target[prop] = anything(`${name}().${prop}`);
                    return Reflect.get(target, prop, receiver);
                },
            });
            self._init(...args);
            return self;
        }

        _init(props = {}) {
            Object.assign(this, props);
        }

        destroy() {}

        // GObject out-parameters come back as arrays: [x, y] = get_position().
        * [Symbol.iterator]() {
            yield* [0, 0, 0];
        }
    }
    return new Proxy(Widget, {
        get: (target, prop, receiver) => {
            if (prop in target)
                return Reflect.get(target, prop, receiver);
            if (opaque(prop))
                return undefined;
            if (!cache.has(prop))
                cache.set(prop, anything(`${name}.${prop}`));
            return cache.get(prop);
        },
        apply: () => new Widget(),
    });
}

// Always true, whatever a test overrides: registerClass hands the class back.
const BASE = {
    'gi://GObject': {registerClass: (meta, klass) => klass ?? meta},
};

const stub = {
    overrides: {},
    gettext: s => s,
    ngettext: (one, many, n) => (n === 1 ? one : many),
    namespace(module) {
        const fallback = anything(module);
        return new Proxy({}, {
            get: (_t, prop) => stub.overrides[module]?.[prop] ?? BASE[module]?.[prop] ?? fallback[prop],
        });
    },
};
globalThis.gjsStub = stub;

// GJS adds String.prototype.format (printf-style); the files under test use it.
if (!String.prototype.format) {
    Object.defineProperty(String.prototype, 'format', {
        value(...args) {
            let i = 0;
            return this.replace(/%(%|[sd])/g, (_m, c) => (c === '%' ? '%' : String(args[i++])));
        },
    });
}

const NAMED = {
    'resource:///org/gnome/shell/ui/popupMenu.js': ['PopupBaseMenuItem', 'PopupMenu', 'PopupMenuItem'],
    'resource:///org/gnome/shell/ui/main.js': ['notify', 'layoutManager', 'panel'],
    'resource:///org/gnome/shell/ui/panelMenu.js': ['Button'],
};

function stubSource(specifier) {
    if (specifier === 'gettext') {
        return `export default {domain: d => (globalThis.gjsStub.domain = d, {
            gettext: s => globalThis.gjsStub.gettext(s),
            ngettext: (a, b, n) => globalThis.gjsStub.ngettext(a, b, n),
        })};`;
    }
    if (specifier.endsWith('/extensions/extension.js')) {
        return `export const gettext = s => globalThis.gjsStub.gettext(s);
            export const ngettext = (a, b, n) => globalThis.gjsStub.ngettext(a, b, n);
            export const Extension = class {};`;
    }
    const ns = `globalThis.gjsStub.namespace(${JSON.stringify(specifier)})`;
    // Functions forward at call time, so a test can swap Main.notify after load.
    const named = (NAMED[specifier] ?? []).map(n => (n === 'notify'
        ? `export const notify = (...a) => ${ns}.notify(...a);`
        : `export const ${n} = ${ns}.${n};`)).join('\n');
    return `export default ${ns};\n${named}`;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'gettext' || specifier.startsWith('gi://') || specifier.startsWith('resource:///'))
            return {url: `gjs-stub:${encodeURIComponent(specifier)}`, shortCircuit: true};
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url.startsWith('gjs-stub:')) {
            const specifier = decodeURIComponent(url.slice('gjs-stub:'.length));
            return {format: 'module', source: stubSource(specifier), shortCircuit: true};
        }
        return nextLoad(url, context);
    },
});

const load = rel => import(new URL(rel, EXT).href);

// ── The notification latches ────────────────────────────────────────────────

test('the threshold latch matches the shared fixture', () => {
    for (const c of fixture.thresholds) {
        const fired = new Map();
        c.polls.forEach((cards, i) => {
            const got = latchCrossings(fired, cards).map(({card, threshold}) => ({key: card.key, threshold}));
            assert.deepEqual(got, c.expected[i], `${c.name}, poll ${i}`);
        });
    }
});

test('the threshold latch re-arms at the same line as Swift AlertLatch.rearmBelow', () => {
    const swift = fs.readFileSync(
        new URL('../macos/Sources/ClaudeUsageCore/EventHooks.swift', import.meta.url), 'utf8');
    assert.equal(Number(/static let rearmBelow = (\d+)/.exec(swift)?.[1]), ALERT_REARM_BELOW);
});

test('the pace latch matches the shared fixture', () => {
    for (const c of fixture.pace) {
        const alerted = new Set();
        c.polls.forEach((poll, i) => {
            const cards = poll.cards.map(key => ({key, label: key, percent: 50}));
            const forecasts = new Map(Object.entries(poll.forecasts));
            const got = latchPaceAlerts(alerted, cards, forecasts).map(({card}) => card.key);
            assert.deepEqual(got, c.expected[i], `${c.name}, poll ${i}`);
        });
    }
});

test('a pace alert carries the forecast it fired on', () => {
    const fc = {exhaustsBeforeReset: true, marginHours: -2, pctPerHour: 9};
    const [hit] = latchPaceAlerts(new Set(), [{key: 'session'}], new Map([['session', fc]]));
    assert.equal(hit.forecast, fc);
});

// ── The sections a poll refreshes ───────────────────────────────────────────

const CARDS = [{key: 'session', percent: 40}];
const LATEST = [{key: 'session', percent: 38}];

test('sectionCards: fresh cards, the last reading on a retry, else none', () => {
    assert.deepEqual(sectionCards({ok: true, cards: CARDS}, LATEST), CARDS);
    assert.deepEqual(sectionCards({ok: false, code: 'transient'}, LATEST), LATEST);
    assert.deepEqual(sectionCards({ok: false, code: 'transient'}, []), []);
    assert.deepEqual(sectionCards({ok: false, code: 'auth_expired'}, LATEST), []);
    assert.deepEqual(sectionCards({ok: false, code: 'no_token'}, LATEST), []);
});

function spySections(extra = {}) {
    const calls = [];
    const sections = {};
    for (const name of ['cost', 'sessions', 'cursor', 'accounts'])
        sections[name] = cards => { calls.push([name, cards]); };
    return {calls, sections: {...sections, ...extra}};
}

test('a failed poll still refreshes every section, the accounts with no live cards', async () => {
    for (const code of ['auth_expired', 'no_token', 'network_error']) {
        const {calls, sections} = spySections();
        const out = await refreshSections(sections, {result: {ok: false, code}, latest: LATEST});
        assert.deepEqual(calls.map(([n]) => n).sort(), ['accounts', 'cost', 'cursor', 'sessions'], code);
        assert.deepEqual(calls.find(([n]) => n === 'accounts')[1], [], code);
        assert.ok(out.every(o => o.outcome === 'done'), code);
    }
});

test('a good poll hands the accounts section the fresh cards', async () => {
    const {calls, sections} = spySections();
    await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: LATEST});
    assert.equal(calls.find(([n]) => n === 'accounts')[1], CARDS);
});

test('a section that never settles is cut off at the deadline, the others finish', async () => {
    const {calls, sections} = spySections({cost: () => new Promise(() => {})});
    const out = await refreshSections(sections, {
        result: {ok: true, cards: CARDS}, latest: [], deadlineMs: 20,
    });
    assert.deepEqual(Object.fromEntries(out.map(o => [o.section, o.outcome])),
        {cost: 'timeout', sessions: 'done', cursor: 'done', accounts: 'done'});
    assert.equal(calls.length, 3);
});

test('a section that throws is reported, never rejected', async () => {
    const boom = new Error('boom');
    const {sections} = spySections({
        cursor: () => { throw boom; },
        accounts: async () => { throw boom; },
    });
    const out = await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: []});
    const byName = Object.fromEntries(out.map(o => [o.section, o]));
    assert.equal(byName.cursor.outcome, 'failed');
    assert.equal(byName.cursor.error, boom);
    assert.equal(byName.accounts.outcome, 'failed');
});

test('every deadline timer is cleared once its section settles', async () => {
    const live = new Set();
    let id = 0;
    const timers = {
        setTimeout: () => { live.add(++id); return id; },
        clearTimeout: t => live.delete(t),
    };
    const {sections} = spySections();
    await refreshSections(sections, {result: {ok: true, cards: CARDS}, latest: [], timers});
    assert.equal(id, 4);
    assert.equal(live.size, 0);
    assert.ok(SECTION_DEADLINE_MS >= 30_000, 'a real section gets a real chance');
});

// ── run(): a child process never holds the poll hostage ─────────────────────

function fakeGio({hang}) {
    const log = {forceExit: 0, cancelled: 0, timers: []};
    class Cancellable {
        constructor() {
            this.handlers = new Map();
            this.next = 1;
        }

        connect(fn) {
            this.handlers.set(this.next, fn);
            return this.next++;
        }

        disconnect(id) {
            this.handlers.delete(id);
        }

        cancel() {
            log.cancelled++;
            for (const fn of this.handlers.values())
                fn();
        }
    }
    const Subprocess = {
        new: argv => ({
            argv,
            force_exit: () => { log.forceExit++; },
            get_successful: () => true,
            communicate_utf8_async(_input, cancellable, cb) {
                log.ownCancellable = cancellable;
                if (!hang)
                    setImmediate(() => cb(this, null));
            },
            communicate_utf8_finish: () => [true, 'out', ''],
        }),
    };
    const GLib = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        timeout_add_seconds: (_prio, seconds, fn) => {
            const handle = setTimeout(fn, 5);
            log.timers.push({seconds, handle});
            return log.timers.length;
        },
        Source: {remove: id => clearTimeout(log.timers[id - 1].handle)},
    };
    stub.overrides['gi://Gio'] = {Cancellable, Subprocess, SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2}};
    stub.overrides['gi://GLib'] = GLib;
    return {log, Cancellable};
}

test('run() kills a child that overruns its time and resolves ok:false', async t => {
    t.after(() => { stub.overrides = {}; });
    const {log} = fakeGio({hang: true});
    const {run, RUN_TIMEOUT_SECONDS} = await load('lib/proc.js');
    const r = await run(['ccusage', 'blocks'], {timeoutSeconds: 30});
    assert.equal(r.ok, false);
    assert.match(r.stderr, /ccusage: timed out after 30 s/);
    assert.equal(log.forceExit, 1);
    assert.equal(log.cancelled, 1, 'the pipe read is cancelled too - a grandchild may hold it');
    assert.equal(log.timers[0].seconds, 30);
    assert.equal(RUN_TIMEOUT_SECONDS, 60);
});

test('run() is bounded by default: a caller that passes nothing still gets the timeout', async t => {
    t.after(() => { stub.overrides = {}; });
    const {log} = fakeGio({hang: true});
    const {run, RUN_TIMEOUT_SECONDS} = await load('lib/proc.js');
    const r = await run(['ccusage', 'blocks', '--active', '--json']);
    assert.equal(r.ok, false);
    assert.equal(log.timers[0].seconds, RUN_TIMEOUT_SECONDS);
});

test('run() with timeoutSeconds 0 arms no timer, and a finished child clears its timer', async t => {
    t.after(() => { stub.overrides = {}; });
    const {log} = fakeGio({hang: false});
    const {run} = await load('lib/proc.js');
    assert.deepEqual(await run(['true'], {timeoutSeconds: 0}), {ok: true, stdout: 'out', stderr: ''});
    assert.equal(log.timers.length, 0);
    assert.deepEqual(await run(['true']), {ok: true, stdout: 'out', stderr: ''});
    assert.equal(log.forceExit, 0);
});

test('run() forwards the caller cancellable, and lets go of it afterwards', async t => {
    t.after(() => { stub.overrides = {}; });
    const {log, Cancellable} = fakeGio({hang: false});
    const {run} = await load('lib/proc.js');
    const caller = new Cancellable();
    await run(['true'], {cancellable: caller});
    assert.notEqual(log.ownCancellable, caller);
    assert.equal(caller.handlers.size, 0);
});

// ── The Cursor section stays off the keyring while it is off ────────────────

async function cursorController({enabled, secret = null}) {
    const lookups = [];
    stub.overrides['gi://Secret'] = {
        password_lookup: (_schema, attrs, _c, cb) => { lookups.push(attrs.name); cb(null, null); },
        password_lookup_finish: () => secret,
        password_store: (_s, _a, _c, _l, _v, _cn, cb) => cb(null, null),
        password_store_finish: () => true,
    };
    const {CursorController} = await load('lib/cursorSection.js');
    const settings = {
        get_boolean: k => (k === 'cursor-enabled' ? enabled : false),
        get_string: () => '',
        set_string: () => {},
    };
    const ctl = new CursorController({
        settings, session: {}, menu: {addMenuItem: () => {}}, isDestroyed: () => false,
    });
    return {ctl, lookups};
}

test('Cursor disabled: refresh() never touches the keyring', async t => {
    t.after(() => { stub.overrides = {}; });
    const {ctl, lookups} = await cursorController({enabled: false});
    await ctl.refresh();
    await ctl.refresh();
    assert.deepEqual(lookups, []);
    assert.equal(ctl._item.visible, false);
});

test('Cursor enabled: refresh() reads the key from the keyring', async t => {
    t.after(() => { stub.overrides = {}; });
    const {ctl, lookups} = await cursorController({enabled: true});
    await ctl.refresh();
    assert.deepEqual(lookups, ['cursor-admin-api-key']);
    assert.equal(ctl._item.visible, false, 'no key anywhere - still hidden');
});

// ── Plan label and translated errors ────────────────────────────────────────

test('planLabel reads the plan from the credentials, the usage endpoint has none', async () => {
    const {planLabel} = await load('lib/claudeUsage.js');
    assert.equal(planLabel({subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x'}), 'Max 20x');
    assert.equal(planLabel({subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x'}), 'Max 5x');
    assert.equal(planLabel({subscriptionType: 'pro', rateLimitTier: 'default_claude_ai'}), 'Pro');
    assert.equal(planLabel({subscriptionType: 'team'}), 'Team');
    assert.equal(planLabel({subscriptionType: ''}), '');
    assert.equal(planLabel({}), '');
    assert.equal(planLabel(null), '');
});

test('the usage errors a user reads go through the extension catalog', async t => {
    stub.gettext = s => `«${s}»`;
    stub.overrides['gi://GLib'] = {
        getenv: () => null,
        get_home_dir: () => '/nonexistent',
        build_filenamev: parts => parts.join('/'),
        file_get_contents: () => { throw new Error('no such file'); },
    };
    t.after(() => {
        stub.gettext = s => s;
        stub.overrides = {};
    });
    const {fetchUsage} = await load('lib/claudeUsage.js');
    const r = await fetchUsage({}, null);
    assert.equal(r.code, 'no_token');
    assert.equal(r.message, '«No Claude credentials found. Sign in with Claude Code.»');
    const metadata = JSON.parse(fs.readFileSync(new URL('metadata.json', EXT), 'utf8'));
    assert.equal(stub.domain, metadata['gettext-domain'], 'the catalog the prefs process binds');
});

test('the Cursor API errors go through the catalog too', async t => {
    stub.gettext = s => `«${s}»`;
    t.after(() => {
        stub.gettext = s => s;
        stub.overrides = {};
    });
    stub.overrides['gi://GLib'] = {PRIORITY_DEFAULT: 0, base64_encode: () => 'eA==', Bytes: class {}};
    const status = {code: 401};
    stub.overrides['gi://Soup'] = {
        Message: {
            new: () => ({
                request_headers: {append: () => {}},
                set_request_body_from_bytes: () => {},
                get_status: () => status.code,
            }),
        },
    };
    const session = {
        send_and_read_async: (_m, _p, _c, cb) => cb(session, null),
        send_and_read_finish: () => ({get_data: () => new Uint8Array(0)}),
    };
    const {fetchCursor} = await load('lib/cursorUsage.js');
    await assert.rejects(fetchCursor(session, 'k'), {message: '«Cursor API key rejected»'});
    status.code = 500;
    await assert.rejects(fetchCursor(session, 'k'), {message: '«Cursor HTTP 500»'});
});

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
