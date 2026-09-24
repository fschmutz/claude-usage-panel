// Where each session sits on screen (claude-code/layout.js): the parsers, the
// placement order, and the capture against faked ps / tmux / iTerm.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    ITERM_LAYOUT_SCRIPT, TERMINAL_LAYOUT_SCRIPT, captureLayout, parseItermEnv, parseKittyLs, parseTtyTable,
    parseWeztermList, placeRows, ttyPath,
} from '../claude-code/layout.js';
import {sandboxHome} from './helpers.js';

test('parseTtyTable keeps listing order and skips malformed lines', () => {
    const m = parseTtyTable('/dev/ttys4\t159\t2\nbroken\n/dev/ttys2\t159\tx\n/dev/ttys9\t160\t1\n', 'iterm:');
    assert.deepEqual([...m], [
        ['/dev/ttys4', {window: 'iterm:159', tab: 2, order: 0}],
        ['/dev/ttys9', {window: 'iterm:160', tab: 1, order: 3}],
    ]);
});

test('parseItermEnv reads w/t of ITERM_SESSION_ID, tabs 1-based', () => {
    assert.deepEqual(parseItermEnv('w1t4p0:060770AD-03AD'), {window: 'iterm-w1', tab: 5, order: 10004});
    assert.equal(parseItermEnv(''), null);
    assert.equal(parseItermEnv('garbage'), null);
});

test('ttyPath: ps values to device paths, no tty to null', () => {
    assert.equal(ttyPath('ttys006\n'), '/dev/ttys006');
    assert.equal(ttyPath('pts/3'), '/dev/pts/3');
    assert.equal(ttyPath('??'), null);
    assert.equal(ttyPath('?'), null);
    assert.equal(ttyPath(''), null);
});

test('placeRows: tmux beats iTerm, AppleScript beats the env, windows never interleave', () => {
    const rows = [1, 2, 3, 4, 5].map((pid) => ({pid, name: `S${pid}`}));
    const ttys = {1: '/dev/t1', 2: '/dev/t2', 3: '/dev/t3', 4: '/dev/t4', 5: null};
    const tmux = parseTtyTable('/dev/t3\twork\t1\n', 'tmux:');
    const iterm = parseTtyTable('/dev/t2\t9\t2\n/dev/t3\t9\t1\n/dev/t1\t8\t1\n/dev/t4\t9\t1\n', 'iterm:');
    const out = placeRows(rows, {
        ttyOf: (pid) => ttys[pid], tables: [tmux, iterm],
        envOf: (pid) => (pid === 1 || pid === 5 ? 'w3t0p0:X' : null),
    });
    assert.deepEqual(out.map((r) => [r.name, r.window, r.tab]), [
        ['S3', 'tmux:work', 1],
        ['S4', 'iterm:9', 1],
        ['S2', 'iterm:9', 2],
        ['S1', 'iterm:8', 1],
        ['S5', 'iterm-w3', 1],
    ]);
});

test('placeRows: nothing known leaves rows as they were', () => {
    const rows = [{pid: 1, name: 'a'}, {pid: 2, name: 'b'}];
    assert.deepEqual(placeRows(rows, {ttyOf: () => null, tables: [], envOf: () => null}), rows);
});

function binDir(t, names) {
    const {home} = sandboxHome(t, {prefix: 'cup-layout-'});
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const n of names) {
        fs.writeFileSync(path.join(bin, n), '#!/bin/sh\n');
        fs.chmodSync(path.join(bin, n), 0o755);
    }
    return bin;
}

// fake `ps`: the batched tty listing, the batched -E env listing, the app list
const fakePs = (args, {ttys = {}, envs = {}, apps = ''} = {}) => {
    if (args[0] === '-axco') return apps;
    const table = args[0] === '-wwE' ? envs : ttys;
    return args.at(-1).split(',').filter((pid) => table[pid]).map((pid) => `${pid} ${table[pid]}`).join('\n');
};

