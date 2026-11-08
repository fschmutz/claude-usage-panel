// `./install.sh footer` against a throwaway HOME and a stub `claude` that
// keeps the marketplaces and enabledPlugins the real CLI would. What it pins
// is the order and the refusals the footer target owes an existing install:
//
//   - the Node status line is its own target: `update` reinstalls whatever is
//     there and never swaps one for the other;
//   - install before remove: the status line goes only after the plugin is
//     installed AND enabled, and only on an explicit `./install.sh footer`;
//   - a settings.json that is a symlink is never edited;
//   - a marketplace of our name pointing elsewhere is never repointed, and
//     uninstall removes only the marketplace the installer added;
//   - a failing settings edit is a failed target, never a "removed" line.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, stubbedHome} from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'install.sh');
const PLUGIN = 'usage-footer@claude-usage-panel-local';

const env = (home, extra = {}) => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    PATH: `${path.join(home, 'bin')}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    CUP_TEST_SCHEDULER: 'cron',
    // Where the installer looks for a claude CLI off PATH (scripts/lib.sh
    // scheduler_bin_dirs): all inside the sandbox, never the developer's.
    CUP_TEST_SYSTEM_BINS: '',
    VOLTA_HOME: path.join(home, 'volta'),
    NVM_DIR: path.join(home, 'nvm'),
    FNM_DIR: path.join(home, 'fnm'),
    ASDF_DATA_DIR: path.join(home, 'asdf'),
    ...extra,
});
const noNode = (home) => env(home, {PATH: `${path.join(home, 'bin')}:/usr/bin:/bin`});

const settingsOf = (home) => path.join(home, '.claude', 'settings.json');
const readSettings = (home) => JSON.parse(fs.readFileSync(settingsOf(home), 'utf8'));
const mktDir = (home) => path.join(home, 'state', 'claude-usage-panel', 'footer-marketplace');
const calls = (home) => {
    const log = path.join(home, 'claude-calls.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
};

// The real CLI's state, kept where the test can read and seed it:
// stub-marketplaces.json is `plugin marketplace list --json`; install and
// uninstall edit enabledPlugins in settings.json. A file named stub-fail-<verb>
// makes that verb exit 1; stub-install-noop makes `plugin install` succeed
// without enabling anything.
const STUB = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const a = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'claude-calls.log'), a.join(' ') + '\\n');
const mkts = path.join(home, 'stub-marketplaces.json');
const settings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const verb = a.slice(0, a[1] === 'marketplace' ? 3 : 2).join('-');
if (fs.existsSync(path.join(home, 'stub-fail-' + verb))) process.exit(1);
const list = read(mkts, []);
if (verb === 'plugin-marketplace-list') { console.log(JSON.stringify(list, null, 2)); process.exit(0); }
if (verb === 'plugin-marketplace-add') {
    const name = read(path.join(a[3], '.claude-plugin', 'marketplace.json'), {}).name;
    fs.writeFileSync(mkts, JSON.stringify([...list.filter((m) => m.name !== name), {name, source: 'directory', path: a[3]}]));
    process.exit(0);
}
if (verb === 'plugin-marketplace-remove') {
    fs.writeFileSync(mkts, JSON.stringify(list.filter((m) => m.name !== a[3])));
    process.exit(0);
}
if (verb === 'plugin-install' || verb === 'plugin-uninstall') {
    if (verb === 'plugin-install' && fs.existsSync(path.join(home, 'stub-install-noop'))) process.exit(0);
    const s = read(settings, {});
    s.enabledPlugins = {...s.enabledPlugins};
    if (verb === 'plugin-install') s.enabledPlugins[a[2]] = true; else delete s.enabledPlugins[a[2]];
    fs.mkdirSync(path.dirname(settings), {recursive: true});
    fs.writeFileSync(settings, JSON.stringify(s, null, 2) + '\\n');
}
`;

