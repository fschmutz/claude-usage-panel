// The GNOME Awake section over the GJS stubs: the state is read
// asynchronously from the two files (a synchronous read on the Shell's main
// loop fails this test), the top-bar badge follows it, the buttons build the
// right claudectl argv, and the section reads nothing at all while it is off.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TextEncoder} from 'node:util';

import {stub} from './gjs-stub.js';

const HOME = '/home/tester';
const AWAKE = `${HOME}/.local/state/claude-usage-panel/awake`;
// Relative to the real clock: the section reads `Date.now()` itself, exactly
// as it does on a poll.
const NOW = Date.now();
const encode = new TextEncoder();

const settings = (overrides = {}) => ({
    get_boolean: key => overrides[key] ?? key === 'awake-enabled',
    get_int: key => ({'awake-battery-floor': 40, 'awake-end-floor': 10, 'awake-max-hours': 12})[key],
});

/** St with a widget tree a test can read: children, labels, clicks. */
function installSt() {
    class Actor {
        constructor(props = {}) {
            Object.assign(this, {visible: true, reactive: true, children: []}, props);
            this._handlers = {};
        }

        add_child(c) { this.children.push(c); }

        get_children() { return this.children; }

        destroy_all_children() { this.children = []; }

        connect(sig, fn) { this._handlers[sig] = fn; }

        click() {
            if (this.reactive)
                this._handlers.clicked?.();
        }
    }
    stub.overrides['gi://St'] = {
        // widgets.js probes for the `orientation` property to tell GNOME 45
        // from 46+; a stub BoxLayout has to answer that.
        BoxLayout: class extends Actor {
            static find_property() { return null; }
        },
        Button: class extends Actor {},
        Label: class extends Actor {},
    };
}