test('captureLayout on macOS asks a RUNNING iTerm, and falls back to the env when refused', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const rows = [{pid: 11, name: 'A'}, {pid: 22, name: 'B'}];
    const calls = [];
    const exec = (refuse) => (cmd, args) => {
        calls.push([cmd, args[0]]);
        if (cmd === 'osascript') {
            assert.equal(args[1], ITERM_LAYOUT_SCRIPT);
            if (refuse) throw new Error('execution error: Not authorized to send Apple events (-1743)');
            return '/dev/ttys2\t159\t1\n/dev/ttys1\t159\t2\n';
        }
        return fakePs(args, {
            apps: 'launchd\niTerm2\niTermServer-3.7.2\n',
            ttys: {11: 'ttys1', 22: 'ttys2'},
            envs: {11: 'claude ITERM_SESSION_ID=w0t3p0:U', 22: 'claude ITERM_SESSION_ID=w0t1p0:U'},
        });
    };
    const io = {platform: 'darwin', env: {PATH}, exec: exec(false), toolDirs: []};
    assert.deepEqual(captureLayout(rows, io, {askApps: true}).map((r) => [r.name, r.window, r.tab]),
        [['B', 'iterm:159', 1], ['A', 'iterm:159', 2]]);
    const refused = captureLayout(rows, {...io, exec: exec(true)}, {askApps: true});
    assert.deepEqual(refused.map((r) => [r.name, r.window, r.tab]), [['B', 'iterm-w0', 2], ['A', 'iterm-w0', 4]]);
    assert.ok(!calls.some(([c]) => c === 'tmux'), 'no tmux on PATH, none asked');
    // one ps for every tty, one for every environment: never one per session
    assert.equal(calls.filter(([c, a]) => c === 'ps' && a === '-ww').length, 2);
});

test('captureLayout never starts iTerm: not running (a helper does not count), no AppleScript', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const exec = (cmd, args) => {
        if (cmd === 'osascript') assert.fail('iTerm is not running');
        return fakePs(args, {apps: 'launchd\niTermServer-3.7.2\n'});
    };
    const rows = [{pid: 1, name: 'A'}];
    assert.deepEqual(captureLayout(rows, {platform: 'darwin', env: {PATH}, exec, toolDirs: []}, {askApps: true}), rows);
});

test('captureLayout without askApps (the autosave) never runs AppleScript', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const exec = (cmd, args) => {
        if (cmd === 'osascript') assert.fail('the Automation prompt must never come from a schedule');
        if (args[0] === '-axco') assert.fail('no app listing either');
        return fakePs(args, {ttys: {1: 'ttys1'}, envs: {1: 'claude ITERM_SESSION_ID=w1t0p0:U'}});
    };
    const out = captureLayout([{pid: 1, name: 'A'}], {platform: 'darwin', env: {PATH}, exec, toolDirs: []});
    assert.deepEqual(out.map((r) => [r.window, r.tab]), [['iterm-w1', 1]]);
});

test('captureLayout places Terminal.app tabs by AppleScript', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const exec = (cmd, args) => {
        if (cmd === 'osascript') {
            assert.equal(args[1], TERMINAL_LAYOUT_SCRIPT);
            return '/dev/ttys5\t42\t1\n/dev/ttys6\t42\t2\n';
        }
        return fakePs(args, {apps: 'launchd\nTerminal\n', ttys: {1: 'ttys6', 2: 'ttys5'}});
    };
    const out = captureLayout([{pid: 1, name: 'A'}, {pid: 2, name: 'B'}],
        {platform: 'darwin', env: {PATH}, exec, toolDirs: []}, {askApps: true});
    assert.deepEqual(out.map((r) => [r.name, r.window, r.tab]), [['B', 'terminal:42', 1], ['A', 'terminal:42', 2]]);
    assert.match(TERMINAL_LAYOUT_SCRIPT, /tell application "Terminal"[\s\S]*tty of t/);
});

