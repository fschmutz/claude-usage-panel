// claude-code/terminals.js: `claudectl session open` must open the terminal
// the panels are configured to use, the way they open it. Parity with the
// GNOME port's TERMINALS / terminalArgv, the resolution order on both
// platforms, and the steps per terminal kind (native tabs, tmux in one
// window, a window each).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as gnome from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {
    GNOME_TERMINAL_KEY, MAC_DEFAULTS_DOMAIN, TERMINALS, TMUX_SESSION, appleScript, gnomeTabsArgv,
    launchSteps, onPath, resolveTerminal, sessionCommand, terminalArgv, tmuxCalls,
} from '../claude-code/terminals.js';
import {sandboxHome} from './helpers.js';

const rows = [
    {name: 'API', cwd: '/r/api', session_id: 'id-a'},
    {name: "it's", cwd: '/r/web', session_id: 'id-b'},
];

// ── Parity with the panel ───────────────────────────────────────────────────────

test('TERMINALS and terminalArgv match the GNOME port entry for entry', () => {
    assert.deepEqual(TERMINALS.map((t) => t.bin), gnome.TERMINALS.map((t) => t.bin));
    for (const bin of [...gnome.TERMINALS.map((t) => t.bin), '/usr/bin/kitty', 'my-term', '']) {
        assert.deepEqual(terminalArgv(bin, '/r/a b', 'cmd x'), gnome.terminalArgv(bin, '/r/a b', 'cmd x'), bin);
    }
});

test('the tab command resumes by name then leaves a shell, like the panel click', () => {
    assert.equal(sessionCommand(rows[1]), `claude --name 'it'\\''s' --resume 'id-b'; exec "$SHELL" -i`);
    assert.match(gnome.interactiveResume({cwd: '', sessionId: 'x'}), /; exec "\$SHELL" -i$/);
});

// ── Resolution: the user's setting first ────────────────────────────────────────

// A PATH dir holding the given executables.
function binDir(t, names) {
    const {home} = sandboxHome(t);
    for (const n of names) {
        fs.writeFileSync(path.join(home, n), '#!/bin/sh\n');
        fs.chmodSync(path.join(home, n), 0o755);
    }
    return home;
}

const dconf = (value) => (cmd, args) => {
    assert.deepEqual([cmd, ...args], ['dconf', 'read', GNOME_TERMINAL_KEY]);
    if (value === null) throw new Error('no dconf');
    return value;
};

test('linux: the GNOME terminal-command preference wins', (t) => {
    const PATH = binDir(t, ['ghostty', 'gnome-terminal']);
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH, TERMINAL: 'ghostty'}, exec: dconf("'kitty'\n")}), 'kitty');
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH}, exec: dconf("'/opt/x/foot'")}), '/opt/x/foot');
});

test('linux: then $TERMINAL when it is installed, then the first known one', (t) => {
    const PATH = binDir(t, ['gnome-terminal', 'kitty']);
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH, TERMINAL: 'gnome-terminal'}, exec: dconf("''")}), 'gnome-terminal');
    // $TERMINAL not installed: fall through; kitty comes before gnome-terminal
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH, TERMINAL: 'nope'}, exec: dconf('')}), 'kitty');
    // no dconf at all (not GNOME): same fallbacks
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH}, exec: dconf(null)}), 'kitty');
    assert.equal(resolveTerminal({platform: 'linux', env: {PATH: binDir(t, [])}, exec: dconf(null)}), null);
});

test('macOS: the app terminalChoice, auto = iTerm when installed', (t) => {
    const defaults = (value) => (cmd, args) => {
        assert.deepEqual([cmd, ...args], ['defaults', 'read', MAC_DEFAULTS_DOMAIN, 'terminalChoice']);
        return value;
    };
    const {home} = sandboxHome(t);
    const iterm = path.join(home, 'iTerm.app');
    assert.equal(resolveTerminal({platform: 'darwin', exec: defaults('terminal\n'), itermApp: iterm}), 'terminal');
    assert.equal(resolveTerminal({platform: 'darwin', exec: defaults('iterm\n'), itermApp: iterm}), 'iterm');
    assert.equal(resolveTerminal({platform: 'darwin', exec: defaults('auto\n'), itermApp: iterm}), 'terminal');
    fs.mkdirSync(iterm);
    assert.equal(resolveTerminal({platform: 'darwin', exec: defaults('auto\n'), itermApp: iterm}), 'iterm');
});

