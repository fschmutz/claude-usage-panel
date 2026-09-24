// lib/sessionPing.js (the GNOME preferences' ping schedule): every error line
// the preferences show is translated.
//
// Offline and GJS-free: lib/sessionPing.js is loaded against stand-ins for
// gi://GLib, gi://Gio, gettext and ./proc.js, so its error lines are checked
// as the preferences window would receive them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'claude-usage-panel@fschmutz.github.io');

// ── Stand-ins for the GJS modules lib/sessionPing.js imports ─────────────────
// Every gettext lookup comes back wrapped in «», so a string that skipped
// translation is told apart from one that went through it.
const world = {
    systemd: true,
    bundledRunner: true,
    writeFails: false,
    systemctl: {ok: true, stderr: ''},
};
globalThis.sessionPingStub = {
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
    'gi://GLib': 'export default globalThis.sessionPingStub.GLib;',
    'gi://Gio': 'export default globalThis.sessionPingStub.Gio;',
    gettext: `export default {domain: () => ({
        gettext: s => globalThis.sessionPingStub.gettext(s),
    })};`,
    './proc.js': 'export const run = async () => globalThis.sessionPingStub.world.systemctl;',
};
registerHooks({
    resolve(specifier, context, next) {
        const local = specifier === './proc.js' && context.parentURL?.endsWith('/lib/sessionPing.js');
        if (local || (specifier !== './proc.js' && STUBS[specifier]))
            return {url: `session-ping-stub:${encodeURIComponent(specifier)}`, shortCircuit: true};
        return next(specifier, context);
    },
    load(url, context, next) {
        if (url.startsWith('session-ping-stub:')) {
            const source = STUBS[decodeURIComponent(url.slice('session-ping-stub:'.length))];
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
    const orig = globalThis.sessionPingStub.GLib.mkdir_with_parents;
    globalThis.sessionPingStub.GLib.mkdir_with_parents = () => {
        throw new Error("can't write $& or $1");
    };
    try {
        assert.equal(await ask(), "«Could not write the systemd units: can't write $& or $1»");
    } finally {
        globalThis.sessionPingStub.GLib.mkdir_with_parents = orig;
    }
});