test('captureLayout finds tmux outside PATH: the scheduler has no Homebrew on it', (t) => {
    const tools = binDir(t, ['tmux']);
    const PATH = binDir(t, ['ps']);
    const seen = [];
    const exec = (cmd, args, opts) => {
        seen.push(opts.env.PATH);
        if (cmd === 'tmux') return '/dev/pts/4:work:1\n';
        return fakePs(args, {ttys: {1: 'pts/4'}});
    };
    const out = captureLayout([{pid: 1, name: 'A'}], {platform: 'linux', env: {PATH}, exec, toolDirs: [tools]});
    assert.deepEqual(out.map((r) => [r.window, r.tab]), [['tmux:work', 1]]);
    assert.ok(seen.every((p) => p === `${PATH}:${tools}`));
});

test('parseWeztermList: windows > tabs by listing order, keyed by tty', () => {
    const json = JSON.stringify([
        {window_id: 3, tab_id: 10, pane_id: 1, tty_name: '/dev/pts/1'},
        {window_id: 3, tab_id: 10, pane_id: 2, tty_name: '/dev/pts/2'},
        {window_id: 3, tab_id: 14, pane_id: 3, tty_name: '/dev/pts/3'},
        {window_id: 5, tab_id: 20, pane_id: 4, tty_name: '/dev/pts/4'},
        {window_id: 5, tab_id: 21, pane_id: 5},
    ]);
    const m = parseWeztermList(json);
    assert.deepEqual([...m].map(([k, v]) => [k, v.window, v.tab]), [
        ['/dev/pts/1', 'wezterm:3', 1], ['/dev/pts/2', 'wezterm:3', 1],
        ['/dev/pts/3', 'wezterm:3', 2], ['/dev/pts/4', 'wezterm:5', 1],
    ]);
    assert.equal(parseWeztermList('not json').size, 0);
});

test('parseKittyLs: OS windows > tabs, keyed by the foreground pids', () => {
    const json = JSON.stringify([{id: 1, tabs: [
        {windows: [{pid: 100, foreground_processes: [{pid: 101}]}]},
        {windows: [{pid: 200, foreground_processes: [{pid: 201}]}]},
    ]}, {id: 2, tabs: [{windows: [{pid: 300, foreground_processes: []}]}]}]);
    const m = parseKittyLs(json);
    assert.deepEqual(m.get('pid:201'), {window: 'kitty:1', tab: 2, order: 3});
    assert.equal(m.get('pid:300').window, 'kitty:2');
    // placeRows matches kitty by pid when the tty is unknown
    const out = placeRows([{pid: 101, name: 'A'}, {pid: 201, name: 'B'}], {ttyOf: () => null, tables: [m], envOf: () => null});
    assert.deepEqual(out.map((r) => [r.name, r.window, r.tab]), [['A', 'kitty:1', 1], ['B', 'kitty:1', 2]]);
});

test('captureLayout asks kitty only from inside kitty, wezterm without starting its server', (t) => {
    const PATH = binDir(t, ['ps', 'kitty', 'wezterm']);
    const calls = [];
    const exec = (cmd, args) => {
        calls.push([cmd, ...args]);
        return cmd === 'ps' ? '' : '[]';
    };
    captureLayout([{pid: 1, name: 'A'}], {platform: 'linux', env: {PATH}, exec, toolDirs: []});
    assert.ok(!calls.some(([c]) => c === 'kitty'), 'outside kitty, `kitty @` would talk to the wrong tty');
    assert.deepEqual(calls.find(([c]) => c === 'wezterm'), ['wezterm', 'cli', '--no-auto-start', 'list', '--format', 'json']);
    calls.length = 0;
    captureLayout([{pid: 1, name: 'A'}], {platform: 'linux', env: {PATH, KITTY_LISTEN_ON: 'unix:/tmp/k'}, exec, toolDirs: []});
    assert.deepEqual(calls.find(([c]) => c === 'kitty'), ['kitty', '@', '--to', 'unix:/tmp/k', 'ls']);
});
