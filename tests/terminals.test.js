// claude-code/terminals.js: `claudectl session open` must open the terminal
// the panels are configured to use, the way they open it. Parity with the
// GNOME port's TERMINALS / terminalArgv, the resolution order on both
// platforms, and the steps per terminal kind (native tabs, tmux in one
// window, a window each).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as gnome from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {
    GNOME_TERMINAL_KEY, MAC_DEFAULTS_DOMAIN, TERMINALS, TMUX_SESSION, appleScript, launchSteps, pickTerminal,
    resolveTerminal, sessionCommand, sessionFreeEnv, tabsArgv, terminalArgv, terminalForAlternative,
    terminalForDesktopId, tmuxCalls, tmuxSessionNames, windowGroups,
} from '../claude-code/terminals.js';
import {onPath, toolPath} from '../claude-code/tools.js';
import {binDir, run, sandboxHome} from './helpers.js';

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

// The cwd of a -e terminal reaches `bash -lc` inside a `cd` string. It comes
// from a transcript or a snapshot file, so a space must not split it and
// `$(...)` / `;` / a quote must not run: bash has to land in exactly that dir.
test('xterm and x-terminal-emulator hand bash -lc the cwd as ONE literal word, in both ports', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-term-'));
    t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const dir = path.join(root, "a b;touch PWNED_SEMI $(touch PWNED_SUB) it's");
    fs.mkdirSync(dir);
    for (const port of [{terminalArgv}, gnome]) {
        for (const bin of ['xterm', 'x-terminal-emulator']) {
            const argv = port.terminalArgv(bin, dir, 'pwd');
            assert.deepEqual(argv.slice(0, 4), [bin, '-e', 'bash', '-lc'], bin);
            const r = run('bash', ['-c', argv[4]], {cwd: root});
            assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
            assert.equal(r.stdout.trim(), dir, bin);
        }
    }
    assert.deepEqual(fs.readdirSync(root), [path.basename(dir)], 'nothing injected ran');
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
    assert.deepEqual(steps[0].args, tabsArgv('gnome-terminal', rows));
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
    assert.equal(appleScript('iterm', rows.map((r) => [r.cwd])).match(/create window/g).length, 2);
});

// ── Several windows ─────────────────────────────────────────────────────────────

const placed = [
    {name: 'A', cwd: '/r/a', session_id: 'id-a', window: 'iterm:7', tab: 1},
    {name: 'B', cwd: '/r/b', session_id: 'id-b', window: 'iterm:7', tab: 2},
    {name: 'C', cwd: '/r/c', session_id: 'id-c', window: 'iterm:9', tab: 1},
    {name: 'D', cwd: '/r/d', session_id: 'id-d'},
];

test('windowGroups: one group per saved window, first-seen order; unplaced share one', () => {
    assert.deepEqual(windowGroups(placed).map((g) => g.map((r) => r.name)), [['A', 'B'], ['C'], ['D']]);
    // an old snapshot, no placement at all: one window, as before
    assert.deepEqual(windowGroups(rows).map((g) => g.length), [rows.length]);
});

test('macOS iTerm: a window per saved window, its tabs inside', () => {
    const {how, windows, steps} = launchSteps(placed, 'iterm', {platform: 'darwin'});
    assert.equal(how, 'tabs');
    assert.equal(windows, 3);
    const script = steps[0].args[1];
    assert.equal((script.match(/create window with default profile/g) ?? []).length, 3);
    assert.equal((script.match(/create tab with default profile/g) ?? []).length, 1);
    // B lands in A's window, C opens the next one
    assert.ok(script.indexOf("'id-a'") < script.indexOf('create tab') && script.indexOf('create tab') < script.indexOf("'id-b'"));
});

test('gnome-terminal and xfce4-terminal: a --window per saved window, a --tab per further session', () => {
    for (const bin of ['gnome-terminal', 'xfce4-terminal']) {
        const {how, windows, steps} = launchSteps(placed, bin, {hasTmux: false});
        assert.equal(how, 'tabs', bin);
        assert.equal(windows, 3);
        assert.deepEqual(steps[0].args, tabsArgv(bin, placed));
        assert.deepEqual(steps[0].args.filter((a) => a === '--window' || a === '--tab'),
            ['--window', '--tab', '--window', '--window']);
    }
    assert.deepEqual(tabsArgv('xfce4-terminal', rows).slice(0, 5), ['--window', '-T', 'API', '--working-directory=/r/api', '-e']);
});

