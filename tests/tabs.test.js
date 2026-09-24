// claudectl session: the live-session reader, the snapshot store, autosave, the
// open plan and the terminal argv (claude-code/tabs.js), and the CLI
// (session-cli.js's main). Everything runs against a throwaway HOME and a fake
// /proc; nothing is launched - spawn and exec are faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    AUTO_PREFIX, flagValue, isValidLabel, openTabs, resumePrompt, sameSessions, stampLabel, transcriptPath,
} from '../claude-code/tabs.js';
import {HELP, main} from '../claude-code/session-cli.js';
import {tabsDir} from '../claude-code/paths.js';
import {TMUX_SESSION} from '../claude-code/terminals.js';
import {binDir, sandboxHome} from './helpers.js';

// A HOME holding Claude Code's session registry, the matching transcripts and
// a fake /proc, plus an io bound to all of it. `sessions`: {pid, name, cwd,
// id, start, alive = true, transcript = true, kind = 'interactive'}.
function world(t, sessions = [], {selfParent} = {}) {
    const io = sandboxHome(t, {prefix: 'cup-tabs-'});
    const {home} = io;
    const reg = path.join(home, '.claude', 'sessions');
    const proc = path.join(home, 'proc');
    fs.mkdirSync(reg, {recursive: true});
    let clock = Date.UTC(2026, 8, 23, 17, 0, 0);
    for (const s of sessions) {
        const cwd = s.cwd ?? path.join(home, 'repos', s.name);
        fs.mkdirSync(cwd, {recursive: true});
        fs.writeFileSync(path.join(reg, `${s.pid}.json`), JSON.stringify({
            pid: s.pid, sessionId: s.id, cwd, name: s.name, kind: s.kind ?? 'interactive',
            procStart: String(s.start), startedAt: s.pid, status: 'idle',
        }));
        if (s.transcript !== false) {
            const tp = transcriptPath(path.join(home, '.claude', 'projects'), cwd, s.id);
            fs.mkdirSync(path.dirname(tp), {recursive: true});
            fs.writeFileSync(tp, '{}\n');
        }
        if (s.alive !== false) {
            fs.mkdirSync(path.join(proc, String(s.pid)), {recursive: true});
            // comm with a space and a paren, as the kernel allows; after it,
            // field 3 (state) onward - starttime is field 22
            const fields = Array.from({length: 50}, (_, i) => (i === 19 ? String(s.start) : '0'));
            fields[0] = 'S';
            fs.writeFileSync(path.join(proc, String(s.pid), 'stat'), `${s.pid} (cl (x) y) ${fields.join(' ')}`);
            fs.writeFileSync(path.join(proc, String(s.pid), 'status'), 'Name:\tclaude\nPPid:\t1\n');
        }
    }
    if (selfParent) {
        fs.mkdirSync(path.join(proc, '9999'), {recursive: true});
        fs.writeFileSync(path.join(proc, '9999', 'status'), `Name:\tnode\nPPid:\t${selfParent}\n`);
    }
    // toolDirs: []: only the test's PATH counts, never the host's own tmux
    Object.assign(io, {procDir: proc, pid: 9999, nowMs: () => (clock += 60_000), toolDirs: []});
    return io;
}

const A = {pid: 101, name: 'API', id: 'aaaa1111-0000-0000-0000-000000000000', start: 500};
const B = {pid: 202, name: 'WEB', id: 'bbbb2222-0000-0000-0000-000000000000', start: 600};

// ── Pure helpers ────────────────────────────────────────────────────────────────

test('transcriptPath turns every non-alphanumeric of the cwd into a dash', () => {
    assert.equal(transcriptPath('/p', '/home/me/Git/my_repo.v2', 'id1'), '/p/-home-me-Git-my-repo-v2/id1.jsonl');
});

test('labels: letters, digits, . _ - and no leading separator or path', () => {
    assert.ok(isValidLabel('before-reboot'));
    assert.ok(isValidLabel('2026-09-23_192140'));
    for (const bad of ['', '.hidden', '-x', 'a/b', '../x', 'a b', 'x'.repeat(65)]) assert.ok(!isValidLabel(bad), bad);
});

test('stampLabel is local time, second resolution, sortable', () => {
    const ms = new Date(2026, 8, 3, 7, 5, 9).getTime();
    assert.equal(stampLabel(ms), '2026-09-03_070509');
});

