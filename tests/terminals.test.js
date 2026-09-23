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
    launchSteps, onPath, pickTerminal, resolveTerminal, sessionCommand, terminalArgv,
    terminalForAlternative, terminalForDesktopId, tmuxCalls,
} from '../claude-code/terminals.js';
import {sandboxHome} from './helpers.js';

const rows = [
    {name: 'API', cwd: '/r/api', session_id: 'id-a'},
    {name: "it's", cwd: '/r/web', session_id: 'id-b'},
];

// ── Parity with the panel ───────────────────────────────────────────────────────

test('TERMINALS and terminalArgv match the GNOME port entry for entry', () => {
    assert.deepEqual(TERMINALS.map((t) => [t.bin, t.desktop]), gnome.TERMINALS.map((t) => [t.bin, t.desktop]));
    for (const bin of [...gnome.TERMINALS.map((t) => t.bin), '/usr/bin/kitty', 'my-term', '']) {
        assert.deepEqual(terminalArgv(bin, '/r/a b', 'cmd x'), gnome.terminalArgv(bin, '/r/a b', 'cmd x'), bin);
    }
});

test('the tab command resumes by name then leaves a shell, like the panel click', () => {
    assert.equal(sessionCommand(rows[1]), `claude --name 'it'\\''s' --resume 'id-b'; exec "$SHELL" -i`);
    assert.match(gnome.interactiveResume({cwd: '', sessionId: 'x'}), /; exec "\$SHELL" -i$/);
});

// ── Choosing: the user's setting, then the desktop's default ───────────────────

// [inputs, installed binaries, expected] - run through BOTH ports.
const PICKS = [
    [{configured: 'kitty', envTerminal: 'foot', desktopId: 'org.gnome.Terminal.desktop'}, [], 'kitty'],
    [{envTerminal: 'foot', desktopId: 'org.gnome.Terminal.desktop'}, ['foot', 'gnome-terminal'], 'foot'],
    // the regression: ghostty installed and first in the list must NOT beat the desktop default
    [{envTerminal: 'foot', desktopId: 'org.gnome.Terminal.desktop'}, ['ghostty', 'gnome-terminal'], 'gnome-terminal'],
    [{desktopId: 'org.gnome.Terminal.desktop:new-window'}, ['ghostty', 'gnome-terminal'], 'gnome-terminal'],
    // a default we cannot drive ourselves goes through the spec launcher
    [{desktopId: 'org.gnome.Ptyxis.desktop:new-window'}, ['ghostty', 'xdg-terminal-exec'], 'xdg-terminal-exec'],
    [{desktopId: 'org.gnome.Ptyxis.desktop'}, ['ghostty'], 'ghostty'],
    [{alternative: '/usr/bin/gnome-terminal.wrapper'}, ['ghostty', 'gnome-terminal'], 'gnome-terminal'],
    [{alternative: '/usr/bin/konsole'}, ['ghostty'], 'ghostty'],
    [{}, ['xterm', 'kitty'], 'kitty'],
    [{}, [], null],
];

test('pickTerminal: same choice in the CLI and the GNOME panel, for every case', () => {
    for (const [inputs, bins, want] of PICKS) {
        const installed = (b) => bins.includes(b);
        assert.equal(pickTerminal(inputs, installed), want, JSON.stringify(inputs));
        assert.equal(gnome.pickTerminal(inputs, installed), want, JSON.stringify(inputs));
    }
});

test('desktop ids and the Debian alternative map to the binaries we drive', () => {
    for (const f of [terminalForDesktopId, gnome.terminalForDesktopId]) {
        assert.equal(f('org.gnome.Terminal.desktop'), 'gnome-terminal');
        assert.equal(f('com.mitchellh.ghostty.desktop:new-window'), 'ghostty');
        assert.equal(f('org.gnome.Ptyxis.desktop'), null);
        assert.equal(f(''), null);
    }
    for (const f of [terminalForAlternative, gnome.terminalForAlternative]) {
        assert.equal(f('/usr/bin/gnome-terminal.wrapper'), 'gnome-terminal');
        assert.equal(f('/usr/bin/xterm'), 'xterm');
        assert.equal(f('/usr/bin/x-terminal-emulator'), null);
        assert.equal(f(null), null);
    }
});

// ── Resolution I/O ──────────────────────────────────────────────────────────────

// A PATH dir holding the given executables.
function binDir(t, names) {
    const {home} = sandboxHome(t);
    for (const n of names) {
        fs.writeFileSync(path.join(home, n), '#!/bin/sh\n');
        fs.chmodSync(path.join(home, n), 0o755);
    }
    return home;
}

// exec fake: dconf prints `setting`, xdg-terminal-exec prints `desktopId`.
const fakeExec = ({setting = '', desktopId = ''} = {}) => (cmd, args) => {
    if (cmd === 'dconf') {
        assert.deepEqual(args, ['read', GNOME_TERMINAL_KEY]);
        if (setting === null) throw new Error('no dconf');
        return setting;
    }
    if (cmd === 'xdg-terminal-exec') {
        assert.deepEqual(args, ['--print-id']);
        return desktopId;
    }
    throw new Error(`unexpected ${cmd}`);
};
const linux = (PATH, exec, extra = {}) => ({platform: 'linux', env: {PATH, ...extra}, exec, alternativePath: '/nonexistent'});

test('linux: the GNOME terminal-command preference wins', (t) => {
    const PATH = binDir(t, ['ghostty', 'gnome-terminal']);
    assert.equal(resolveTerminal(linux(PATH, fakeExec({setting: "'kitty'\n"}), {TERMINAL: 'ghostty'})), 'kitty');
    assert.equal(resolveTerminal(linux(PATH, fakeExec({setting: "'/opt/x/foot'"}))), '/opt/x/foot');
});

test('linux: the desktop default beats a merely installed emulator', (t) => {
    const PATH = binDir(t, ['ghostty', 'gnome-terminal', 'xdg-terminal-exec']);
    assert.equal(resolveTerminal(linux(PATH, fakeExec({desktopId: 'org.gnome.Terminal.desktop\n'}))), 'gnome-terminal');
    // without xdg-terminal-exec, the Debian alternative
    const noXte = binDir(t, ['ghostty', 'gnome-terminal']);
    const alt = path.join(noXte, 'x-terminal-emulator');
    fs.symlinkSync('/usr/bin/gnome-terminal.wrapper', alt);
    assert.equal(resolveTerminal({...linux(noXte, fakeExec()), alternativePath: alt}), 'gnome-terminal');
    // no signal at all: the first known one installed
    assert.equal(resolveTerminal(linux(noXte, fakeExec({setting: null}))), 'ghostty');
    assert.equal(resolveTerminal(linux(binDir(t, []), fakeExec({setting: null}))), null);
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
