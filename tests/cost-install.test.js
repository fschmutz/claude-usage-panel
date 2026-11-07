// install.sh cost: the locked ccusage and the cost toggle, run for real
// against a stubbed HOME. node, npm, volta and gsettings are recording fakes,
// so nothing touches the real global packages or the live GNOME settings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const UUID = 'claude-usage-panel@fschmutz.github.io';
const PIN_DIR = path.join(ROOT, '.github/ccusage');
const PINNED = JSON.parse(fs.readFileSync(path.join(PIN_DIR, 'package.json'), 'utf8')).dependencies.ccusage;

function stub(home, name, body) {
    const f = path.join(home, 'bin', name);
    fs.writeFileSync(f, `#!/bin/sh\necho "${name} $*" >>"$HOME/calls.log"\n${body}`);
    fs.chmodSync(f, 0o755);
}

// A HOME with the GNOME extension's schemas dir (so the toggle applies; an
// older schema without the key when `schemaKey` is false), gsettings
// recording, a `node` that records what it runs, and an `npm` whose
// `ci --prefix DIR` lays down DIR/node_modules/.bin/ccusage (exit `ciExit`).
function sandbox(t, {ciExit = 0, volta = false, schemaKey = true} = {}) {
    const home = stubbedHome(t, {prefix: 'cup-cost-'});
    const schemas = path.join(home, '.local/share/gnome-shell/extensions', UUID, 'schemas');
    fs.mkdirSync(schemas, {recursive: true});
    fs.writeFileSync(path.join(schemas, 'x.gschema.xml'),
        schemaKey ? '<key name="show-cost" type="b"/>\n' : '<key name="show-costs-old" type="b"/>\n');
    stub(home, 'gsettings', '');
    stub(home, 'node', 'printf "%s\\n" "$@" >"$HOME/node-argv"\n');
    stub(home, 'npm', `[ "$1" = ci ] || exit 0
[ "$2" = --prefix ] || exit 9
mkdir -p "$3/node_modules/.bin" && printf '#!/bin/sh\\n' >"$3/node_modules/.bin/ccusage"
exit ${ciExit}
`);
    if (volta) {
        stub(home, 'volta', '[ "$1" = uninstall ] && rm -f "$HOME/.volta/bin/ccusage"\nexit 0\n');
        fs.mkdirSync(path.join(home, '.volta/bin'), {recursive: true});
        fs.writeFileSync(path.join(home, '.volta/bin/ccusage'), '#!/bin/sh\n', {mode: 0o755});
    }
    return home;
}

