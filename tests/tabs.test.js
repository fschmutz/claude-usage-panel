// claudectl session: the live-session reader, the snapshot store, autosave, the
// open plan and the terminal argv (claude-code/tabs.js), and the CLI
// (session-cli.js's main). Everything runs against a throwaway HOME and a fake
// /proc; nothing is launched - spawn and exec are faked.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    AUTO_PREFIX, gnomeTerminalArgv, isValidLabel, openTabs, sameSessions, stampLabel, tabCommand,
    tmuxCalls, transcriptPath,
} from '../claude-code/tabs.js';
import {main} from '../claude-code/session-cli.js';
import {tabsDir} from '../claude-code/paths.js';
import {sandboxHome} from './helpers.js';

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
    Object.assign(io, {procDir: proc, pid: 9999, nowMs: () => (clock += 60_000)});
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
});

test('a tab resumes its session by name, then leaves a shell in its cwd', () => {
    assert.deepEqual(tabCommand({name: "it's", session_id: 'id1'}, '/bin/zsh'),
        ['/bin/zsh', '-ic', `claude --name 'it'\\''s' --resume 'id1'; exec '/bin/zsh'`]);
});

test('gnome-terminal: one window, the rest as tabs, each with its own cwd', () => {
    const argv = gnomeTerminalArgv([{name: 'A', cwd: '/a', session_id: '1'}, {name: 'B', cwd: '/b', session_id: '2'}]);
    assert.equal(argv[0], '--window');
    assert.equal(argv.filter((a) => a === '--tab').length, 1);
    assert.deepEqual(argv.slice(1, 5), ['--title', 'A', '--working-directory', '/a']);
    assert.equal(argv[argv.indexOf('--working-directory', 5) + 1], '/b');
});

test('tmux: one detached session, then a window per extra row', () => {
    const calls = tmuxCalls([{name: 'A', cwd: '/a', session_id: '1'}, {name: 'B', cwd: '/b', session_id: '2'}], '/bin/bash', 'S');
    assert.deepEqual(calls[0].slice(0, 8), ['new-session', '-d', '-s', 'S', '-n', 'A', '-c', '/a']);
    assert.deepEqual(calls[1].slice(0, 7), ['new-window', '-t', 'S', '-n', 'B', '-c', '/b']);
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

test('launch spawns ONE detached gnome-terminal for all tabs', (t) => {
    const io = world(t, [A, B]);
    const spawned = [];
    io.spawn = (cmd, args, opts) => {
        spawned.push({cmd, args, opts});
        return {unref() {}};
    };
    const rows = openTabs(io).save('x').sessions;
    openTabs(io).launch(rows, {terminal: 'gnome-terminal'});
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cmd, 'gnome-terminal');
    assert.equal(spawned[0].opts.detached, true);
    assert.equal(spawned[0].args.filter((a) => a === '--tab').length, 1);
});

test('launch falls back to tmux when gnome-terminal is not on PATH', (t) => {
    const io = world(t, [A]);
    const calls = [];
    io.exec = (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'sh') throw new Error('not found');
        return '';
    };
    const r = openTabs(io).launch(openTabs(io).save('x').sessions);
    assert.equal(r.terminal, 'tmux');
    assert.equal(calls.at(-1)[0], 'tmux');
    assert.equal(calls.at(-1)[1][0], 'new-session');
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