function footerHome(t, settings = {theme: 'dark'}) {
    const home = stubbedHome(t, {prefix: 'cup-footer-'});
    fs.writeFileSync(path.join(home, 'bin', 'claude'), STUB);
    fs.chmodSync(path.join(home, 'bin', 'claude'), 0o755);
    fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
    if (settings) fs.writeFileSync(settingsOf(home), `${JSON.stringify(settings, null, 2)}\n`);
    return home;
}

/** The status line as `./install.sh statusline` writes it. */
function withStatusLine(t, home) {
    const r = run('bash', [INSTALL, 'statusline'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(settingsOf(home), 'utf8'), /statusline\.js/);
}

const installed = (home) => {
    const r = run('bash', [INSTALL, '--list'], {env: noNode(home)});
    assert.equal(r.status, 0, r.stderr);
    return /installed: +([^(]*)/.exec(r.stdout)[1].trim().split(/\s+/);
};

test('the status line and the footer are two targets, each read without node or claude', (t) => {
    const home = footerHome(t);
    withStatusLine(t, home);
    assert.ok(installed(home).includes('statusline'));
    assert.ok(!installed(home).includes('footer'), 'a status line is not the footer');
});

test('update reinstalls the status line and never swaps it for the footer', (t) => {
    const home = footerHome(t);
    withStatusLine(t, home);
    fs.rmSync(path.join(home, 'claude-calls.log'), {force: true});

    const r = run('bash', [INSTALL, 'update'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(settingsOf(home), 'utf8'), /statusline\.js/, 'the status line is still there');
    assert.doesNotMatch(calls(home), /plugin (install|marketplace add)/, 'no plugin was installed overnight');
});

test('update with both installed keeps both', (t) => {
    const home = footerHome(t);
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    withStatusLine(t, home);
    assert.deepEqual(installed(home).filter((x) => x === 'statusline' || x === 'footer'), ['statusline', 'footer']);

    r = run('bash', [INSTALL, 'update'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = readSettings(home);
    assert.match(s.statusLine.command, /statusline\.js/);
    assert.equal(s.enabledPlugins[PLUGIN], true);
});

test('an explicit footer install adds our own marketplace, installs, verifies, then drops the status line', (t) => {
    const home = footerHome(t);
    withStatusLine(t, home);
    const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const order = calls(home).split('\n').filter((l) => l.startsWith('plugin'));
    assert.deepEqual(order, [
        'plugin marketplace list --json',
        `plugin marketplace add ${mktDir(home)}`,
        `plugin install ${PLUGIN} --scope user`,
    ]);
    const s = readSettings(home);
    assert.equal(s.statusLine, undefined, 'the status line went, after the install');
    assert.equal(s.theme, 'dark', 'every other setting is kept');
    assert.equal(s.enabledPlugins[PLUGIN], true);
    assert.equal(fs.realpathSync(path.join(mktDir(home), 'footer')), fs.realpathSync(path.join(ROOT, 'footer')));
    const mkt = JSON.parse(fs.readFileSync(path.join(mktDir(home), '.claude-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(mkt.name, 'claude-usage-panel-local', 'never the public marketplace name');
    assert.deepEqual(installed(home).filter((x) => x === 'statusline' || x === 'footer'), ['footer']);
});

test('the footer install puts back the foreign status line the Node one had replaced', (t) => {
    const home = footerHome(t, {statusLine: {type: 'command', command: 'my-own-line'}});
    withStatusLine(t, home);
    const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readSettings(home).statusLine, {type: 'command', command: 'my-own-line'});
    assert.equal(fs.existsSync(path.join(home, '.claude', 'claude-usage-statusline.prev.json')), false);
});

for (const [why, setup, want] of [
    ['no claude CLI', (home) => fs.rmSync(path.join(home, 'bin', 'claude')), /footer: claude CLI not found/],
    ['a failing marketplace add', (home) => fs.writeFileSync(path.join(home, 'stub-fail-plugin-marketplace-add'), ''),
        /marketplace add .* failed/],
    ['a failing plugin install', (home) => fs.writeFileSync(path.join(home, 'stub-fail-plugin-install'), ''),
        /plugin install .* failed/],
    ['an install that does not enable the plugin', (home) => fs.writeFileSync(path.join(home, 'stub-install-noop'), ''),
        /is not enabled in .* after the install/],
]) {
    test(`install before remove: ${why} leaves the status line in place and fails the target`, (t) => {
        const home = footerHome(t);
        withStatusLine(t, home);
        setup(home);
        const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, want);
        assert.match(fs.readFileSync(settingsOf(home), 'utf8'), /statusline\.js/, 'the status line is untouched');
        assert.ok(installed(home).includes('statusline'), 'and still found by the next --list / update');
        assert.ok(!installed(home).includes('footer'));
        // On `update` the same skip is a failed reinstall: nothing is stamped.
        const u = run('bash', [INSTALL, 'update', 'footer'], {env: env(home)});
        assert.equal(u.status, 1, u.stdout + u.stderr);
        assert.match(u.stderr, /could not be reinstalled:[\s\S]*footer: /);
    });
}

test('a settings.json that is a symlink is refused with the manual steps, nothing is written', (t) => {
    const home = footerHome(t, null);
    const dotfiles = path.join(home, 'dotfiles-settings.json');
    fs.writeFileSync(dotfiles, '{"theme": "dark"}\n');
    fs.symlinkSync(dotfiles, settingsOf(home));

    const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /settings\.json is a symlink/);
    assert.match(r.stdout, /claude plugin install usage-footer@claude-usage-panel --scope user/);
    assert.equal(calls(home), '', 'the claude CLI was never run');
    assert.equal(fs.readFileSync(dotfiles, 'utf8'), '{"theme": "dark"}\n');
    assert.ok(fs.lstatSync(settingsOf(home)).isSymbolicLink());
});

test('a marketplace of our name pointing elsewhere is never repointed', (t) => {
    const home = footerHome(t);
    fs.writeFileSync(path.join(home, 'stub-marketplaces.json'),
        JSON.stringify([{name: 'claude-usage-panel-local', source: 'directory', path: '/somewhere/else'}]));
    const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already points at \/somewhere\/else/);
    assert.doesNotMatch(calls(home), /marketplace add|plugin install/);
});

test('the public claude-usage-panel marketplace is left exactly as it was', (t) => {
    const home = footerHome(t);
    const pub = {name: 'claude-usage-panel', source: 'github', path: '/cache/fschmutz/claude-usage-panel'};
    fs.writeFileSync(path.join(home, 'stub-marketplaces.json'), JSON.stringify([pub]));
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'stub-marketplaces.json'), 'utf8')), [pub]);
});