/** GLib + Gio over `files` (path -> text). Only the async reads work. */
function install(files) {
    installSt();
    const sync = name => () => {
        throw new Error(`synchronous ${name} on the Shell main loop`);
    };
    const written = [];
    stub.overrides['gi://GLib'] = {
        PRIORITY_LOW: 300,
        PRIORITY_DEFAULT: 0,
        getenv: () => null,
        get_home_dir: () => HOME,
        get_real_time: () => 1,
        build_filenamev: parts => parts.join('/'),
        mkdir_with_parents: () => 0,
        file_get_contents: path => {
            if (!(path in files))
                throw new Error('no such file');
            return [true, encode.encode(files[path])];
        },
        file_set_contents_full: (path, bytes) => written.push([path, new TextDecoder().decode(bytes)]),
        timeout_add_seconds: () => 1,
        Source: {remove: () => {}},
    };
    stub.overrides['gi://Gio'] = {
        _promisify: () => {},
        FileQueryInfoFlags: {NONE: 0},
        FileCopyFlags: {OVERWRITE: 1},
        File: {
            new_for_path: path => ({
                enumerate_children: sync('enumerate_children'),
                load_contents: sync('load_contents'),
                move: () => true,
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
    return written;
}

const session = extra => JSON.stringify({
    version: 1, startedAt: NOW - 600_000, endsAt: NOW + 3_000_000, timed: true,
    owner: {pid: 4242, host: 'box', kind: 'cli'}, ...extra,
});

const journal = extra => JSON.stringify({
    version: 1, at: NOW - 3_600_000, endsAt: NOW - 720_000, ...extra,
});

function controller(deps = {}) {
    return {
        settings: settings(),
        menu: {addMenuItem: () => {}, close: () => {}},
        notify: () => {},
        isDestroyed: () => false,
        ...deps,
    };
}

test('a held session draws the countdown badge and offers +30m / Off', async t => {
    t.after(() => { stub.overrides = {}; });
    install({[`${AWAKE}/session.json`]: session()});
    const {AwakeController} = await import('../claude-usage-panel@fschmutz.github.io/lib/awakeSection.js');
    const badges = [];
    const section = new AwakeController(controller({setBadge: b => badges.push(b)}));
    await section.refresh();
    assert.equal(section._item.visible, true);
    assert.equal(badges.length, 1);
    assert.match(badges[0], /^(49|50):\d\d$/, 'a countdown, not a session count');
    assert.match(section._line.text, /^timer (49|50):\d\d$/);
    assert.equal(section._recovery.visible, false);
    assert.deepEqual(section._buttons.get_children().map(b => b.label), ['+30m', 'Off']);
});

test('nothing held offers the presets and "While sessions"', async t => {
    t.after(() => { stub.overrides = {}; });
    install({});
    const {AwakeController, AWAKE_PRESETS} =
        await import('../claude-usage-panel@fschmutz.github.io/lib/awakeSection.js');
    const badges = [];
    const section = new AwakeController(controller({setBadge: b => badges.push(b)}));
    await section.refresh();
    assert.deepEqual(badges, ['']);
    assert.equal(section._line.text, 'off');
    assert.deepEqual(section._buttons.get_children().map(b => b.label),
        [...AWAKE_PRESETS.map(m => (m < 60 ? `${m}m` : `${m / 60}h`)), 'While sessions']);
});

test('a session that ended without giving sleep back warns, loudly, with a Recover button', async t => {
    t.after(() => { stub.overrides = {}; });
    install({
        [`${AWAKE}/journal.json`]: journal({sleepDisabled: true}),
    });
    const {AwakeController, awakeRecoveryText} =
        await import('../claude-usage-panel@fschmutz.github.io/lib/awakeSection.js');
    const section = new AwakeController(controller());
    await section.refresh();
    assert.equal(section._recovery.visible, true);
    assert.match(section._recovery.text, /Sleep was not given back \(sleepDisabled\), 12m ago/);
    assert.equal(section._buttons.get_children()[0].label, 'Recover');
    assert.equal(awakeRecoveryText(null), '');
});

test('the dropdown words say which holds are in force', async t => {
    t.after(() => { stub.overrides = {}; });
    install({});
    const {awakeStateText} =
        await import('../claude-usage-panel@fschmutz.github.io/lib/awakeSection.js');
    assert.equal(awakeStateText({active: false}), 'off');
    assert.equal(awakeStateText({active: false, endReason: 'battery'}),
        'off (last session ended: battery)');
    assert.equal(awakeStateText({active: true, holds: ['timer'], countdown: '1:00:00'}),
        'timer 1:00:00');
    assert.equal(
        awakeStateText({active: true, holds: ['sessions'], sessions: 3, lid: true}),
        '3 live session(s) · lid mode');
});

test('the buttons build the claudectl argv, and lid mode is never implied', async t => {
    t.after(() => { stub.overrides = {}; });
    install({});
    const {awakeCommand} = await import('../claude-usage-panel@fschmutz.github.io/lib/awake.js');
    const cli = '/bin/claudectl';
    assert.deepEqual(awakeCommand(cli, 'on', {seconds: 1800}), [cli, 'awake', 'on', '--for', '30m']);
    assert.deepEqual(awakeCommand(cli, 'on', {whileSessions: true}),
        [cli, 'awake', 'on', '--while-sessions']);
    assert.deepEqual(awakeCommand(cli, 'on', {seconds: 3600, lid: true}),
        [cli, 'awake', 'on', '--for', '60m', '--lid']);
    assert.deepEqual(awakeCommand(cli, 'extend', {seconds: 1800}),
        [cli, 'awake', 'extend', '--for', '30m']);
    assert.deepEqual(awakeCommand(cli, 'off'), [cli, 'awake', 'off']);
    assert.deepEqual(awakeCommand(cli, 'recover'), [cli, 'awake', 'recover', '--force']);
});

test('the floors reach the holder through config.json, written only when they move', async t => {
    t.after(() => { stub.overrides = {}; });
    const written = install({});
    const {syncAwakeConfig} = await import('../claude-usage-panel@fschmutz.github.io/lib/awake.js');
    assert.equal(syncAwakeConfig(settings()), true);
    assert.equal(written.length, 1);
    assert.deepEqual(JSON.parse(written[0][1]),
        {lowPowerFloor: 40, endFloor: 10, maxSeconds: 43200, thermalRules: true});
});

test('off (the default): no file is read, no badge, no section', async t => {
    t.after(() => { stub.overrides = {}; });
    install({});
    stub.overrides['gi://Gio'].File.new_for_path = path => {
        throw new Error(`read ${path} with the section off`);
    };
    const {AwakeController} = await import('../claude-usage-panel@fschmutz.github.io/lib/awakeSection.js');
    const badges = [];
    const section = new AwakeController(controller({
        settings: settings({'awake-enabled': false}), setBadge: b => badges.push(b),
    }));
    await section.refresh();
    assert.deepEqual(badges, ['']);
    assert.equal(section._item.visible, false);
});
