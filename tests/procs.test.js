// claude-code/procs.js - the process-table primitives every Node module reads
// processes through - and the registry over them (claude-code/registry.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    claudeArgs, isClaudeArgv, isClaudeCommand, pidAlive, processIdentity, procStat,
} from '../claude-code/procs.js';
import {openRegistry} from '../claude-code/registry.js';
import {world} from './session-world.js';

test('procStat reads ppid, tty and start time after the LAST paren of comm', (t) => {
    const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-procs-'));
    t.after(() => fs.rmSync(proc, {recursive: true, force: true}));
    fs.mkdirSync(path.join(proc, '42'));
    const fields = Array.from({length: 50}, (_, i) => String(i));
    fields[0] = 'S';
    fields[1] = '7'; // ppid
    fields[4] = '34819'; // tty_nr
    fields[19] = '123456'; // starttime
    fs.writeFileSync(path.join(proc, '42', 'stat'), `42 (a) b) (c) ${fields.join(' ')}\n`);
    assert.deepEqual(procStat(42, proc), {ppid: 7, ttyNr: 34819, startTime: '123456'});
    assert.equal(procStat(43, proc), null, 'gone');
    fs.mkdirSync(path.join(proc, '44'));
    fs.writeFileSync(path.join(proc, '44', 'stat'), 'garbage');
    assert.equal(procStat(44, proc), null);
    assert.equal(processIdentity({platform: 'linux', procDir: proc}, 42), '123456');
    assert.equal(processIdentity({platform: 'linux', procDir: proc}, 0), null);
});

test('one "is this claude" test for argv and ps lines alike', () => {
    for (const argv of [
        ['claude'], ['/opt/homebrew/bin/claude', '--resume', 'x'], ['node', '/usr/lib/node_modules/.bin/claude'],
        ['bun', '/x/node_modules/@anthropic-ai/claude-code/cli.js', '-r'],
    ]) {
        assert.ok(isClaudeArgv(argv), argv.join(' '));
        assert.ok(isClaudeCommand(`  ${argv.join(' ')}\n`), argv.join(' '));
    }
    // an editor, a grep or a path merely ending in /claude is not claude
    for (const line of ['vim /home/me/claude', 'grep claude', '/usr/bin/claude-usage', 'node /x/claude.js', '']) {
        assert.equal(isClaudeCommand(line), false, line);
    }
    assert.deepEqual(claudeArgs(['node', '/x/claude', '--name', 'API']), ['--name', 'API']);
});

test('pidAlive: this process is, a pid that cannot exist is not', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(2 ** 22 + 12345), false);
});

test('processIdentity on macOS is ps start time + command line, null once gone', () => {
    const exec = (cmd, args) => {
        assert.deepEqual([cmd, args.slice(0, 2)], ['ps', ['-o', 'lstart=,command=']]);
        if (args[3] === '7') return 'Sat Nov  7 10:00:00 2026     claude --resume x\n';
        throw new Error('exit 1');
    };
    assert.equal(processIdentity({platform: 'darwin', exec}, 7), 'Sat Nov  7 10:00:00 2026     claude --resume x');
    assert.equal(processIdentity({platform: 'darwin', exec}, 8), null);
});

// Asking "which sessions are up" never builds the snapshot store: pause, awake
// and waiting (and the hooks over them) read the registry, nothing more.
test('the pid-only consumers import registry.js, never tabs.js', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-code');
    for (const f of ['pause.js', 'pause-hook.js', 'awake.js', 'waiting.js', 'waiting-hook.js']) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        assert.doesNotMatch(text, /from '\.\/tabs\.js'/, f);
    }
    for (const f of ['pause.js', 'awake.js', 'waiting.js']) {
        assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /from '\.\/registry\.js'/, f);
    }
});

// macOS has no /proc: a registry pid counts as live only when ps shows claude
// itself running under it. A regex over the whole line used to accept any
// process whose arguments merely ended in /claude.
test('registry on macOS: a pid now running something else is not a live session', (t) => {
    const io = world(t, [{pid: 101, name: 'API', id: 'aaaa1111-0000-0000-0000-000000000000', start: 1}]);
    Object.assign(io, {platform: 'darwin', procDir: path.join(io.home, 'no-proc')});
    io.exec = () => 'claude --resume aaaa1111-0000-0000-0000-000000000000\n';
    assert.deepEqual(openRegistry(io).liveSessions().map((r) => r.pid), [101]);
    io.exec = () => 'vim /Users/me/notes/claude\n';
    assert.deepEqual(openRegistry(io).liveSessions(), []);
});