test('uninstall removes the plugin and the marketplace the installer added, and only that', (t) => {
    const home = footerHome(t);
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(calls(home), new RegExp(`plugin uninstall ${PLUGIN} --scope user`));
    assert.match(calls(home), /plugin marketplace remove claude-usage-panel-local/);
    assert.equal(readSettings(home).enabledPlugins[PLUGIN], undefined);
    assert.equal(fs.existsSync(mktDir(home)), false);

    // A marketplace of that name the installer did not add stays.
    const home2 = footerHome(t, {enabledPlugins: {[PLUGIN]: true}});
    const theirs = [{name: 'claude-usage-panel-local', source: 'directory', path: mktDir(home2)}];
    fs.writeFileSync(path.join(home2, 'stub-marketplaces.json'), JSON.stringify(theirs));
    fs.mkdirSync(path.join(mktDir(home2), '.claude-plugin'), {recursive: true});
    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: env(home2)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(calls(home2), /marketplace remove/);
    assert.ok(fs.existsSync(mktDir(home2)), 'the folder a marketplace still points at is kept');
    assert.match(r.stdout, /kept .*footer-marketplace/);
});

test('a status-line removal that fails is a failed target, never a "removed" line', (t) => {
    const home = footerHome(t);
    withStatusLine(t, home);
    // json-edit writes by temp file + rename: a read-only ~/.claude makes the
    // delete fail after the plugin install already enabled the footer.
    fs.writeFileSync(path.join(home, 'bin', 'claude'), `${STUB}
if (process.argv[3] === 'install') fs.chmodSync(path.join(home, '.claude'), 0o555);
`);
    try {
        const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /removing the status line from .* failed - it stays/);
        assert.doesNotMatch(r.stdout, /status line removed/);
        assert.match(fs.readFileSync(settingsOf(home), 'utf8'), /statusline\.js/);
    } finally {
        fs.chmodSync(path.join(home, '.claude'), 0o755);
    }
});