test('sameSessions ignores order, not content', () => {
    const r = (id, name = 'X') => ({session_id: id, cwd: '/c', name});
    assert.ok(sameSessions([r('1'), r('2')], [r('2'), r('1')]));
    assert.ok(!sameSessions([r('1')], [r('1'), r('2')]));
    assert.ok(!sameSessions([r('1', 'X')], [r('1', 'Y')]));
    // a session moved to another window or tab is a new layout to save
    assert.ok(!sameSessions([{...r('1'), window: 'a', tab: 1}], [{...r('1'), window: 'b', tab: 1}]));
    assert.ok(!sameSessions([{...r('1'), window: 'a', tab: 1}], [{...r('1'), window: 'a', tab: 2}]));
});

// ── Live sessions ───────────────────────────────────────────────────────────────

test('liveSessions keeps interactive entries whose process is really running', (t) => {
    const io = world(t, [
        A, B,
        {pid: 303, name: 'DEAD', id: 'c', start: 1, alive: false},
        {pid: 404, name: 'RECYCLED', id: 'd', start: 7},
        {pid: 505, name: 'SDK', id: 'e', start: 9, kind: 'sdk'},
    ]);
    // pid 404 now belongs to another process, started at another time
    const stat = path.join(io.procDir, '404', 'stat');
    fs.writeFileSync(stat, fs.readFileSync(stat, 'utf8').replace(/ 7 /, ' 8 '));
    assert.deepEqual(openTabs(io).liveSessions().map((r) => r.name), ['API', 'WEB']);
});

test('liveSessions takes the registry id, the current one after a /clear', (t) => {
    const io = world(t, [A]);
    assert.equal(openTabs(io).liveSessions()[0].session_id, A.id);
});

test('selfPid finds the session this process runs under', (t) => {
    const io = world(t, [A, B], {selfParent: B.pid});
    const tabs = openTabs(io);
    assert.equal(tabs.selfPid(tabs.liveSessions()), B.pid);
});

test('selfPid on macOS: CLAUDE_PID names the session, else ps walks the parents', (t) => {
    // no /proc at all: the walk used to stop at the first read and return null,
    // so `save --exclude-self` saved the caller and `list` never marked it
    const io = world(t, [A, B]);
    Object.assign(io, {platform: 'darwin', procDir: path.join(io.home, 'no-proc'), env: {CLAUDE_PID: String(B.pid)}});
    io.exec = (cmd, args) => (args[0] === '-o' && args[1] === 'command=' ? 'claude\n' : '');
    const tabs = openTabs(io);
    const live = tabs.liveSessions();
    assert.equal(tabs.selfPid(live), B.pid);
    assert.deepEqual(tabs.save('x', {excludeSelf: true}).sessions.map((s) => s.name), ['API']);
    // no CLAUDE_PID (a terminal of its own): `ps -o ppid=` walks 9999 -> 4242 -> A
    io.env = {};
    const parents = {9999: 4242, 4242: A.pid};
    io.exec = (cmd, args) => {
        if (args[1] === 'command=') return 'claude\n';
        if (args[1] === 'ppid=') return `  ${parents[args[3]] ?? 1}\n`;
        return '';
    };
    assert.equal(openTabs(io).selfPid(live), A.pid);
});

test('selfPid: a CLAUDE_PID that is not a live session falls back to the walk', (t) => {
    const io = world(t, [A, B], {selfParent: B.pid});
    io.env = {CLAUDE_PID: '31337'};
    const tabs = openTabs(io);
    assert.equal(tabs.selfPid(tabs.liveSessions()), B.pid);
});

test('no registry dir means no live sessions, not an error', (t) => {
    const io = sandboxHome(t);
    assert.deepEqual(openTabs(io).liveSessions(), []);
});

// ── Store ───────────────────────────────────────────────────────────────────────

