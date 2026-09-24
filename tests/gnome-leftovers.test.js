// GNOME extension details that have no other home: user-visible strings that
// must go through gettext, preference texts that must match what the code
// does, the schema's description of what it stores, and the shell versions
// the extension claims.
//
// Offline and GJS-free: lib/sessionPing.js is loaded against stand-ins for
// gi://GLib, gi://Gio, gettext and ./proc.js, so its error lines are checked
// as the preferences window would receive them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'claude-usage-panel@fschmutz.github.io');
const read = rel => fs.readFileSync(path.join(EXT, rel), 'utf8');

// ── Stand-ins for the GJS modules lib/sessionPing.js imports ─────────────────
// Every gettext lookup comes back wrapped in «», so a string that skipped
// translation is told apart from one that went through it.
const world = {
    systemd: true,
    bundledRunner: true,
    writeFails: false,
    systemctl: {ok: true, stderr: ''},
};
globalThis.gnomeLeftovers = {
    world,
    gettext: s => `«${s}»`,
    GLib: {
        FileTest: {EXISTS: 1, IS_EXECUTABLE: 2, IS_DIR: 4},
        build_filenamev: parts => parts.join('/'),
        get_user_config_dir: () => '/cfg',
        get_home_dir: () => '/home/u',
        getenv: () => null,
        find_program_in_path: name => (world.systemd && name === 'systemctl' ? '/usr/bin/systemctl' : null),
        file_test: (p, _flag) => (p === '/run/systemd/system'
            ? world.systemd
            : p.endsWith('/scripts/session-ping.sh') && world.bundledRunner),
        file_get_contents: () => {
            throw new Error('no such file');
        },
        mkdir_with_parents: () => {
            if (world.writeFails)
                throw new Error('disk full');
        },
        path_get_dirname: p => p.slice(0, p.lastIndexOf('/')),
        get_real_time: () => 1,
        file_set_contents: () => true,
        unlink: () => 0,
    },
    Gio: {
        FileQueryInfoFlags: {NONE: 0},
        FileCopyFlags: {OVERWRITE: 1},
        File: {new_for_path: () => ({set_attribute_uint32: () => true, move: () => true})},
    },
};

const STUBS = {
    'gi://GLib': 'export default globalThis.gnomeLeftovers.GLib;',
    'gi://Gio': 'export default globalThis.gnomeLeftovers.Gio;',
    gettext: `export default {domain: () => ({
        gettext: s => globalThis.gnomeLeftovers.gettext(s),
    })};`,
    './proc.js': 'export const run = async () => globalThis.gnomeLeftovers.world.systemctl;',
};
registerHooks({
    resolve(specifier, context, next) {
        const local = specifier === './proc.js' && context.parentURL?.endsWith('/lib/sessionPing.js');
        if (local || (specifier !== './proc.js' && STUBS[specifier]))
            return {url: `gnome-leftovers-stub:${encodeURIComponent(specifier)}`, shortCircuit: true};
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith('gnome-leftovers-stub:')) {
            const source = STUBS[decodeURIComponent(url.slice('gnome-leftovers-stub:'.length))];
            return {format: 'module', source, shortCircuit: true};
        }
        return next(url, context);
    },
});

const {applySchedule} = await import(path.join(EXT, 'lib', 'sessionPing.js'));

function reset() {
    Object.assign(world, {
        systemd: true, bundledRunner: true, writeFails: false,
        systemctl: {ok: true, stderr: ''},
    });
}

const ask = (over = {}) => applySchedule({
    enabled: true, times: ['05:30'], days: [1], extensionPath: '/ext', ...over,
});

