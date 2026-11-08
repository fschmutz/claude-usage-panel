// install.sh pause: the opt-in target that is the ONLY way the pause hooks
// reach ~/.claude/settings.json, run for real against a stubbed HOME (stub
// schedulers, a recording gsettings: the live GNOME settings and the real
// settings.json are never touched). Plus hooks-edit.mjs's pause set.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const EDIT = path.join(ROOT, 'scripts', 'install', 'hooks-edit.mjs');
const UUID = 'claude-usage-panel@fschmutz.github.io';

function sandbox(t, {cli = true, schemaKey = true} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-pause-inst-'});
    const schemas = path.join(home, '.local/share/gnome-shell/extensions', UUID, 'schemas');
    fs.mkdirSync(schemas, {recursive: true});
    fs.writeFileSync(path.join(schemas, 'x.gschema.xml'), schemaKey ? '<key name="pause-enabled" type="b"/>\n' : '<key name="other"/>\n');
    const gs = path.join(home, 'bin', 'gsettings');
    fs.writeFileSync(gs, '#!/bin/sh\necho "gsettings $*" >>"$HOME/calls.log"\n');
    fs.chmodSync(gs, 0o755);
    fs.writeFileSync(path.join(home, 'bin', 'claude'), '#!/bin/sh\nexit 1\n');
    if (cli) {
        fs.mkdirSync(path.join(home, '.local', 'bin'), {recursive: true});
        fs.writeFileSync(path.join(home, '.local', 'bin', 'claudectl'), '#!/bin/sh\n');
        fs.chmodSync(path.join(home, '.local', 'bin', 'claudectl'), 0o755);
    }
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    // a hook of the user's own on two of our events, which must survive both directions
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({hooks: {
        Stop: [{hooks: [{type: 'command', command: 'say done'}]}],
        PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'audit.sh'}]}],
    }})}\n`);
    return home;
}

const env = (home, {node = true} = {}) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CUP_TEST_SCHEDULER: 'cron',
    PATH: [path.join(home, 'bin'), node && path.dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean).join(':'),
});
const sh = (home, args, opts) => run('bash', [INSTALL, ...args], {env: env(home, opts)});
const settings = (home) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const calls = (home) => {
    const f = path.join(home, 'calls.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const ours = (groups = []) => groups.flatMap((g) => (g.hooks ?? []).map((h) => ({...h, matcher: g.matcher})))
    .filter((h) => /pause-hook\.js/.test(h.command));

test('install pause: the probed hook JSON, user hooks kept, listed; uninstall removes exactly ours', (t) => {
    const home = sandbox(t);
    const r = sh(home, ['pause']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const dest = path.join(home, '.claude/claude-usage-panel/claude-code/pause-hook.js');
    assert.ok(fs.existsSync(dest), 'the hook runs from the installed tree');
    const {hooks} = settings(home);
    for (const event of ['SessionStart', 'Stop']) {
        assert.deepEqual(ours(hooks[event]), [{type: 'command', command: `node "${dest}" wait`, asyncRewake: true, timeout: 86400, matcher: undefined}], event);
    }
    assert.deepEqual(ours(hooks.PreToolUse), [{type: 'command', command: `node "${dest}" pretool`, timeout: 10, matcher: '*'}]);
    assert.equal(hooks.Stop[0].hooks[0].command, 'say done');
    assert.equal(hooks.PreToolUse[0].matcher, 'Bash', 'never injected into the user group');
    assert.match(calls(home), /set org\.gnome\.shell\.extensions\.claude-usage-panel pause-enabled true/);
    assert.match(sh(home, ['--list']).stdout, /installed: .*\bpause\b/);

    // update: a reinstall replaces ours in place, no duplicate, keeps the user's choice
    fs.writeFileSync(path.join(home, 'calls.log'), '');
    assert.equal(sh(home, ['update', 'pause']).status, 0);
    assert.equal(ours(settings(home).hooks.Stop).length, 1);
    assert.doesNotMatch(calls(home), /pause-enabled/);

    const u = sh(home, ['--uninstall', 'pause']);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    const after = settings(home).hooks;
    assert.deepEqual(after, {
        Stop: [{hooks: [{type: 'command', command: 'say done'}]}],
        PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'audit.sh'}]}],
    });
    assert.match(calls(home), /pause-enabled false/);
    assert.doesNotMatch(sh(home, ['--list']).stdout, /installed: .*\bpause\b/);
});

test('pause installs the CLI when it is missing (it depends on claudectl)', (t) => {
    const home = sandbox(t, {cli: false});
    const r = sh(home, ['pause']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(home, '.local', 'bin', 'claudectl')));
    assert.match(r.stdout, /claudectl CLI/);
});

test('pause and waiting coexist: removing one keeps the other', (t) => {
    const home = sandbox(t);
    assert.equal(sh(home, ['waiting', 'pause']).status, 0);
    assert.equal(sh(home, ['--uninstall', 'pause']).status, 0);
    const text = JSON.stringify(settings(home));
    assert.match(text, /waiting-hook\.js/);
    assert.doesNotMatch(text, /pause-hook\.js/);
    assert.ok(fs.existsSync(path.join(home, '.claude/claude-usage-panel')), 'the waiting hook still runs from the tree');
});

test('--dry-run writes nothing; a panel without the key is not toggled', (t) => {
    const home = sandbox(t, {schemaKey: false});
    const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    const r = sh(home, ['--dry-run', 'pause']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /would: merge pause hooks/);
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before);
    assert.equal(sh(home, ['pause']).status, 0);
    assert.doesNotMatch(calls(home), /pause-enabled/);
});

test('without node the target is skipped loudly and an update of it fails', (t) => {
    const home = sandbox(t);
    const r = sh(home, ['pause'], {node: false});
    assert.match(r.stdout + r.stderr, /pause: Node\.js not found on PATH/);
    assert.equal(sh(home, ['pause']).status, 0);
    const u = sh(home, ['update', 'pause'], {node: false});
    assert.equal(u.status, 1);
    assert.match(u.stderr, /could not be reinstalled[\s\S]*pause:/);
});

test('no other target installs the pause hooks', (t) => {
    const home = sandbox(t);
    assert.doesNotMatch(sh(home, ['--dry-run', 'gnome', 'statusline', 'mcp', 'cli', 'waiting']).stdout, /pause hooks/);
});

test('hooks-edit pause: replaces an outdated entry of ours in place and drops it from events no longer used', (t) => {
    const home = stubbedHome(t, {prefix: 'cup-pause-edit-'});
    const file = path.join(home, 'settings.json');
    const cmd = 'node "/t/pause-hook.js"';
    fs.writeFileSync(file, JSON.stringify({hooks: {
        Stop: [{hooks: [{type: 'command', command: `${cmd} wait`, timeout: 600}, {type: 'command', command: 'mine'}]}],
        Notification: [{hooks: [{type: 'command', command: `${cmd} wait`}]}],
    }}));
    const add = spawnSync(process.execPath, [EDIT, 'add', file, cmd, 'pause'], {encoding: 'utf8'});
    assert.equal(add.status, 0, add.stderr);
    const {hooks} = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(hooks.Stop, [{hooks: [
        {type: 'command', command: `${cmd} wait`, asyncRewake: true, timeout: 86400}, {type: 'command', command: 'mine'},
    ]}]);
    assert.equal(hooks.Notification, undefined);
    const bad = spawnSync(process.execPath, [EDIT, 'add', file, cmd, 'other'], {encoding: 'utf8'});
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /usage/);
});
