// The GNOME waiting scan (lib/waiting.js) and its dropdown section over the
// GJS stubs, on an in-memory registry: every read is async (a synchronous
// read on the Shell's main loop is what this pins against: each sync Gio /
// GLib call here throws), a dead or reused pid never shows, and a click
// focuses by pid.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TextEncoder} from 'node:util';

import {stub} from './gjs-stub.js';

const HOME = '/home/tester';
const SESSIONS = `${HOME}/.claude/sessions`;
const NOW = Date.parse('2026-10-08T12:00:00Z');
const encode = new TextEncoder();

const stat = start => `4242 (claude (dev)) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start} 0\n`;
const registry = (pid, sessionId, start, extra = {}) => JSON.stringify({
    kind: 'interactive', pid, sessionId, cwd: `/work/${sessionId}`, procStart: String(start), ...extra,
});
const marker = (pid, sessionId, reason, at) => JSON.stringify({version: 1, sessionId, pid, reason, at});

/** GLib + Gio over `files` (path -> text). Only the async calls work. */
function install(files) {
    const sync = name => () => {
        throw new Error(`synchronous ${name} on the Shell main loop`);
    };
    stub.overrides['gi://GLib'] = {
        PRIORITY_LOW: 300,
        getenv: () => null,
        get_home_dir: () => HOME,
        build_filenamev: parts => parts.join('/'),
        file_get_contents: sync('file_get_contents'),
    };
    stub.overrides['gi://Gio'] = {
        _promisify: () => {},
        FileQueryInfoFlags: {NONE: 0},
        File: {
            new_for_path: path => ({
                enumerate_children: sync('enumerate_children'),
                load_contents: sync('load_contents'),
                async enumerate_children_async() {
                    const names = Object.keys(files).filter(f => f.startsWith(`${path}/`))
                        .map(f => f.slice(path.length + 1));
                    if (!names.length)
                        throw new Error('not found');
                    let batch = names.map(name => ({get_name: () => name}));
                    return {
                        next_files_async: async () => {
                            const out = batch;
                            batch = [];
                            return out;
                        },
                        close_async: async () => true,
                    };
                },
                async load_contents_async() {
                    if (!(path in files))
                        throw new Error(`no such file: ${path}`);
                    return [encode.encode(files[path]), ''];
                },
            }),
        },
    };
}

test('listWaiting: async reads only; live sessions only, a reused pid never inherits a marker', async t => {
    t.after(() => { stub.overrides = {}; });
    install({
        [`${SESSIONS}/11.json`]: registry(11, 'live', 500, {name: 'API'}),
        [`/proc/11/stat`]: stat(500),
        [`${SESSIONS}/11.waiting.json`]: marker(11, 'live', 'permission', NOW - 300_000),
        // pid 22 was reused by a new session after a crash: old marker, new id
        [`${SESSIONS}/22.json`]: registry(22, 'new', 700),
        [`/proc/22/stat`]: stat(700),
        [`${SESSIONS}/22.waiting.json`]: marker(22, 'crashed', 'idle', NOW - 86_400_000),
        // pid 33's process is gone: its start time no longer matches
        [`${SESSIONS}/33.json`]: registry(33, 'dead', 900),
        [`/proc/33/stat`]: stat(901),
        [`${SESSIONS}/33.waiting.json`]: marker(33, 'dead', 'question', NOW - 1000),
        // a marker written as junk is skipped, never thrown
        [`${SESSIONS}/44.waiting.json`]: '{"pid": "44", "reason": "idle"}',
    });
    const {listWaiting} = await import('../claude-usage-panel@fschmutz.github.io/lib/waiting.js');
    const rows = await listWaiting({nowMs: NOW});
    assert.deepEqual(rows.map(r => [r.pid, r.name, r.reason, r.age]), [[11, 'API', 'permission', '5m']]);
});

test('listWaiting: no registry yet is an empty list', async t => {
    t.after(() => { stub.overrides = {}; });
    install({});
    const {listWaiting} = await import('../claude-usage-panel@fschmutz.github.io/lib/waiting.js');
    assert.deepEqual(await listWaiting({nowMs: NOW}), []);
});

test('the section shows the badge count and focuses by pid, never by a shared name', async t => {
    t.after(() => { stub.overrides = {}; });
    install({
        [`${SESSIONS}/11.json`]: registry(11, 'a', 1, {name: 'repo'}),
        [`/proc/11/stat`]: stat(1),
        [`${SESSIONS}/11.waiting.json`]: marker(11, 'a', 'idle', NOW - 1000),
        [`${SESSIONS}/22.json`]: registry(22, 'b', 2, {name: 'repo'}),
        [`/proc/22/stat`]: stat(2),
        [`${SESSIONS}/22.waiting.json`]: marker(22, 'b', 'idle', NOW - 2000),
    });
    const {WaitingController, focusCommand} =
        await import('../claude-usage-panel@fschmutz.github.io/lib/waitingSection.js');
    const badges = [];
    const section = new WaitingController({
        menu: {addMenuItem: () => {}, close: () => {}},
        notify: () => {},
        isDestroyed: () => false,
        setBadge: n => badges.push(n),
    });
    await section.refresh();
    assert.deepEqual(badges, [2]);
    assert.equal(section._item.visible, true);
    assert.deepEqual(focusCommand('/bin/claudectl', {pid: 22, name: 'repo'}),
        ['/bin/claudectl', 'waiting', 'focus', '22']);
});

test('an older scan that finishes after a newer one never paints over it', async t => {
    t.after(() => { stub.overrides = {}; });
    const files = {
        [`${SESSIONS}/11.json`]: registry(11, 'a', 1),
        [`/proc/11/stat`]: stat(1),
        [`${SESSIONS}/11.waiting.json`]: marker(11, 'a', 'idle', NOW - 1000),
    };
    install(files);
    // hold the FIRST listing until the second scan has painted
    const gio = stub.overrides['gi://Gio'].File;
    const real = gio.new_for_path;
    let release;
    const held = new Promise(r => { release = r; });
    let calls = 0;
    gio.new_for_path = path => {
        const f = real(path);
        if (path !== SESSIONS)
            return f;
        const first = ++calls === 1;
        return {...f, enumerate_children_async: async () => {
            if (first)
                await held;
            return f.enumerate_children_async();
        }};
    };
    const {WaitingController} = await import('../claude-usage-panel@fschmutz.github.io/lib/waitingSection.js');
    const badges = [];
    const section = new WaitingController({
        menu: {addMenuItem: () => {}, close: () => {}},
        notify: () => {},
        isDestroyed: () => false,
        setBadge: n => badges.push(n),
    });
    const older = section.refresh();
    delete files[`${SESSIONS}/11.waiting.json`]; // the wait ended meanwhile
    await section.refresh();
    release();
    await older;
    assert.deepEqual(badges, [0], 'the stale scan (1 waiting) was dropped');
});
