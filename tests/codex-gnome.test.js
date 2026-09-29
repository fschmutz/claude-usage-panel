// The GNOME Codex store (lib/codex.js) over the GJS stubs, on a fake file
// tree: the transcript scan is async end to end (a synchronous walk of
// ~/.codex/sessions on the shell's main thread is what this pins against),
// it follows the contract's newest-day-first walk, and a switch keeps a token
// the codex CLI rotated between the sync-back and the write.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setImmediate} from 'node:timers';
import {URL} from 'node:url';
import {TextDecoder, TextEncoder} from 'node:util';

import {load, stub} from './gjs-stub.js';

const HOME = '/home/tester';
const SESSIONS = `${HOME}/.codex/sessions`;
const AUTH = `${HOME}/.codex/auth.json`;
const PROFILES = `${HOME}/.local/state/claude-usage-panel/codex-accounts`;
const DIRECTORY = 2;
const encode = new TextEncoder();
const decode = new TextDecoder();

/**
 * GLib + Gio over `files` (path -> text) and `mtimes` (path -> epoch s).
 * Directories are implied by the paths under them. `onRead(path)` runs on
 * every file_get_contents. Every sessions/ listing is recorded in `listed`;
 * a synchronous enumerate_children there throws.
 */
function install({files, mtimes = {}, onRead = () => {}}) {
    const listed = [];
    const children = dir => {
        const out = new Map();
        for (const f of Object.keys(files)) {
            if (!f.startsWith(`${dir}/`))
                continue;
            const rest = f.slice(dir.length + 1).split('/');
            out.set(rest[0], rest.length > 1);
        }
        return out;
    };
    const info = (dir, name, isDir) => ({
        get_name: () => name,
        get_file_type: () => (isDir ? DIRECTORY : 1),
        get_attribute_uint64: () => mtimes[`${dir}/${name}`] ?? 0,
    });
    stub.overrides['gi://GLib'] = {
        PRIORITY_LOW: 300,
        SeekType: {SET: 0},
        FileSetContentsFlags: {CONSISTENT: 0},
        getenv: () => null,
        get_home_dir: () => HOME,
        build_filenamev: parts => parts.join('/'),
        path_get_dirname: p => p.slice(0, p.lastIndexOf('/')),
        mkdir_with_parents: () => 0,
        get_real_time: () => 1,
        file_get_contents: path => {
            onRead(path);
            if (!(path in files))
                throw new Error(`no such file: ${path}`);
            return [true, encode.encode(files[path])];
        },
        file_set_contents_full: (path, bytes) => {
            files[path] = decode.decode(bytes);
            return true;
        },
    };
    stub.overrides['gi://Gio'] = {
        _promisify: () => {},
        FileQueryInfoFlags: {NONE: 0},
        FileCopyFlags: {OVERWRITE: 0},
        FileType: {DIRECTORY},
        File: {
            new_for_path: path => ({
                path,
                enumerate_children() {
                    if (path.startsWith(SESSIONS))
                        throw new Error('synchronous walk of the sessions tree');
                    const names = [...children(path).keys()];
                    let i = 0;
                    return {next_file: () => (i < names.length ? {get_name: () => names[i++]} : null)};
                },
                enumerate_children_async() {
                    listed.push(path.slice(SESSIONS.length + 1));
                    const kids = children(path);
                    if (!kids.size)
                        return Promise.reject(new Error('not found'));
                    let batch = [...kids].map(([name, isDir]) => info(path, name, isDir));
                    return Promise.resolve({
                        next_files_async: () => {
                            const out = batch;
                            batch = [];
                            return Promise.resolve(out);
                        },
                        close_async: () => Promise.resolve(true),
                    });
                },
                query_info_async: () => Promise.resolve({get_size: () => files[path].length}),
                read_async: () => Promise.resolve({
                    seek() {},
                    read_bytes_async: () => Promise.resolve({get_data: () => encode.encode(files[path])}),
                    close_async: () => Promise.resolve(true),
                }),
                move(target) {
                    files[target.path] = files[path];
                    delete files[path];
                },
            }),
        },
    };
    return listed;
}