test('onPath: bare names on PATH, paths as given, never a directory', (t) => {
    const PATH = binDir(t, ['tmux']);
    assert.ok(onPath('tmux', PATH));
    assert.ok(!onPath('kitty', PATH));
    assert.ok(onPath(path.join(PATH, 'tmux')));
    assert.ok(!onPath(PATH));
});

// ── Steps ───────────────────────────────────────────────────────────────────────

test('gnome-terminal: native tabs in ONE detached process', () => {
    const {how, steps} = launchSteps(rows, 'gnome-terminal', {hasTmux: true});
    assert.equal(how, 'tabs');
    assert.equal(steps.length, 1);
    assert.equal(steps[0].detach, true);
    assert.deepEqual(steps[0].args, gnomeTabsArgv(rows));
    assert.equal(steps[0].args.filter((a) => a === '--tab').length, 1);
    assert.deepEqual(steps[0].args.slice(1, 5), ['--title', 'API', '--working-directory', '/r/api']);
});

test('any other terminal with tmux: one window of IT, attached to one tmux session', () => {
    const {how, steps} = launchSteps(rows, 'ghostty', {hasTmux: true});
    assert.equal(how, 'tmux');
    assert.deepEqual(steps.slice(0, 2).map((s) => s.args), tmuxCalls(rows));
    assert.deepEqual(steps[2], {
        cmd: 'ghostty', detach: true,
        args: terminalArgv('ghostty', '/r/api', `tmux attach -t ${TMUX_SESSION}`).slice(1),
    });
});

test('--windows, or no tmux: one window per session, each in its own cwd', () => {
    for (const opts of [{hasTmux: true, windows: true}, {hasTmux: false}]) {
        const {how, steps} = launchSteps(rows, 'kitty', opts);
        assert.equal(how, 'windows');
        assert.deepEqual(steps.map((s) => [s.cmd, ...s.args]),
            rows.map((r) => terminalArgv('kitty', r.cwd, sessionCommand(r))));
    }
});

test('--tmux takes the tmux layout even on gnome-terminal; terminal=tmux starts no terminal', () => {
    assert.equal(launchSteps(rows, 'gnome-terminal', {hasTmux: true, tmux: true}).how, 'tmux');
    const only = launchSteps(rows, 'tmux', {hasTmux: true});
    assert.equal(only.how, 'tmux-only');
    assert.ok(only.steps.every((s) => s.cmd === 'tmux'));
});

test('tmux windows: named, in their cwd, the command quoted for the shell', () => {
    const [first, second] = tmuxCalls(rows, 'S');
    assert.deepEqual(first.slice(0, 8), ['new-session', '-d', '-s', 'S', '-n', 'API', '-c', '/r/api']);
    assert.deepEqual(second.slice(0, 7), ['new-window', '-t', 'S', '-n', "it's", '-c', '/r/web']);
    assert.equal(second[7], `bash -lc 'claude --name '\\''it'\\''\\'\\'''\\''s'\\'' --resume '\\''id-b'\\''; exec "$SHELL" -i'`);
});

test('macOS iTerm: one window, then a tab per further session', () => {
    const {how, steps} = launchSteps(rows, 'iterm', {platform: 'darwin', hasTmux: true});
    assert.equal(how, 'tabs');
    const script = steps[0].args[1];
    assert.equal((script.match(/create window with default profile/g) ?? []).length, 1);
    assert.equal((script.match(/create tab with default profile/g) ?? []).length, 1);
    assert.match(script, /write text "cd '\/r\/api' && claude --name 'API' --resume 'id-a'; exec \\"\$SHELL\\" -i"/);
});

test('macOS Terminal.app: tmux in one window when installed, else a window each', () => {
    const tmux = launchSteps(rows, 'terminal', {platform: 'darwin', hasTmux: true});
    assert.equal(tmux.how, 'tmux');
    assert.match(tmux.steps.at(-1).args[1], /tell application "Terminal"[\s\S]*do script "tmux attach -t claudectl"/);
    const win = launchSteps(rows, 'terminal', {platform: 'darwin', hasTmux: false});
    assert.equal(win.how, 'windows');
    assert.equal((win.steps[0].args[1].match(/do script/g) ?? []).length, 2);
    assert.equal(appleScript('iterm', rows, {tabs: false}).match(/create window/g).length, 2);
});
