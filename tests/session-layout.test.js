// Where each session sits on screen (claude-code/layout.js): the parsers, the
// placement order, and the capture against faked ps / tmux / iTerm.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    ITERM_LAYOUT_SCRIPT, captureLayout, parseItermEnv, parseTtyTable, placeRows, ttyPath,
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

test('captureLayout on macOS asks a RUNNING iTerm, and falls back to the env when refused', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const rows = [{pid: 11, name: 'A'}, {pid: 22, name: 'B'}];
    const calls = [];
    const exec = (refuse) => (cmd, args) => {
        calls.push(cmd);
        if (args[0] === '-axco') return 'launchd\niTerm2\niTermServer-3.7.2\n';
        if (cmd === 'osascript') {
            assert.equal(args[1], ITERM_LAYOUT_SCRIPT);
            if (refuse) throw new Error('execution error: Not authorized to send Apple events (-1743)');
            return '/dev/ttys2\t159\t1\n/dev/ttys1\t159\t2\n';
        }
        if (args[0] === '-wwE') return `claude ITERM_SESSION_ID=w0t${args.at(-1) === '11' ? 3 : 1}p0:U`;
        return {11: 'ttys1', 22: 'ttys2'}[args.at(-1)];
    };
    const io = {platform: 'darwin', env: {PATH}, exec: exec(false)};
    assert.deepEqual(captureLayout(rows, io).map((r) => [r.name, r.window, r.tab]),
        [['B', 'iterm:159', 1], ['A', 'iterm:159', 2]]);
    const refused = captureLayout(rows, {...io, exec: exec(true)});
    assert.deepEqual(refused.map((r) => [r.name, r.window, r.tab]), [['B', 'iterm-w0', 2], ['A', 'iterm-w0', 4]]);
    assert.ok(!calls.includes('tmux'), 'no tmux on PATH, none asked');
});

test('captureLayout never starts iTerm: not running (a helper does not count), no AppleScript', (t) => {
    const PATH = binDir(t, ['ps', 'osascript']);
    const exec = (cmd, args) => {
        if (args[0] === '-axco') return 'launchd\nTerminal\niTermServer-3.7.2\n';
        if (cmd === 'osascript') assert.fail('iTerm is not running');
        return '';
    };
    const rows = [{pid: 1, name: 'A'}];
    assert.deepEqual(captureLayout(rows, {platform: 'darwin', env: {PATH}, exec}), rows);
});

test('captureLayout on Linux reads ITERM_SESSION_ID from /proc/<pid>/environ', (t) => {
    const io = sandboxHome(t, {prefix: 'cup-layout-'});
    fs.mkdirSync(path.join(io.procDir, '7'), {recursive: true});
    fs.writeFileSync(path.join(io.procDir, '7', 'environ'), 'A=1\0ITERM_SESSION_ID=w2t0p0:X\0');
    const out = captureLayout([{pid: 7, name: 'A'}], {...io, exec: () => assert.fail('nothing on PATH')});
    assert.deepEqual(out.map((r) => [r.window, r.tab]), [['iterm-w2', 1]]);
});
