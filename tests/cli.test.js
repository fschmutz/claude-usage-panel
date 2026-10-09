// claudectl: the dispatcher (claudectl.js) and its install target
// (scripts/install/cli.sh, run for real against a stubbed HOME + crontab),
// including the migration of a pre-2.0 claude-account shim. The groups
// themselves are covered in accounts-*.test.js and tabs.test.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {main} from '../claude-code/claudectl.js';
import {commandSynopsis, helpRequest} from '../claude-code/cli-help.js';
import * as accountCli from '../claude-code/account-cli.js';
import * as codexCli from '../claude-code/codex-cli.js';
import * as sessionCli from '../claude-code/session-cli.js';
import * as waitingCli from '../claude-code/waiting-cli.js';
import {run, sandboxHome, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');

async function cli(io, ...argv) {
    let text = '';
    const code = await main(argv, {...io, stdout: (s) => { text += s; }});
    return {code, text};
}

// ── Dispatch ────────────────────────────────────────────────────────────────────

test('no group, help or -h prints both groups', async (t) => {
    const io = sandboxHome(t);
    for (const argv of [[], ['help'], ['-h'], ['--help']]) {
        const r = await cli(io, ...argv);
        assert.equal(r.code, 0);
        assert.match(r.text, /claudectl account \.\.\./);
        assert.match(r.text, /claudectl session \.\.\./);
        assert.match(r.text, /claudectl waiting \.\.\./);
    }
});

test('each group gets the rest of the argv', async (t) => {
    const io = sandboxHome(t);
    assert.match((await cli(io, 'account', 'help')).text, /^claudectl account - named/);
    assert.match((await cli(io, 'session', 'help')).text, /^claudectl session - save/);
    assert.match((await cli(io, 'waiting', 'help')).text, /^claudectl waiting - live/);
    assert.match((await cli(io, 'account', 'list')).text, /no saved accounts/);
    assert.match((await cli(io, 'session', 'list')).text, /no running Claude Code session/);
});

test('helpRequest: --help / -h anywhere, `help` only as the first or second word', () => {
    assert.deepEqual(helpRequest(['session', 'open', '--help']), {group: 'session', cmd: 'open'});
    assert.deepEqual(helpRequest(['account', 'use', 'PRO', '-h']), {group: 'account', cmd: 'use'});
    assert.deepEqual(helpRequest(['help', 'session', 'focus']), {group: 'session', cmd: 'focus'});
    assert.deepEqual(helpRequest(['session', 'help', 'open']), {group: 'session', cmd: 'open'});
    assert.deepEqual(helpRequest(['--help']), {group: undefined, cmd: undefined});
    assert.equal(helpRequest(['session', 'report', '--request', 'x', '--reason', 'help']), null);
    assert.equal(helpRequest(['session', 'open']), null);
});

const GROUPS = {account: accountCli, codex: codexCli, session: sessionCli, waiting: waitingCli};

test('every command a group lists has its own --help page with a details paragraph', async (t) => {
    const io = sandboxHome(t);
    for (const [group, cli_] of Object.entries(GROUPS)) {
        const cmds = [...cli_.HELP.matchAll(new RegExp(`^\\s*claudectl ${group} \\[?([a-z][a-z-]*)`, 'gm'))].map((m) => m[1]);
        assert.ok(cmds.length > 1, group);
        assert.deepEqual(Object.keys(cli_.DETAILS).sort(), [...new Set(cmds)].sort(),
            `${group}: DETAILS must cover exactly the commands its HELP lists`);
        for (const cmd of cmds) {
            assert.ok(commandSynopsis(cli_.HELP, group, cmd), `${group} ${cmd}`);
            const r = await cli(io, group, cmd, '--help');
            assert.equal(r.code, 0, `${group} ${cmd} --help`);
            assert.ok(r.text.includes(cli_.DETAILS[cmd].trim().split('\n')[0]), `${group} ${cmd} prints its details`);
            assert.match(r.text, new RegExp(`All ${group} commands: claudectl ${group} --help`));
        }
    }
});

test('--help never runs the command, at any depth, and aliases resolve', async (t) => {
    const io = sandboxHome(t);
    io.spawn = () => assert.fail('--help must not launch anything');
    io.exec = () => assert.fail('--help must not run anything');
    for (const argv of [['session', 'open', '--help'], ['session', 'purge', '--all', '-h'],
        ['account', 'use', 'PRO', '--help'], ['session', 'pause', '--all', '--help'], ['help', 'codex', 'use']]) {
        const r = await cli(io, ...argv);
        assert.equal(r.code, 0, argv.join(' '));
        assert.match(r.text, /^ {2}claudectl /, argv.join(' '));
    }
    assert.match((await cli(io, 'session', 'ls', '--help')).text, /claudectl session list/);
    assert.match((await cli(io, 'session', 'restore', '--help')).text, /claudectl session open/);
    assert.match((await cli(io, 'session', '--help')).text, /^claudectl session - save/);
    await assert.rejects(cli(io, 'session', 'nope', '--help'), /unknown command session nope/);
});

test('an unknown group or an old flat command is refused with the help', async (t) => {
    const io = sandboxHome(t);
    await assert.rejects(cli(io, 'use', 'PRO'), /unknown command use[\s\S]*claudectl account/);
    await assert.rejects(cli(io, 'tabs'), /unknown command tabs/);
});

// ── install.sh cli ──────────────────────────────────────────────────────────────

// install.sh needs node on PATH; the stubs dir comes first so crontab,
// systemctl and launchctl are always the recording fakes.
const env = (home) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
});

