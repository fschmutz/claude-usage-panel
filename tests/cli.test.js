// claudectl: the dispatcher (claudectl.js) and its install target
// (scripts/install/cli.sh, run for real against a stubbed HOME + crontab),
// including the migration of a pre-1.14 claude-account shim. The groups
// themselves are covered in accounts.test.js and tabs.test.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {main} from '../claude-code/claudectl.js';
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
    }
});

test('each group gets the rest of the argv', async (t) => {
    const io = sandboxHome(t);
    assert.match((await cli(io, 'account', 'help')).text, /^claudectl account - named/);
    assert.match((await cli(io, 'session', 'help')).text, /^claudectl session - save/);
    assert.match((await cli(io, 'account', 'list')).text, /no saved accounts/);
    assert.match((await cli(io, 'session', 'list')).text, /no running Claude Code session/);
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

test('install.sh cli: claudectl shim, autosave cron line, pre-1.14 shim migrated', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-cli-'});
    fs.mkdirSync(path.dirname(shim(home, 'x')), {recursive: true});
    fs.writeFileSync(shim(home, 'claude-account'),
        '#!/bin/sh\n# claude-usage-panel: named Claude Code accounts\nexec node "/x/claude-account.js" "$@"\n');
    fs.chmodSync(shim(home, 'claude-account'), 0o755);
    const stale = path.join(home, '.claude', 'claude-usage-panel', 'claude-code', 'claude-account.js');
    fs.mkdirSync(path.dirname(stale), {recursive: true});
    fs.writeFileSync(stale, '// pre-1.14\n');

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
    const help = run(shim(home, 'claudectl'), ['session', 'help'], {env: env(home)});
    assert.match(help.stdout, /claudectl session - save/);
    const bare = run(shim(home, 'claudectl'), ['session', 'help'], {env: {...env(home), PATH: '/nonexistent'}});
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

test('a pre-1.14 claude-account shim counts as an installed cli, so update migrates it', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-cli-'});
    fs.mkdirSync(path.dirname(shim(home, 'x')), {recursive: true});
    fs.writeFileSync(shim(home, 'claude-account'), '#!/bin/sh\n# claude-usage-panel: named Claude Code accounts\n');
    const r = run('bash', [INSTALL, '--list'], {env: env(home)});
    assert.match(r.stdout, /installed: .*\bcli\b/);
});