test('tmux: one tmux session per saved window, each attached in its own terminal window', () => {
    const {how, tmuxSessions, steps} = launchSteps(placed, 'ghostty', {hasTmux: true});
    assert.equal(how, 'tmux');
    assert.deepEqual(tmuxSessions, [TMUX_SESSION, `${TMUX_SESSION}-2`, `${TMUX_SESSION}-3`]);
    assert.deepEqual(steps.filter((s) => s.cmd === 'tmux').map((s) => s.args.slice(0, 4)), [
        ['new-session', '-d', '-s', TMUX_SESSION], ['new-window', '-t', TMUX_SESSION, '-n'],
        ['new-session', '-d', '-s', `${TMUX_SESSION}-2`], ['new-session', '-d', '-s', `${TMUX_SESSION}-3`],
    ]);
    assert.deepEqual(steps.filter((s) => s.cmd === 'ghostty').map((s) => s.args.at(-1)),
        tmuxSessions.map((n) => `tmux attach -t ${n}`));
    const mac = launchSteps(placed, 'terminal', {platform: 'darwin', hasTmux: true});
    assert.equal((mac.steps.at(-1).args[1].match(/do script "tmux attach/g) ?? []).length, 3);
});

test('tmuxSessionNames: saved tmux names come back, the rest take the first free claudectl-N', () => {
    const g = (window) => [{name: 'x', cwd: '/', session_id: 'x', window}];
    assert.deepEqual(tmuxSessionNames([g('tmux:work'), g('iterm:7'), g(undefined)]), ['work', TMUX_SESSION, `${TMUX_SESSION}-2`]);
    // a name the server already runs is not reused, nor is one a shell would split
    assert.deepEqual(tmuxSessionNames([g('tmux:work'), g('tmux:a b'), g('iterm:1')], ['work', TMUX_SESSION]),
        [`${TMUX_SESSION}-2`, `${TMUX_SESSION}-3`, `${TMUX_SESSION}-4`]);
    // a saved claudectl-2 is kept, and the fallback steps around it
    assert.deepEqual(tmuxSessionNames([g('iterm:1'), g(`tmux:${TMUX_SESSION}-2`), g('iterm:2')]),
        [TMUX_SESSION, `${TMUX_SESSION}-2`, `${TMUX_SESSION}-3`]);
});

test('toolPath appends only the tool dirs PATH lacks, PATH order first', () => {
    assert.equal(toolPath('/usr/bin:/home/u/bin', ['/opt/homebrew/bin', '/usr/bin']), '/usr/bin:/home/u/bin:/opt/homebrew/bin');
    assert.equal(toolPath(undefined, ['/bin']), '/bin');
});

// ── The first message of a restored session ─────────────────────────────────────

test('the resume prompt reaches claude as ONE argument, newlines and quotes intact', async () => {
    const {resumePrompt} = await import('../claude-code/tabs.js');
    const {run} = await import('./helpers.js');
    const prompt = `${resumePrompt({label: 'auto-x', savedAt: 0, nowMs: 3_600_000})}\nit's "quoted" $HOME \`x\``;
    // a stub claude that prints its argv as JSON, then the real bash parse
    const stub = 'claude() { node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "$@"; }; ';
    const cmd = sessionCommand({name: "it's", session_id: 'id-b'}, prompt).replace(/; exec "\$SHELL" -i$/, '');
    const r = run('bash', ['-c', stub + cmd]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['--name', "it's", '--resume', 'id-b', prompt]);
    // and through the gnome-terminal layer: its --command is itself a shell word list
    const gt = tabsArgv('gnome-terminal', [{name: 'A', cwd: '/', session_id: 'id-a'}], prompt);
    const inner = gt[gt.indexOf('--command') + 1];
    // split it into words the way GLib does (POSIX quoting): bash, -lc, CMD
    const r2 = run('bash', ['-c', `${stub}eval "set -- $1"; eval "\${3%%; exec *}"`, '_', inner]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.deepEqual(JSON.parse(r2.stdout), ['--name', 'A', '--resume', 'id-a', prompt]);
});

test('the resume prompt says when it was saved and what died with the process', async () => {
    const {resumePrompt} = await import('../claude-code/tabs.js');
    const saved = new Date(2026, 8, 23, 19, 21).getTime();
    const p = resumePrompt({label: 'auto-2026-09-23_192140', savedAt: saved, nowMs: saved + (3 * 60 + 44) * 60_000});
    assert.match(p, /snapshot auto-2026-09-23_192140 at 19:21 \(3h44m ago\) and reopened at 23:05/);
    assert.match(p, /background shells, Monitors, \/loop and scheduled wakeups/);
    assert.match(p, /nothing destructive, outward-facing or still waiting on my answer without asking me first/);
    assert.equal(sessionCommand({name: 'A', session_id: 'i'}), `claude --name 'A' --resume 'i'; exec "$SHELL" -i`);
});

// ── The calling session's environment stays behind ──────────────────────────────

test('sessionFreeEnv drops what names the calling Claude session, keeps configuration', () => {
    // exactly what a gnome-terminal tab inherited on 2026-09-23 when `open` ran
    // from a Claude shell: each resumed session thought it was HOME's child
    const inherited = {
        CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_EXECPATH: '/x/claude', CLAUDE_CODE_MESSAGING_SOCKET: '/run/cc-socks/63052.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_SESSION_ATTENDED: '1',
        CLAUDE_CODE_SESSION_ID: 'db1b26c0', CLAUDE_EFFORT: 'medium', CLAUDE_PID: '63052',
    };
    const config = {
        PATH: '/usr/bin', HOME: '/h', SHELL: '/bin/bash', CLAUDE_CONFIG_DIR: '/c',
        CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000', ANTHROPIC_MODEL: 'm',
    };
    assert.deepEqual(sessionFreeEnv({...inherited, ...config}), config);
    // a future variable of the same families is dropped too
    assert.deepEqual(sessionFreeEnv({CLAUDE_CODE_SESSION_KIND: 'x', CLAUDE_CODE_MESSAGING_V2: 'y'}), {});
});

test('sessionFreeEnv drops what Claude injects into its tool shells, only under a Claude shell', () => {
    // a Claude Code tool shell on 2026-09-24: none of these is in the claude
    // process's own environment, so none is the user's
    const injected = {
        GIT_EDITOR: 'true', AI_AGENT: 'claude-code_2-1-281_agent', COREPACK_ENABLE_AUTO_PIN: '0',
        NoDefaultCurrentDirectoryInExePath: '1',
    };
    const config = {PATH: '/usr/bin', HOME: '/h'};
    assert.deepEqual(sessionFreeEnv({CLAUDECODE: '1', ...injected, ...config}), config);
    // the user's own values survive, under Claude or not
    const own = {...config, GIT_EDITOR: 'vim', AI_AGENT: 'mine', COREPACK_ENABLE_AUTO_PIN: '1'};
    assert.deepEqual(sessionFreeEnv({CLAUDECODE: '1', ...own}), own);
    // outside a Claude shell nothing is guessed away, not even GIT_EDITOR=true
    assert.deepEqual(sessionFreeEnv({...injected, ...config}), {...injected, ...config});
});

test('the resume prompt names the peers, and who shares a working tree', async () => {
    const {peersNote, resumePrompt} = await import('../claude-code/tabs.js');
    const peers = [
        {name: 'api', cwd: '/h/Git/api'}, {name: 'api-admin', cwd: '/h/Git/api'},
        {name: 'web', cwd: '/h/Git/web'}, {name: 'HOME', cwd: '/h'},
    ];
    const note = peersNote(peers, '/h');
    assert.match(note, /api \(~\/Git\/api\), api-admin \(~\/Git\/api\), web \(~\/Git\/web\), HOME \(~\) are up too/);
    assert.match(note, /reachable by name \(ListAgents, SendMessage\)/);
    assert.match(note, /^api, api-admin share the working tree ~\/Git\/api: tell the others before you commit/m);
    assert.doesNotMatch(note, /web, /);
    // alone: nothing to say; and the prompt carries the note before the rules
    assert.equal(peersNote([peers[0]], '/h'), '');
    const p = resumePrompt({label: 'l', savedAt: 0, nowMs: 60_000, peers, homedir: '/h'});
    assert.ok(p.indexOf('You are not alone') < p.indexOf('Same rules as before'));
    assert.doesNotMatch(resumePrompt({label: 'l', savedAt: 0, nowMs: 60_000}), /not alone/);
});