test('save writes a 0600 snapshot of name, cwd and id only', (t) => {
    const io = world(t, [A, B]);
    const snap = openTabs(io).save('before-reboot');
    const file = path.join(tabsDir(io), 'before-reboot.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(stored.sessions[0]).sort(), ['cwd', 'name', 'session_id']);
    assert.equal(snap.sessions.length, 2);
});

test('save records the window and tab of each session tmux can place', (t) => {
    const io = world(t, [A, B]);
    const bin = binDir(t, ['tmux', 'ps'], {home: io.home});
    io.env = {PATH: bin};
    // B sits in tmux window 0, A in window 2 of the same session
    io.exec = (cmd) => {
        if (cmd === 'ps') return '  101 pts/1\n  202 pts/2\n';
        if (cmd === 'tmux') return '/dev/pts/2:work:0\n/dev/pts/9:other:0\n/dev/pts/1:work:2\n';
        return '';
    };
    const snap = openTabs(io).save('laid-out');
    const stored = JSON.parse(fs.readFileSync(path.join(tabsDir(io), 'laid-out.json'), 'utf8'));
    assert.deepEqual(stored.sessions.map((r) => [r.name, r.window, r.tab]), [['WEB', 'tmux:work', 0], ['API', 'tmux:work', 2]]);
    assert.equal(snap.sessions.length, 2);
});

test('only a typed save asks iTerm by AppleScript, never the scheduled autosave', (t) => {
    const io = world(t, [A]);
    const bin = binDir(t, ['ps', 'osascript'], {home: io.home});
    Object.assign(io, {platform: 'darwin', env: {PATH: bin}});
    let asked = 0;
    io.exec = (cmd, args) => {
        if (cmd === 'osascript') return (asked++, '/dev/ttys1\t159\t1\n');
        if (args[0] === '-axco') return 'iTerm2\n';
        if (args[0] === '-ww') return '  101 ttys1\n';
        return args[0] === '-o' ? 'claude\n' : ''; // isAlive
    };
    const tabs = openTabs(io);
    tabs.autosave();
    assert.equal(asked, 0, 'the Automation prompt must never come from a schedule');
    assert.deepEqual(tabs.save('typed').sessions.map((r) => r.window), ['iterm:159']);
    assert.equal(asked, 1);
});

test('save --exclude-self drops the session running the command', (t) => {
    const io = world(t, [A, B], {selfParent: A.pid});
    assert.deepEqual(openTabs(io).save('x', {excludeSelf: true}).sessions.map((s) => s.name), ['WEB']);
});

test('save refuses a bad label and an empty set', (t) => {
    assert.throws(() => openTabs(world(t, [A])).save('../x'), /bad label/);
    assert.throws(() => openTabs(world(t, [])).save('x'), /no running/);
});

test('resolve: newest by default, exact label, unique prefix, 1-based index', (t) => {
    const io = world(t, [A]);
    const tabs = openTabs(io);
    tabs.save('alpha');
    tabs.save('beta');
    tabs.save('betamax');
    assert.equal(tabs.resolve().label, 'betamax');
    assert.equal(tabs.resolve('beta').label, 'beta');
    assert.equal(tabs.resolve('al').label, 'alpha');
    assert.equal(tabs.resolve('3').label, 'alpha');
    assert.throws(() => tabs.resolve('zz'), /not found/);
    assert.throws(() => openTabs(world(t, [])).resolve(), /no snapshots/);
});

test('resolve: an all-digit label is its own snapshot before it is an index', (t) => {
    const io = world(t, [A]);
    const tabs = openTabs(io);
    for (const label of ['2', 'mid', 'newest']) tabs.save(label);
    assert.equal(tabs.resolve('2').label, '2');
    assert.equal(tabs.resolve('3').label, '2', 'a number that is no label is still an index');
    assert.equal(tabs.resolve('1').label, 'newest');
});

test('autosave writes only when the set changed, and keeps the newest N autos', (t) => {
    const io = world(t, [A, B]);
    const tabs = openTabs(io);
    tabs.save('manual');
    const first = tabs.autosave({keep: 2});
    assert.ok(first.saved.label.startsWith(AUTO_PREFIX));
    const again = tabs.autosave({keep: 2});
    assert.equal(again.saved, null);
    assert.match(again.reason, /unchanged since auto-/);
    // the set changes three times: two autos survive, the manual one too
    for (const pid of [B.pid, A.pid]) {
        fs.rmSync(path.join(io.procDir, String(pid)), {recursive: true});
        tabs.autosave({keep: 2});
    }
    assert.equal(tabs.autosave({keep: 2}).reason, 'no running session');
    const labels = tabs.snapshots().map((s) => s.label);
    assert.equal(labels.filter((l) => l.startsWith(AUTO_PREFIX)).length, 2);
    assert.ok(labels.includes('manual'));
});

// ── Open ────────────────────────────────────────────────────────────────────────

test('plan skips running sessions (unless forced) and ones that cannot resume', (t) => {
    const io = world(t, [A, B, {pid: 303, name: 'GONE', id: 'g', start: 3}, {pid: 404, name: 'NOLOG', id: 'n', start: 4, transcript: false}]);
    const tabs = openTabs(io);
    const snap = tabs.save('all');
    fs.rmSync(snap.sessions.find((s) => s.name === 'GONE').cwd, {recursive: true});
    for (const pid of [B.pid, 303, 404]) fs.rmSync(path.join(io.procDir, String(pid)), {recursive: true}); // all but API closed
    const {open, skipped} = tabs.plan(snap);
    assert.deepEqual(open.map((r) => r.name), ['WEB']);
    assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.row.name, s.why.split(':')[0]])),
        {API: 'already running', GONE: 'cwd gone', NOLOG: 'transcript missing'});
    assert.deepEqual(tabs.plan(snap, {force: true, only: ['API']}).open.map((r) => r.name), ['API']);
    assert.deepEqual(tabs.plan(snap, {force: true, skip: ['API', 'GONE', 'NOLOG']}).open.map((r) => r.name), ['WEB']);
});

