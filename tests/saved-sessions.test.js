// lib/savedSessions.js: the header's Reopen and Save buttons, loaded under
// plain node through the GJS stubs, with the CLI and the store faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {memoryFs} from './gio-memory.js';
import {stub} from './gjs-stub.js';

async function controller({newest = null, cli = '/bin/claudectl', result = {ok: true, stdout: '', stderr: ''}} = {}) {
    const {SavedSessionsController} = await import('../claude-usage-panel@fschmutz.github.io/lib/savedSessions.js');
    const seen = {states: [], runs: [], notes: [], closed: 0, reads: 0};
    const ctl = new SavedSessionsController({
        header: {syncReopen: s => seen.states.push(s)},
        menu: {close: () => { seen.closed++; }},
        isDestroyed: () => false,
        io: {
            readSnapshots: async () => {
                seen.reads++;
                return {newest: seen.newest === undefined ? newest : seen.newest};
            },
            claudectlPath: () => cli,
            run: async argv => { seen.runs.push(argv); return result; },
            notify: (title, body) => seen.notes.push([title, body]),
        },
    });
    return {ctl, seen};
}

const snap = n => ({label: 'auto-2026-10-06-0930', savedAt: 1, sessions: Array.from({length: n}, (_, i) => ({name: `s${i}`}))});

test('Reopen shows only for a snapshot that holds sessions; Save whenever claudectl is there', async () => {
    const {ctl, seen} = await controller({newest: snap(2)});
    await ctl.sync();
    assert.deepEqual(seen.states.at(-1), {visible: true, canSave: true, title: 'Reopen auto-2026-10-06-0930 (2 sessions)'});
    const empty = await controller({newest: snap(0)});
    await empty.ctl.sync();
    assert.deepEqual(empty.seen.states.at(-1), {visible: false, canSave: true, title: ''},
        'a forced save of nothing open means nothing to reopen');
    const none = await controller({newest: snap(2), cli: null});
    await none.ctl.sync();
    assert.deepEqual(none.seen.states.at(-1), {visible: false, canSave: false, title: ''});
});

test('Save runs a forced autosave, reports its first line, and re-syncs the header', async () => {
    const {ctl, seen} = await controller({
        newest: snap(1),
        result: {ok: true, stdout: 'saved auto-2026-10-06-0930 (1 sessions)\n', stderr: ''},
    });
    await ctl.save();
    assert.deepEqual(seen.runs, [['/bin/claudectl', 'session', 'autosave', '--force']]);
    assert.deepEqual(seen.notes, [['Saved your open sessions', 'saved auto-2026-10-06-0930 (1 sessions)']]);
    assert.equal(seen.states.length, 1);
    assert.equal(seen.closed, 0, 'saving keeps the menu open');
});

test('a Save that missed a session says which one', async () => {
    const {ctl, seen} = await controller({
        result: {ok: false, stdout: 'saved auto-x (1 sessions)\nNOT SAVED: claude pid 42 in /w - no session id\n', stderr: ''},
    });
    await ctl.save();
    assert.deepEqual(seen.notes, [['Could not save every session', 'NOT SAVED: claude pid 42 in /w - no session id']]);
});

test('Reopen closes the menu and opens the newest snapshot', async () => {
    const {ctl, seen} = await controller({result: {ok: true, stdout: 'open a\nopened 1 tab\n', stderr: ''}});
    await ctl.reopen();
    assert.deepEqual(seen.runs, [['/bin/claudectl', 'session', 'open']]);
    assert.equal(seen.closed, 1);
    assert.deepEqual(seen.notes, [['Reopened your sessions', 'opened 1 tab']]);
});

test('opening the menu paints the last summary at once and re-reads the store without blocking', async () => {
    const {ctl, seen} = await controller({newest: snap(1)});
    const first = ctl.sync();
    assert.equal(seen.states.length, 0, 'nothing is known before the first read lands');
    await first;
    assert.equal(seen.states.at(-1).title, 'Reopen auto-2026-10-06-0930 (1 session)');
    // The autosave wrote a newer snapshot outside this process.
    seen.newest = snap(3);
    const again = ctl.sync();
    assert.equal(seen.states.at(-1).title, 'Reopen auto-2026-10-06-0930 (1 session)', 'the cached one, at once');
    await again;
    assert.equal(seen.states.at(-1).title, 'Reopen auto-2026-10-06-0930 (3 sessions)', 'then the fresh one');
    assert.equal(seen.reads, 2, 'one read per menu open');
});

test('readSnapshots lists and parses the store with async Gio only', async t => {
    const tabs = '/home/tester/.local/state/claude-usage-panel/tabs';
    const mem = memoryFs({files: {
        [`${tabs}/auto-1.json`]: JSON.stringify({savedAt: 1, sessions: [{name: 'a'}]}),
        [`${tabs}/work.json`]: JSON.stringify({savedAt: 2, sessions: [{name: 'b'}, {name: 'c'}]}),
        [`${tabs}/notes.txt`]: 'x',
    }});
    stub.overrides['gi://GLib'] = {...mem.GLib, getenv: () => null, get_home_dir: () => '/home/tester'};
    stub.overrides['gi://Gio'] = mem.Gio;
    t.after(() => { stub.overrides = {}; });
    const {readSnapshots} = await import('../claude-usage-panel@fschmutz.github.io/lib/snapshots.js');
    const summary = await readSnapshots();
    assert.equal(summary.count, 2);
    assert.equal(summary.newest.label, 'work');
});
