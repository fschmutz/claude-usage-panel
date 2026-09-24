// lib/proc.js: run() with its timeout and cancellables, loaded under plain
// node through the GJS stubs (tests/gjs-stub.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers';

import {load, stub} from './gjs-stub.js';

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
