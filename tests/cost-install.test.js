// install.sh cost: the pinned ccusage and the cost toggle, run for real
// against a stubbed HOME. volta, npm and gsettings are recording fakes, so
// nothing touches the real global packages or the live GNOME settings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const UUID = 'claude-usage-panel@fschmutz.github.io';
const PINNED = JSON.parse(fs.readFileSync(path.join(ROOT, '.github/ccusage/package.json'), 'utf8'))
    .dependencies.ccusage;

function stub(home, name, body) {
    const f = path.join(home, 'bin', name);
    fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >>"$HOME/calls.log"\n${body}`);
    fs.chmodSync(f, 0o755);
}

// A HOME with the GNOME extension's schemas dir (so the toggle applies),
// gsettings recording, and `volta` (or only `npm`) installing into `binDir`.
function sandbox(t, {manager = 'volta', binDir = '.volta/bin'} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-cost-'});
    fs.mkdirSync(path.join(home, '.local/share/gnome-shell/extensions', UUID, 'schemas'), {recursive: true});
    stub(home, 'gsettings', '');
    const install = `mkdir -p "$HOME/${binDir}" && printf '#!/bin/sh\\n' >"$HOME/${binDir}/ccusage" && chmod +x "$HOME/${binDir}/ccusage"`;
    if (manager === 'volta')
        stub(home, 'volta', `[ "$1" = install ] && ${install}\n[ "$1" = uninstall ] && rm -f "$HOME/${binDir}/ccusage"\nexit 0\n`);
    else
        stub(home, 'npm', `[ "$1" = install ] && ${install}\nexit 0\n`);
    return home;
}

// No node dir on PATH: a version-manager node dir would bring the real npm.
const env = (home) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`,
});

const calls = (home) => {
    const f = path.join(home, 'calls.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const marker = (home) => path.join(home, 'state', 'claude-usage-panel', 'cost-installed');
const sh = (home, ...args) => run('bash', [INSTALL, ...args], {env: env(home)});

test('install cost: the pinned ccusage, the cost line on, listed as installed', (t) => {
    const home = sandbox(t);
    const r = sh(home, 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(home), new RegExp(`^volta install ccusage@${PINNED.replaceAll('.', '\\.')}$`, 'm'));
    assert.match(calls(home), /gsettings --schemadir \S+ set org\.gnome\.shell\.extensions\.claude-usage-panel show-cost true/);
    assert.ok(fs.existsSync(marker(home)));
    assert.match(sh(home, '--list').stdout, /installed:.*\bcost\b/);
});

test('update cost reinstalls the pin and leaves the user\'s cost toggle alone', (t) => {
    const home = sandbox(t);
    assert.equal(sh(home, 'cost').status, 0);
    fs.rmSync(path.join(home, 'calls.log'));
    const r = sh(home, 'update', 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(home), /^volta install ccusage@/m);
    assert.doesNotMatch(calls(home), /gsettings/);
});

test('uninstall cost turns the line off, removes ccusage and the marker', (t) => {
    const home = sandbox(t);
    assert.equal(sh(home, 'cost').status, 0);
    const r = sh(home, '--uninstall', 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(home), /show-cost false/);
    assert.match(calls(home), /^volta uninstall ccusage$/m);
    assert.equal(fs.existsSync(marker(home)), false);
    assert.equal(fs.existsSync(path.join(home, '.volta/bin/ccusage')), false);
});

test('a ccusage the panels cannot reach is skipped loudly, records nothing, and fails an update', (t) => {
    // npm only, installing into an nvm-style dir that is on no panel's PATH
    const home = sandbox(t, {manager: 'npm', binDir: '.nvm/bin'});
    const r = sh(home, 'cost');
    assert.match(r.stdout + r.stderr, /not where the panels look/);
    assert.equal(fs.existsSync(marker(home)), false);
    assert.doesNotMatch(calls(home), /show-cost/);
    // installed by hand earlier, unreachable now: `update` owes it, so it fails
    fs.mkdirSync(path.dirname(marker(home)), {recursive: true});
    fs.writeFileSync(marker(home), '');
    const u = sh(home, 'update', 'cost');
    assert.equal(u.status, 1);
    assert.match(u.stderr, /could not be reinstalled[\s\S]*cost:/);
});
