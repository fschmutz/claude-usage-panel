// gnome-terminal tabs (claude-code/gnome-terminal.js): what `claudectl session
// open` records about the windows it created, and how focus selects a tab and
// asks the GNOME extension to raise its window. Every gdbus call is faked;
// nothing reaches the session bus.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {RAISE, focusTab, recordTabs, terminalEnvOf, terminalWindows} from '../claude-code/gnome-terminal.js';
import {gnomeTabsPath} from '../claude-code/paths.js';
import {sandboxHome} from './helpers.js';

const SERVICE = ':1.204';
const W = (n) => `/org/gnome/Terminal/window/${n}`;
const SCREEN = (x) => `/org/gnome/Terminal/screen/${x}`;

/**
 * A sandbox whose gdbus answers from `bus`: the window numbers (a function
 * of the call count, so windows can appear), the live screens, the raise
 * answer. Records every gdbus argv.
 */
function world(t, bus = {}) {
    const io = sandboxHome(t, {prefix: 'cup-gt-'});
    const calls = [];
    let listings = 0;
    io.exec = (cmd, args) => {
        assert.equal(cmd, 'gdbus');
        calls.push(args);
        const at = args[args.indexOf('--object-path') + 1];
        if (args[0] === 'introspect' && at === '/org/gnome/Terminal/window') {
            const ns = typeof bus.windows === 'function' ? bus.windows(listings++) : (bus.windows ?? []);
            return `node /org/gnome/Terminal/window {\n${ns.map((n) => `  node ${n} {\n  };`).join('\n')}\n};\n`;
        }
        if (args[0] === 'introspect') {
            return (bus.screens ?? []).includes(at)
                ? `node ${at} {\n  interface org.freedesktop.DBus.Properties {\n  };\n};\n` : `node ${at} {\n};\n`;
        }
        if (args.includes('org.freedesktop.DBus.GetNameOwner')) return `('${bus.service ?? SERVICE}',)\n`;
        if (args.includes('org.gtk.Actions.SetState')) return '()\n';
        if (args.includes(RAISE.method)) {
            if (bus.raise === 'missing') throw new Error('No such object path');
            return `(${bus.raise ?? true},)\n`;
        }
        throw new Error(`unexpected gdbus ${args.join(' ')}`);
    };
    io.sleep = async () => {};
    io.nowMs = () => 1_000;
    return {io, calls};
}

function tab(io, pid, screen, service = SERVICE) {
    const dir = path.join(io.procDir, String(pid));
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'environ'),
        `HOME=/h\0GNOME_TERMINAL_SCREEN=${screen}\0GNOME_TERMINAL_SERVICE=${service}\0`);
}

const rows = (...ids) => ids.map((id) => ({session_id: id}));

test('terminalWindows lists the window paths, oldest first', (t) => {
    const {io} = world(t, {windows: [10, 2]});
    assert.deepEqual(terminalWindows(io), [W(2), W(10)]);
});

test('terminalEnvOf reads the tab and server a process runs in, {} when unreadable', (t) => {
    const {io} = world(t);
    tab(io, 7, SCREEN('a'));
    assert.deepEqual(terminalEnvOf(7, io), {screen: SCREEN('a'), service: SERVICE});
    assert.deepEqual(terminalEnvOf(8, io), {});
});

test('recordTabs waits for the new windows and maps them to the groups in order', async (t) => {
    // the windows appear on the third look
    const {io} = world(t, {windows: (n) => (n < 2 ? [1] : [1, 3, 4])});
    const n = await recordTabs({before: [W(1)], groups: [rows('a', 'b'), rows('c')], io});
    assert.equal(n, 2);
    const rec = JSON.parse(fs.readFileSync(gnomeTabsPath(io), 'utf8'));
    assert.deepEqual(rec.windows[W(3)], {service: SERVICE, at: 1_000, tabs: rows('a', 'b')});
    assert.deepEqual(rec.windows[W(4)].tabs, rows('c'));
    assert.equal(fs.statSync(gnomeTabsPath(io)).mode & 0o777, 0o600);
});

test('recordTabs drops windows that are gone or from an older server, records nothing on a timeout', async (t) => {
    const {io} = world(t, {windows: [5]});
    await recordTabs({before: [], groups: [rows('a')], io});
    const later = world(t, {windows: [6], service: ':1.999'});
    Object.assign(later.io, {home: io.home, homedir: io.home});
    await recordTabs({before: [], groups: [rows('b')], io: later.io});
    const rec = JSON.parse(fs.readFileSync(gnomeTabsPath(io), 'utf8'));
    assert.deepEqual(Object.keys(rec.windows), [W(6)], 'window 5 belonged to the old server');

    const none = world(t, {windows: [1]});
    assert.equal(await recordTabs({before: [W(1)], groups: [rows('x')], io: none.io, timeoutMs: 400}), 0);
    assert.equal(fs.existsSync(gnomeTabsPath(none.io)), false);
});

test('focusTab selects the recorded tab, shifted left past a closed one, then asks the Shell to raise', async (t) => {
    const {io, calls} = world(t, {windows: [3], screens: [SCREEN('c')]});
    await recordTabs({before: [], groups: [rows('a', 'b', 'c')], io});
    tab(io, 11, SCREEN('a'));
    tab(io, 33, SCREEN('c'));
    const live = [{pid: 11, session_id: 'a'}, {pid: 33, session_id: 'c'}];
    // a: its tab is gone (screen not on the bus); b: never seen, assumed open
    assert.equal(focusTab({pid: 33, session_id: 'c'}, live, io), true);
    const set = calls.find((a) => a.includes('org.gtk.Actions.SetState'));
    assert.deepEqual(set.slice(-3), ['active-tab', '<1>', '{}']);
    assert.equal(set[set.indexOf('--object-path') + 1], W(3));
    const raise = calls.find((a) => a.includes(RAISE.method));
    assert.deepEqual(raise.slice(-2), [SERVICE, W(3)]);
    assert.equal(raise[raise.indexOf('--dest') + 1], 'org.gnome.Shell');
});

test('focusTab refuses a session it did not open, another server, or no extension to raise', async (t) => {
    const {io, calls} = world(t, {windows: [3]});
    await recordTabs({before: [], groups: [rows('a')], io});
    tab(io, 11, SCREEN('a'));
    tab(io, 12, SCREEN('z'));
    tab(io, 13, SCREEN('a'), ':1.999');
    assert.equal(focusTab({pid: 12, session_id: 'z'}, [], io), false, 'not recorded');
    assert.equal(focusTab({pid: 13, session_id: 'a'}, [], io), false, 'another gnome-terminal server');
    assert.equal(focusTab({pid: 99, session_id: 'a'}, [], io), false, 'not in a gnome-terminal');
    assert.ok(!calls.some((a) => a.includes('org.gtk.Actions.SetState')), 'no tab touched for any of them');

    const off = world(t, {windows: [3], raise: 'missing'});
    await recordTabs({before: [], groups: [rows('a')], io: off.io});
    tab(off.io, 11, SCREEN('a'));
    assert.equal(focusTab({pid: 11, session_id: 'a'}, [], off.io), false, 'the extension is not there');
    const declined = world(t, {windows: [3], raise: false});
    await recordTabs({before: [], groups: [rows('a')], io: declined.io});
    tab(declined.io, 11, SCREEN('a'));
    assert.equal(focusTab({pid: 11, session_id: 'a'}, [], declined.io), false, 'no such window in the Shell');
});