test('plan never reopens a name or directory holding a control character', (t) => {
    // iTerm / Terminal.app type the command into the tab: ^C or a newline
    // would act before the shell sees any quoting.
    const io = world(t, [A]);
    const tabs = openTabs(io);
    const [row] = tabs.save('x').sessions;
    for (const bad of [{...row, name: 'a\u0003b'}, {...row, cwd: `${row.cwd}\n`}, {...row, name: 'x\u007f'}]) {
        const {open, skipped} = tabs.plan({sessions: [bad]}, {force: true});
        assert.equal(open.length, 0);
        assert.equal(skipped[0].why, 'control character in name or directory');
    }
    assert.equal(tabs.plan({sessions: [row]}, {force: true}).open.length, 1);
});

test('plan also counts an unregistered `claude --resume <id>` process as running', (t) => {
    const io = world(t, [A, B]);
    const tabs = openTabs(io);
    const snap = tabs.save('both');
    // both closed from the registry's point of view ...
    for (const pid of [A.pid, B.pid]) fs.rmSync(path.join(io.procDir, String(pid)), {recursive: true});
    // ... but API still runs as a child that never registered (resumed with its id)
    fs.mkdirSync(path.join(io.procDir, '777'));
    fs.writeFileSync(path.join(io.procDir, '777', 'cmdline'),
        ['claude', '--name', 'API', '--resume', A.id, 'first message'].join('\0') + '\0');
    // a non-claude process quoting an id is not a session
    fs.mkdirSync(path.join(io.procDir, '778'));
    fs.writeFileSync(path.join(io.procDir, '778', 'cmdline'), ['grep', '--resume', B.id].join('\0'));
    const {open, skipped} = tabs.plan(snap);
    assert.deepEqual(open.map((r) => r.name), ['WEB']);
    assert.deepEqual(skipped.map((s) => [s.row.name, s.why]), [['API', 'already running']]);
});