// ── lib/sessionPing.js: every error line the preferences show is translated ──
test('session-ping schedule errors reach the preferences translated', async () => {
    reset();
    world.systemd = false;
    assert.equal(await ask(),
        '«No systemd user session here - schedule pings with ./install.sh sessionping instead.»');

    reset();
    assert.equal(await ask({times: []}), '«Add at least one ping time (HH:MM).»');

    reset();
    world.bundledRunner = false;
    assert.equal(await ask(), '«session-ping.sh not found - reinstall with ./install.sh gnome.»');

    reset();
    world.writeFails = true;
    assert.equal(await ask(), '«Could not write the systemd units: disk full»');

    reset();
    world.systemctl = {ok: false, stderr: '  '};
    assert.equal(await ask(), '«systemctl failed»');

    // systemctl's own words are passed through untouched, and success is null.
    reset();
    world.systemctl = {ok: false, stderr: 'Unit not found.\n'};
    assert.equal(await ask(), 'Unit not found.');
    reset();
    assert.equal(await ask(), null);
});

test('an error message with $ patterns is inserted verbatim', async () => {
    reset();
    world.writeFails = true;
    const orig = globalThis.gnomeLeftovers.GLib.mkdir_with_parents;
    globalThis.gnomeLeftovers.GLib.mkdir_with_parents = () => {
        throw new Error("can't write $& or $1");
    };
    try {
        assert.equal(await ask(), "«Could not write the systemd units: can't write $& or $1»");
    } finally {
        globalThis.gnomeLeftovers.GLib.mkdir_with_parents = orig;
    }
});

// ── Other strings the dropdown shows ─────────────────────────────────────────
// Every string passed to _() / ngettext() in a GNOME source is extracted by
// scripts/update-po.sh; a bare literal never reaches a translator.
test('the header title goes through gettext', () => {
    const src = read('lib/headerBar.js');
    assert.match(src, /text: _\('Claude usage'\)/);
    assert.doesNotMatch(src, /text: '[A-Za-z]/, 'a bare literal label in the header');
});

test('the running-session count after a switch uses plural forms', () => {
    const src = read('lib/accountsSection.js');
    assert.match(src, /import \{gettext as _, ngettext\} from/);
    assert.match(src, /ngettext\(\s*' - %d running session keeps the old login until restarted',\s*' - %d running sessions keep the old login until restarted',\s*r\.running\)/);
    assert.doesNotMatch(src, /session\(s\)/, 'a "(s)" plural instead of ngettext');
});

// ── Preferences texts describe what the code does ────────────────────────────
test('the cost row names the installed ccusage, not Node/npx', () => {
    const prefs = read('prefs.js');
    assert.match(prefs, /requires ccusage installed: npm i -g ccusage/);
    assert.doesNotMatch(prefs, /Node\/npx/);
    // lib/cost.js runs only an installed ccusage - the text is true of it.
    const cost = read('lib/cost.js');
    assert.match(cost, /CCUSAGE_ARGV = \['ccusage',/);
    assert.doesNotMatch(cost, /['"]npx['"]/);
});

test('the sessions group points at the Claude config dir, not a fixed ~/.claude', () => {
    const prefs = read('prefs.js');
    assert.match(prefs, /local transcripts in \$CLAUDE_CONFIG_DIR\/projects \(~\/\.claude\/projects by default\)/);
    assert.doesNotMatch(prefs, /transcripts in ~\/\.claude\/projects\./);
});

test('the history key describes the [epochMs, percent] samples it stores', () => {
    const xml = read('schemas/org.gnome.shell.extensions.claude-usage-panel.gschema.xml');
    const key = /<key name="history"[\s\S]*?<\/key>/.exec(xml)[0];
    assert.match(key, /\[epochMs, percent\] samples/);
    assert.doesNotMatch(key, /recent percentages/);
});

// ── Shell versions ───────────────────────────────────────────────────────────
test('metadata claims GNOME Shell 51 and the header comment states the same range', () => {
    const versions = JSON.parse(read('metadata.json'))['shell-version'];
    assert.ok(versions.includes('51'), versions.join(','));
    const nums = versions.map(Number);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'ascending');
    for (let i = 1; i < nums.length; i++)
        assert.equal(nums[i], nums[i - 1] + 1, 'no gap in the supported range');
    const header = read('extension.js').split('\n')[0];
    assert.equal(header, `// Claude Usage Panel - GNOME Shell ${nums[0]}-${nums.at(-1)}`);
});