test('the footer replacing the status line without node skips loudly and leaves it', (t) => {
    const home = footerHome(t);
    withStatusLine(t, home);
    // The stub is a node script: keep it runnable while node itself is off PATH.
    const r = run('bash', [INSTALL, 'footer'], {env: noNode(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /footer: Node\.js not found/);
    assert.match(fs.readFileSync(settingsOf(home), 'utf8'), /statusline\.js/);
});

// ── CLAUDE_CONFIG_DIR, update, detection, one footer ─────────────────────────

test('CLAUDE_CONFIG_DIR is honoured: settings, the status line and the footer live there', (t) => {
    const home = footerHome(t, null);
    const cfg = path.join(home, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(cfg, 'settings.json'), '{"theme": "dark"}\n');
    const e = env(home, {CLAUDE_CONFIG_DIR: cfg});
    const cfgSettings = () => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));

    let r = run('bash', [INSTALL, 'statusline'], {env: e});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(cfgSettings().statusLine.command, /statusline\.js/);
    assert.equal(fs.existsSync(settingsOf(home)), false, '~/.claude/settings.json is not the one Claude Code reads');

    r = run('bash', [INSTALL, 'footer'], {env: e});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /not enabled/);
    assert.equal(cfgSettings().enabledPlugins[PLUGIN], true);
    assert.equal(cfgSettings().statusLine, undefined, 'replaced in the file it was in');
    const list = run('bash', [INSTALL, '--list'], {env: env(home, {CLAUDE_CONFIG_DIR: cfg, PATH: '/usr/bin:/bin'})});
    assert.match(/installed: +([^(]*)/.exec(list.stdout)[1], /footer/);

    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: e});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(cfgSettings().enabledPlugins[PLUGIN], undefined, 'the plugin is gone, not only the marketplace');
});

test('the symlink check looks at the settings.json under CLAUDE_CONFIG_DIR', (t) => {
    const home = footerHome(t);
    const cfg = path.join(home, 'cfg');
    fs.mkdirSync(cfg);
    fs.writeFileSync(path.join(home, 'dotfiles.json'), '{}\n');
    fs.symlinkSync(path.join(home, 'dotfiles.json'), path.join(cfg, 'settings.json'));
    const r = run('bash', [INSTALL, 'footer'], {env: env(home, {CLAUDE_CONFIG_DIR: cfg})});
    assert.match(r.stdout, /cfg\/settings\.json is a symlink/);
    assert.equal(calls(home), '');
});

test('the claude CLI is found where the scheduled workers look, not only on PATH', (t) => {
    const home = footerHome(t);
    const volta = path.join(home, 'volta', 'bin');
    fs.mkdirSync(volta, {recursive: true});
    fs.renameSync(path.join(home, 'bin', 'claude'), path.join(volta, 'claude'));
    const r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /claude CLI not found/);
    assert.equal(readSettings(home).enabledPlugins[PLUGIN], true);
});