const shim = (home, name) => path.join(home, '.local', 'bin', name);

test('install.sh cli: claudectl shim, autosave cron line, pre-2.0 shim migrated', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-cli-'});
    fs.mkdirSync(path.dirname(shim(home, 'x')), {recursive: true});
    fs.writeFileSync(shim(home, 'claude-account'),
        '#!/bin/sh\n# claude-usage-panel: named Claude Code accounts\nexec node "/x/claude-account.js" "$@"\n');
    fs.chmodSync(shim(home, 'claude-account'), 0o755);
    const stale = path.join(home, '.claude', 'claude-usage-panel', 'claude-code', 'claude-account.js');
    fs.mkdirSync(path.dirname(stale), {recursive: true});
    fs.writeFileSync(stale, '// pre-2.0\n');

    // the old target names are aliases, and naming both installs once
    const r = run('bash', [INSTALL, 'accounts', 'tabs'], {env: env(home)});
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stdout.match(/claudectl CLI \(account/g) ?? []).length, 1);
    assert.match(r.stdout, /==> install: cli/);

    const tree = path.join(home, '.claude', 'claude-usage-panel', 'claude-code');
    assert.ok(fs.existsSync(path.join(tree, 'claudectl.js')));
    assert.ok(!fs.existsSync(path.join(tree, 'claude-account.js')), 'a module the checkout dropped is pruned');

    const body = fs.readFileSync(shim(home, 'claudectl'), 'utf8');
    assert.match(body, /claude-usage-panel\/claude-code\/claudectl\.js/);
    assert.ok(!fs.existsSync(shim(home, 'claude-account')), 'our old shim is removed');
    const cron = fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8');
    assert.match(cron, /^\*\/30 \* \* \* \* ".+node" ".+claudectl\.js" session autosave .*# claude-usage-panel session autosave$/m);

    // the installed tree runs through the shim, and still does with no node
    // on PATH (a GUI app's launchd PATH): it falls back to the install-time node
    // Through bash, not as the program: tests/helpers.js only ever spawns a
    // fixed tool, so a sandbox path is always an argument.
    const help = run('bash', [shim(home, 'claudectl'), 'session', 'help'], {env: env(home)});
    assert.match(help.stdout, /claudectl session - save/);
    // PATH is emptied INSIDE the shell, not in the spawn env, which still has
    // to resolve bash itself.
    const bare = run('bash', ['-c', 'PATH=/nonexistent exec "$0" session help',
        shim(home, 'claudectl')], {env: env(home)});
    assert.match(bare.stdout, /claudectl session - save/, bare.stderr);

    const u = run('bash', [INSTALL, '--uninstall', 'cli'], {env: env(home)});
    assert.equal(u.status, 0, u.stderr);
    assert.ok(!fs.existsSync(shim(home, 'claudectl')));
    assert.doesNotMatch(fs.readFileSync(path.join(home, 'crontab.txt'), 'utf8'), /session autosave/);
});

test('install.sh cli never removes a claude-account it did not write', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-cli-'});
    fs.mkdirSync(path.dirname(shim(home, 'x')), {recursive: true});
    fs.writeFileSync(shim(home, 'claude-account'), '#!/bin/sh\necho someone else\n');
    const r = run('bash', [INSTALL, 'cli'], {env: env(home)});
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(shim(home, 'claude-account')));
});

test('a pre-2.0 claude-account shim counts as an installed cli, so update migrates it', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-cli-'});
    fs.mkdirSync(path.dirname(shim(home, 'x')), {recursive: true});
    fs.writeFileSync(shim(home, 'claude-account'), '#!/bin/sh\n# claude-usage-panel: named Claude Code accounts\n');
    const r = run('bash', [INSTALL, '--list'], {env: env(home)});
    assert.match(r.stdout, /installed: .*\bcli\b/);
});
