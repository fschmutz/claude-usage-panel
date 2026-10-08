// install.sh waiting: the opt-in target that is the ONLY way the waiting hooks
// reach ~/.claude/settings.json (PreToolUse / PostToolUse start node on every
// tool call), run for real against a stubbed HOME. gsettings is a recording
// fake, so the live GNOME settings are never touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const UUID = 'claude-usage-panel@fschmutz.github.io';
const HOOK = /waiting-hook\.js/;

function sandbox(t) {
    const home = stubbedHome(t, {prefix: 'cup-waiting-'});
    fs.mkdirSync(path.join(home, '.local/share/gnome-shell/extensions', UUID, 'schemas'), {recursive: true});
    const gs = path.join(home, 'bin', 'gsettings');
    fs.writeFileSync(gs, '#!/bin/sh\necho "gsettings $*" >>"$HOME/calls.log"\n');
    fs.chmodSync(gs, 0o755);
    // no MCP registration here: the stub claude would answer `mcp get` with 0
    fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\nexit 1\n');
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    // a hook of the user's own, which must survive both directions
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({hooks: {Stop: [
        {hooks: [{type: 'command', command: 'say done'}]},
    ]}})}\n`);
    return home;
}

const env = (home, {node = true} = {}) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: [path.join(home, 'bin'), node && path.dirname(process.execPath), '/usr/bin', '/bin']
        .filter(Boolean).join(':'),
});
const sh = (home, args, opts) => run('bash', [INSTALL, ...args], {env: env(home, opts)});
const settings = home => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
const calls = home => {
    const f = path.join(home, 'calls.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

test('install waiting: every hook event, the section on, listed; uninstall reverses it', t => {
    const home = sandbox(t);
    const r = sh(home, ['waiting']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const hooks = JSON.parse(settings(home)).hooks;
    for (const event of ['Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'])
        assert.match(JSON.stringify(hooks[event]), HOOK, event);
    assert.match(JSON.stringify(hooks.Stop), /say done/, 'the user hook stays');
    assert.ok(fs.existsSync(path.join(home, '.claude/claude-usage-panel/claude-code/waiting-hook.js')),
        'the tree the hook runs from');
    assert.match(calls(home), /set org\.gnome\.shell\.extensions\.claude-usage-panel waiting-enabled true/);
    assert.match(sh(home, ['--list']).stdout, /\bwaiting\b/);

    const u = sh(home, ['--uninstall', 'waiting']);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.doesNotMatch(settings(home), HOOK);
    assert.match(settings(home), /say done/);
    assert.match(calls(home), /waiting-enabled false/);
    assert.equal(fs.existsSync(path.join(home, '.claude/claude-usage-panel')), false, 'nothing else used the tree');
});

test('a reinstall (update) keeps the user turning the section off', t => {
    const home = sandbox(t);
    assert.equal(sh(home, ['waiting']).status, 0);
    fs.writeFileSync(path.join(home, 'calls.log'), '');
    const r = sh(home, ['update', 'waiting']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(settings(home), HOOK);
    assert.doesNotMatch(calls(home), /waiting-enabled/);
});

test('without node the target is skipped loudly, writes nothing, and fails an update', t => {
    const home = sandbox(t);
    const before = settings(home);
    const r = sh(home, ['waiting'], {node: false});
    assert.match(r.stdout + r.stderr, /waiting: Node\.js not found on PATH/);
    assert.equal(settings(home), before);
    assert.doesNotMatch(calls(home), /waiting-enabled/);
    // installed earlier, node gone now: `update` owes the reinstall, so it fails
    assert.equal(sh(home, ['waiting']).status, 0);
    const u = sh(home, ['update', 'waiting'], {node: false});
    assert.equal(u.status, 1);
    assert.match(u.stderr, /could not be reinstalled[\s\S]*waiting:/);
});

test('no other target installs the hooks', t => {
    const home = sandbox(t);
    const r = sh(home, ['--dry-run', 'gnome', 'statusline', 'mcp', 'cli']);
    assert.doesNotMatch(r.stdout, /waiting hooks/);
});