// No node dir on PATH: a version-manager node dir would bring the real npm.
const env = (home) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`,
});

const calls = (home) => {
    const f = path.join(home, 'calls.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};
const marker = (home) => path.join(home, 'state', 'claude-usage-panel', 'cost-installed');
const prefix = (home) => path.join(home, 'data', 'claude-usage-panel', 'ccusage');
const launcher = (home) => path.join(home, '.local/bin/ccusage');
const sh = (home, ...args) => run('bash', [INSTALL, ...args], {env: env(home)});

test('the ccusage pin is a lockfile: every package in the tree carries its integrity hash', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(PIN_DIR, 'package-lock.json'), 'utf8'));
    assert.deepEqual(lock.packages[''].dependencies, {ccusage: PINNED}, 'the lock is of the pinned version');
    assert.equal(lock.packages['node_modules/ccusage'].version, PINNED);
    for (const [name, p] of Object.entries(lock.packages)) {
        if (!name) continue;
        assert.match(p.integrity ?? '', /^sha512-/, `${name} has no integrity hash`);
        assert.match(p.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, `${name} resolves off the registry`);
    }
});

test('install cost: npm ci of the locked tree, a launcher on the panels\' PATH, the cost line on', (t) => {
    const home = sandbox(t);
    const r = sh(home, 'cost');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const npm = calls(home).split('\n').find((l) => l.startsWith('npm ci'));
    assert.equal(npm, `npm ci --prefix ${prefix(home)} --omit=dev --ignore-scripts --no-audit --no-fund --silent`);
    assert.doesNotMatch(calls(home), /npm install|volta install/, 'never an unlocked install');
    assert.equal(fs.readFileSync(path.join(prefix(home), 'package-lock.json'), 'utf8'),
        fs.readFileSync(path.join(PIN_DIR, 'package-lock.json'), 'utf8'));
    // The launcher runs the locked ccusage with the node that installed it.
    execFileSync(launcher(home), ['blocks', '--json'], {env: {PATH: '/nonexistent', HOME: home}});
    assert.deepEqual(fs.readFileSync(path.join(home, 'node-argv'), 'utf8').trim().split('\n'),
        [path.join(prefix(home), 'node_modules/.bin/ccusage'), 'blocks', '--json']);
    assert.match(calls(home), /gsettings --schemadir \S+ set org\.gnome\.shell\.extensions\.claude-usage-panel show-cost true/);
    assert.ok(fs.existsSync(marker(home)));
    assert.match(sh(home, '--list').stdout, /installed:.*\bcost\b/);
});

test('install cost replaces a global ccusage an older install left (it would shadow the lock)', (t) => {
    const home = sandbox(t, {volta: true});
    const r = sh(home, 'cost');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(calls(home), /^volta uninstall ccusage$/m);
    assert.equal(fs.existsSync(path.join(home, '.volta/bin/ccusage')), false);
});

test('update cost reinstalls the lock and leaves the user\'s cost toggle alone', (t) => {
    const home = sandbox(t);
    assert.equal(sh(home, 'cost').status, 0);
    fs.rmSync(path.join(home, 'calls.log'));
    const r = sh(home, 'update', 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(home), /^npm ci --prefix /m);
    assert.doesNotMatch(calls(home), /gsettings/);
});

test('uninstall cost turns the line off, removes the launcher, the tree and the marker', (t) => {
    const home = sandbox(t);
    assert.equal(sh(home, 'cost').status, 0);
    const r = sh(home, '--uninstall', 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls(home), /show-cost false/);
    assert.equal(fs.existsSync(marker(home)), false);
    assert.equal(fs.existsSync(launcher(home)), false);
    assert.equal(fs.existsSync(prefix(home)), false);
});

test('uninstall cost leaves a ccusage it did not write', (t) => {
    const home = sandbox(t);
    fs.mkdirSync(path.dirname(launcher(home)), {recursive: true});
    fs.writeFileSync(launcher(home), '#!/bin/sh\necho mine\n', {mode: 0o755});
    assert.equal(sh(home, '--uninstall', 'cost').status, 0);
    assert.equal(fs.readFileSync(launcher(home), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('a failed npm ci is skipped loudly, records nothing, and fails an update', (t) => {
    const home = sandbox(t, {ciExit: 1});
    const r = sh(home, 'cost');
    assert.match(r.stdout + r.stderr, /npm ci of the locked ccusage .* failed/);
    assert.equal(fs.existsSync(marker(home)), false);
    assert.doesNotMatch(calls(home), /show-cost/);
    // installed earlier, not reinstallable now: `update` owes it, so it fails
    fs.mkdirSync(path.dirname(marker(home)), {recursive: true});
    fs.writeFileSync(marker(home), '');
    const u = sh(home, 'update', 'cost');
    assert.equal(u.status, 1);
    assert.match(u.stderr, /could not be reinstalled[\s\S]*cost:/);
});

test('install cost leaves an extension whose schema predates the key alone', (t) => {
    // gsettings refuses a key the installed schema does not have, which
    // failed the whole target on a machine one extension update behind.
    const home = sandbox(t, {schemaKey: false});
    const r = sh(home, 'cost');
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(calls(home), /gsettings/);
    assert.ok(fs.existsSync(marker(home)));
});