for (const [why, breakIt] of [
    ['no claude CLI anywhere', (home) => fs.rmSync(path.join(home, 'bin', 'claude'))],
    ['a settings.json that became a symlink', (home) => {
        fs.renameSync(settingsOf(home), path.join(home, 'dotfiles.json'));
        fs.symlinkSync(path.join(home, 'dotfiles.json'), settingsOf(home));
    }],
]) {
    test(`update of an installed footer only refreshes its folder: ${why} does not fail it`, (t) => {
        const home = footerHome(t);
        let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        fs.rmSync(path.join(mktDir(home), 'footer'));
        breakIt(home);
        const before = fs.readFileSync(settingsOf(home), 'utf8');
        fs.rmSync(path.join(home, 'claude-calls.log'), {force: true});

        r = run('bash', [INSTALL, 'update', 'footer'], {env: env(home)});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /up to date - loads from/);
        assert.equal(fs.realpathSync(path.join(mktDir(home), 'footer')), fs.realpathSync(path.join(ROOT, 'footer')),
            'the link is put back');
        assert.equal(calls(home), '', 'no claude CLI call');
        assert.equal(fs.readFileSync(settingsOf(home), 'utf8'), before, 'settings untouched');
    });
}

test('uninstall without node names node, not an unreadable marketplace list', (t) => {
    const home = footerHome(t);
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: noNode(home)});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /footer: Node\.js not found/);
    assert.doesNotMatch(r.stderr, /could not read the Claude Code marketplaces/);
});

test('one line under the prompt: a footer is never joined by the status line unasked', (t) => {
    const home = footerHome(t);
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const listed = run('bash', [INSTALL, '--list'], {env: env(home)});
    assert.doesNotMatch(/detected: +([^(]*)/.exec(listed.stdout)[1], /statusline/,
        'a bare ./install.sh does not add the status line back');

    for (const order of [['footer', 'statusline'], ['statusline', 'footer']]) {
        const h = footerHome(t);
        r = run('bash', [INSTALL, ...order], {env: env(h)});
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /footer and statusline both named - installing the footer/);
        assert.equal(readSettings(h).statusLine, undefined, order.join(' '));
        assert.equal(readSettings(h).enabledPlugins[PLUGIN], true, order.join(' '));
    }

    // Asked for alone, the status line still goes next to the footer.
    r = run('bash', [INSTALL, 'statusline'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readSettings(home).statusLine.command, /statusline\.js/);
});

test('a footer from the public marketplace is the footer: no second copy, and uninstall finds it', (t) => {
    const PUBLIC = 'usage-footer@claude-usage-panel';
    const home = footerHome(t, {enabledPlugins: {[PUBLIC]: true}});
    withStatusLine(t, home);
    assert.ok(installed(home).includes('footer'));

    fs.rmSync(path.join(home, 'claude-calls.log'), {force: true});
    let r = run('bash', [INSTALL, 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already installed from the claude-usage-panel marketplace/);
    assert.doesNotMatch(calls(home), /plugin (install|marketplace add)/);
    assert.equal(readSettings(home).enabledPlugins[PLUGIN], undefined, 'no second footer');
    assert.equal(readSettings(home).statusLine, undefined, 'it still replaces the status line');

    r = run('bash', [INSTALL, 'update', 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);

    r = run('bash', [INSTALL, '--uninstall', 'footer'], {env: env(home)});
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(calls(home), new RegExp(`plugin uninstall ${PUBLIC} --scope user`));
    assert.equal(readSettings(home).enabledPlugins[PUBLIC], undefined);
});

test('an inherited CLAUDE_CONFIG_DIR never reaches an installer under test, a chosen one does', () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/the/developers/real/config';
    try {
        const probe = ['-c', 'printf %s "${CLAUDE_CONFIG_DIR-unset}"'];
        assert.equal(run('bash', probe, {env: {...process.env}}).stdout, 'unset');
        assert.equal(run('bash', probe, {env: {...process.env, CLAUDE_CONFIG_DIR: '/sandbox/cfg'}}).stdout,
            '/sandbox/cfg');
    } finally {
        if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = saved;
    }
});