// A claude process the registry never heard of: /proc cmdline, cwd, and a
// terminal (tty_nr, field 7) unless `tty: false`.
function addProcess(io, {pid, argv, cwd, tty = true}) {
    const dir = path.join(io.procDir, String(pid));
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    const fields = Array.from({length: 50}, () => '0');
    fields[0] = 'S';
    fields[4] = tty ? '34819' : '0';
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (claude) ${fields.join(' ')}`);
    if (cwd) fs.symlinkSync(cwd, path.join(dir, 'cwd'));
}

test('unregistered `claude --resume` sessions are listed and autosaved', (t) => {
    const io = world(t, [A]);
    const cwd = path.join(io.home, 'repos', 'WEB');
    fs.mkdirSync(cwd, {recursive: true});
    addProcess(io, {pid: 900, argv: ['claude', '--name', 'WEB', '--resume', B.id, 'first message'], cwd});
    // not sessions: no terminal (a helper), or not claude at all
    addProcess(io, {pid: 901, argv: ['/x/claude', '--chrome-native-host'], cwd, tty: false});
    addProcess(io, {pid: 902, argv: ['vim', '--resume', 'x'], cwd});
    const live = openTabs(io).liveSessions();
    assert.deepEqual(live.map((r) => [r.name, r.session_id, r.status]),
        [['API', A.id, 'idle'], ['WEB', B.id, 'unregistered']]);
    const r = openTabs(io).autosave();
    assert.deepEqual(r.saved.sessions.map((s) => s.name), ['API', 'WEB']);
    assert.deepEqual(r.missed, []);
});

test('claude argv: --resume=ID, a flag after -r, a picker search term, an npm install', (t) => {
    const io = world(t, []);
    const cwd = path.join(io.home, 'repos', 'WEB');
    fs.mkdirSync(cwd, {recursive: true});
    const npm = '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    addProcess(io, {pid: 910, argv: ['claude', `--resume=${A.id}`, '--name=API'], cwd});
    addProcess(io, {pid: 911, argv: ['claude', '-r', '--dangerously-skip-permissions'], cwd});
    addProcess(io, {pid: 912, argv: ['claude', '--resume', 'login bug'], cwd});
    addProcess(io, {pid: 913, argv: ['node', npm, '--resume', B.id, '-n', 'WEB'], cwd});
    addProcess(io, {pid: 914, argv: ['/usr/bin/node', npm], cwd});
    addProcess(io, {pid: 915, argv: ['node', '/srv/app/cli.js', '--resume', B.id], cwd});
    const tabs = openTabs(io);
    // a flag is never a session id, and a search term names no session
    assert.deepEqual(tabs.liveSessions().map((r) => [r.name, r.session_id, r.pid]),
        [['API', A.id, 910], ['WEB', B.id, 913]]);
    // what cannot be resumed by id is reported, the npm install included
    assert.deepEqual(tabs.unaccounted().map((p) => p.pid).sort(), [911, 912, 914]);
});

test('flagValue: an optional value is absent when a flag follows', () => {
    assert.equal(flagValue(['-r', '--verbose'], '--resume', '-r'), null);
    assert.equal(flagValue(['--name', 'x', '-r'], '--resume', '-r'), null);
    assert.equal(flagValue(['--name=a b'], '--name', '-n'), 'a b');
    assert.equal(flagValue(['-n', 'API'], '--name', '-n'), 'API');
    assert.equal(flagValue(['--resume='], '--resume', '-r'), null);
});

test('autosave FAILS on a terminal claude it cannot identify, and says which', async (t) => {
    const io = world(t, [A]);
    addProcess(io, {pid: 903, argv: ['claude', '--name', 'X'], cwd: io.home});
    const r = await cli(io, 'autosave');
    assert.equal(r.code, 1);
    assert.match(r.text, /^saved auto-/m);
    assert.match(r.text, /^NOT SAVED: claude pid 903 in .* - no session id/m);
    assert.match((await cli(io, 'list')).text, /\?\s+claude pid 903 .* cannot be saved/);
});

test('launch runs the resolved steps: terminals detached, tmux in order', (t) => {
    const io = world(t, [A, B]);
    const bin = binDir(t, ['tmux'], {home: io.home});
    io.env = {PATH: bin};
    const spawned = [];
    const execd = [];
    io.spawn = (cmd, args, opts) => {
        spawned.push({cmd, opts});
        return {unref() {}};
    };
    io.exec = (cmd, args) => {
        execd.push([cmd, args[0]]);
        if (args[0] === 'list-sessions') throw new Error('no server running');
        return '';
    };
    io.env = {...io.env, CLAUDECODE: '1', CLAUDE_PID: '1', CLAUDE_CODE_SESSION_ID: 'caller', LANG: 'C'};
    const envs = [];
    const exec0 = io.exec;
    io.exec = (cmd, args, opts) => {
        // the launches; queries (list-panes, list-sessions, has-session) run nothing
        if (['new-session', 'new-window'].includes(args[0])) envs.push(opts.env);
        return exec0(cmd, args, opts);
    };
    const spawn0 = io.spawn;
    io.spawn = (cmd, args, opts) => {
        envs.push(opts.env);
        return spawn0(cmd, args, opts);
    };
    const rows = openTabs(io).save('x').sessions;
    const r = openTabs(io).launch(rows, {terminal: 'ghostty'});
    assert.equal(r.how, 'tmux');
    // tmux new-session / new-window and the terminal: none carries the caller's session
    assert.equal(envs.length, 3);
    for (const e of envs) assert.deepEqual(e, {PATH: io.env.PATH, LANG: 'C'});
    // list-panes: save placing the sessions; list-sessions: the names taken;
    // then the launch itself
    assert.deepEqual(execd, [['tmux', 'list-panes'], ['tmux', 'list-sessions'], ['tmux', 'new-session'], ['tmux', 'new-window']]);
    assert.deepEqual(spawned.map((s) => [s.cmd, s.opts.detached]), [['ghostty', true]]);
});

test('launch never reuses a live tmux session: it opens the next free name', (t) => {
    const io = world(t, [A]);
    io.env = {PATH: binDir(t, ['tmux'], {home: io.home})};
    const execd = [];
    io.exec = (cmd, args) => {
        execd.push(args.slice(0, 4));
        return args[0] === 'list-sessions' ? 'claudectl\n' : '';
    };
    io.spawn = () => ({unref() {}});
    const rows = openTabs(io).save('x').sessions;
    assert.deepEqual(openTabs(io).launch(rows, {terminal: 'ghostty'}).tmuxSessions, [`${TMUX_SESSION}-2`]);
    assert.deepEqual(execd.at(-1), ['new-session', '-d', '-s', `${TMUX_SESSION}-2`]);
});

test('launch gives a tmux window group its saved session name back, unless the server holds it', (t) => {
    const io = world(t, []);
    const bin = binDir(t, ['tmux'], {home: io.home});
    io.env = {PATH: bin};
    const rows = [
        {name: 'A', cwd: '/r/a', session_id: 'a', window: 'tmux:work', tab: 0},
        {name: 'B', cwd: '/r/b', session_id: 'b', window: 'tmux:ops', tab: 0},
        {name: 'C', cwd: '/r/c', session_id: 'c', window: 'tmux:bad;name', tab: 0},
        {name: 'D', cwd: '/r/d', session_id: 'd'},
    ];
    io.exec = (cmd, args) => (args[0] === 'list-sessions' ? 'ops\nclaudectl\n' : '');
    const r = openTabs(io).launch(rows, {terminal: 'ghostty', dryRun: true});
    // ops is running already, bad;name could reach a shell: both fall back
    assert.deepEqual(r.tmuxSessions, ['work', 'claudectl-2', 'claudectl-3', 'claudectl-4']);
});

test('launch with no terminal and no tmux says where to set one', (t) => {
    const io = world(t, [A]);
    io.env = {PATH: path.join(io.home, 'nowhere')};
    io.exec = () => '';
    const rows = openTabs(io).save('x').sessions;
    assert.throws(() => openTabs(io).launch(rows), /no terminal found - set one in the panel preferences/);
});

// ── CLI ─────────────────────────────────────────────────────────────────────────

async function cli(io, ...argv) {
    let text = '';
    const code = await main(argv, {...io, stdout: (s) => { text += s; }});
    return {code, text};
}

test('CLI: list marks the current session, store and show read the snapshot', async (t) => {
    const io = world(t, [A, B], {selfParent: A.pid});
    const list = await cli(io, 'list');
    assert.match(list.text, /^\*\s+1\s+API/m);
    await cli(io, 'save', 'snap1');
    assert.match((await cli(io, 'store')).text, /1 {2}snap1 .* {2}2 {2}API, WEB/);
    assert.match((await cli(io, 'show', 'snap1')).text, /API .*running/);
});

test('CLI: open --dry-run prints the launch, --only narrows it, nothing spawns', async (t) => {
    const io = world(t, [A, B]);
    io.spawn = () => assert.fail('dry-run must not spawn');
    await cli(io, 'save', 's');
    const r = await cli(io, 'open', '--force', '--only=WEB', '--dry-run', '--terminal=gnome-terminal');
    assert.equal(r.code, 0);
    assert.match(r.text, /^open WEB/m);
    assert.doesNotMatch(r.text, /^open API/m);
    assert.match(r.text, /^gnome-terminal "--window"/m);
    assert.match(r.text, /^1 tabs in one gnome-terminal window$/m);
    const w = await cli(io, 'open', '--force', '--dry-run', '--terminal=xterm', '--windows');
    assert.match(w.text, /^2 xterm windows$/m);
    const none = await cli(io, 'open', 's');
    assert.equal(none.code, 1);
    assert.match(none.text, /skip API: already running/);
});

test('CLI: purge asks first, --yes skips the question, --auto and --keep select', async (t) => {
    const io = world(t, [A]);
    const tabs = openTabs(io);
    tabs.save('keepme');
    tabs.save('dropme');
    tabs.autosave();
    const refused = await cli(io, 'purge', 'dropme');
    assert.equal(refused.code, 1);
    assert.ok(tabs.snapshots().some((s) => s.label === 'dropme'));
    const asked = [];
    await main(['purge', 'dropme'], {...io, stdout: () => {}, confirm: async (q) => { asked.push(q); return true; }});
    assert.equal(asked.length, 1);
    await cli(io, 'purge', '--auto', '--yes');
    assert.deepEqual(tabs.snapshots().map((s) => s.label), ['keepme']);
    tabs.save('newer');
    await cli(io, 'purge', '--keep=1', '--yes');
    assert.deepEqual(tabs.snapshots().map((s) => s.label), ['newer']);
});

test('CLI: autosave reports what it did and rejects a bad --keep', async (t) => {
    const io = world(t, [A]);
    assert.match((await cli(io, 'autosave')).text, /^saved auto-.* \(1 sessions\)/);
    assert.match((await cli(io, 'autosave')).text, /^no new snapshot \(unchanged/);
    await assert.rejects(cli(io, 'autosave', '--keep=0'), /whole number/);
    await assert.rejects(cli(io, 'purge', '--keep=abc', '--yes'), /whole number/);
    await assert.rejects(cli(io, 'purge', '--keep', '--yes'), /whole number/);
    assert.equal(openTabs(io).snapshots().length, 1);
});

// ── The GNOME preferences read the same store ───────────────────────────────────

test('the GNOME summary picks the newest snapshot the CLI lists first', async (t) => {
    const {summarizeSnapshots} = await import('../claude-usage-panel@fschmutz.github.io/lib/pure.js');
    const io = world(t, [A, B]);
    const tabs = openTabs(io);
    tabs.save('zeta');
    tabs.autosave();
    tabs.save('alpha');
    fs.writeFileSync(path.join(tabsDir(io), 'broken.json'), '{not json');
    const files = fs.readdirSync(tabsDir(io)).filter((f) => f.endsWith('.json')).map((f) => {
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(path.join(tabsDir(io), f), 'utf8'));
        } catch {
            data = null;
        }
        return {label: f.slice(0, -5), data};
    });
    const summary = summarizeSnapshots(files);
    assert.equal(summary.count, tabs.snapshots().length);
    assert.equal(summary.count, 3);
    assert.equal(summary.autos, 1);
    assert.equal(summary.newest.label, tabs.snapshots()[0].label);
    assert.equal(summary.newest.label, 'alpha');
    assert.deepEqual(summarizeSnapshots([]), {count: 0, autos: 0, newest: null});
});

test('HELP names every step pickTerminal takes, in its order', () => {
    // terminals.js pickTerminal: setting, $TERMINAL, desktop default, first installed
    assert.match(HELP.replace(/\s+/g, ' '),
        /terminal-command`, then \$TERMINAL, then the desktop's default terminal, then the first one installed/);
});

test('the resume prompt says "moments ago" under a minute, never "0m ago"', () => {
    const at = 1_790_000_000_000;
    for (const gap of [0, 5_000, 30_000, 59_999]) {
        const p = resumePrompt({label: 'l', savedAt: at, nowMs: at + gap});
        assert.match(p, /\(moments ago\)/, `gap ${gap} ms`);
        assert.doesNotMatch(p, /0m ago/, `gap ${gap} ms`);
    }
    assert.match(resumePrompt({label: 'l', savedAt: at, nowMs: at + 60_000}), /\(1m ago\)/);
    assert.match(resumePrompt({label: 'l', savedAt: at, nowMs: at + 3_780_000}), /\(1h03m ago\)/);
});