const line = (at, used) => `${JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: {type: 'token_count', rate_limits: {primary: {used_percent: used, window_minutes: 300}}},
})}\n`;

test('the Codex transcript scan is async, newest day first, and reads 4 levels deep', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.parse('2026-09-13T12:00:00Z');
    const files = {
        [`${SESSIONS}/2026/09/13/rollout-new.jsonl`]: line(now - 60_000, 40),
        [`${SESSIONS}/2026/09/12/rollout-old.jsonl`]: line(now - 3_600_000, 10),
        [`${SESSIONS}/x/y/z/w/deep4.jsonl`]: '',
        [`${SESSIONS}/x/y/z/w/v/deep5.jsonl`]: '',
    };
    const mtimes = {
        [`${SESSIONS}/2026/09/13/rollout-new.jsonl`]: now / 1000,
        [`${SESSIONS}/2026/09/12/rollout-old.jsonl`]: now / 1000 - 3600,
        [`${SESSIONS}/x/y/z/w/deep4.jsonl`]: 1,
    };
    const listed = install({files, mtimes});
    const {recordedCodexUsage} = await load('lib/codex.js');
    const pending = recordedCodexUsage(now);
    assert.ok(pending instanceof Promise, 'the scan hands back a promise, the shell never waits on it');
    const got = await pending;
    assert.equal(got.reason, null);
    assert.deepEqual(got.cards.map(c => c.percent), [40]);
    // x/ sorts after 2026/, so it is walked first; the 5th level never is.
    assert.deepEqual(listed, ['', 'x', 'x/y', 'x/y/z', 'x/y/z/w', '2026', '2026/09', '2026/09/13', '2026/09/12']);
});

test('a GNOME switch keeps a token the codex CLI rotated between the sync-back and the write', async t => {
    t.after(() => { stub.overrides = {}; });
    const fix = JSON.parse(fs.readFileSync(new URL('./fixtures/codex.json', import.meta.url), 'utf8'));
    const [ana, ben] = fix.team.profiles;
    const files = {
        [`${PROFILES}/${ana.name}.json`]: JSON.stringify(ana),
        [`${PROFILES}/${ben.name}.json`]: JSON.stringify(ben),
        [AUTH]: JSON.stringify(ana.auth),
    };
    const rotated = {...ana.auth, tokens: {...ana.auth.tokens, refresh_token: 'rt-rotated'}};
    let authReads = 0;
    install({files, onRead: path => {
        // The CLI refreshes the live login after the sync-back read it (read
        // 1), before the switch looks again (read 2).
        if (path === AUTH && ++authReads === 2)
            files[AUTH] = JSON.stringify(rotated);
    }});
    const {switchCodexTo} = await load('lib/codex.js');
    const r = switchCodexTo(ben.name);
    assert.deepEqual({from: r.from, changed: r.changed}, {from: ana.name, changed: true});
    const saved = JSON.parse(files[`${PROFILES}/${ana.name}.json`]);
    assert.equal(saved.auth.tokens.refresh_token, 'rt-rotated');
    assert.deepEqual(JSON.parse(files[AUTH]), ben.auth);
});

test('the Codex section draws its accounts at once and the usage when the scan lands', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.now();
    const files = {[`${SESSIONS}/2026/09/13/rollout.jsonl`]: line(now - 60_000, 40)};
    install({files, mtimes: {[`${SESSIONS}/2026/09/13/rollout.jsonl`]: now / 1000}});
    const {CodexController} = await load('lib/codexSection.js');
    const section = new CodexController({
        settings: {get_boolean: () => true},
        menu: {addMenuItem() {}},
        isDestroyed: () => false,
    });
    assert.equal(section.refresh(), undefined, 'refresh returns before any transcript is read');
    assert.equal(section._scanning, true);
    section.refresh();
    assert.equal(section._rescan, true, 'a refresh during a scan queues one more, never a second walk');
    while (section._scanning)
        await new Promise(resolve => setImmediate(resolve));
    assert.match(section._note.text, /^Recorded by the codex CLI at /);
});
