// Awake, GNOME I/O: read what is being held and what is owed back, and build
// the claudectl argv for the dropdown's buttons. Every decision is
// lib/pure/awake.js's.
//
// The two files under <state dir>/awake are read ASYNCHRONOUSLY: this runs on
// every poll, on the Shell's main loop, and must never stall a frame. The
// extension never holds the machine awake itself - starting and stopping goes
// through the installed `claudectl awake`, which spawns the detached holder
// that owns the inhibitor child. One holder, one journal, one lock.

import GLib from 'gi://GLib';

import {readJSON, readJSONAsync, writeText} from './fs.js';
import {stateDir} from './paths.js';
import {awakeState, normalizeAwakeConfig} from './pure.js';
import {listLiveSessions, listWaiting} from './waiting.js';

function awakeDir() {
    return GLib.build_filenamev([stateDir(), 'awake']);
}

/**
 * Put the floors and the ceiling from the preferences where the holder reads
 * them (`<awake dir>/config.json`), so a session started from the dropdown,
 * the CLI or the MCP tool runs on the same numbers. Written only when they
 * actually differ: this is called from the poll loop.
 *
 * @param {Gio.Settings} settings
 * @returns {boolean} whether anything was written
 */
export function syncAwakeConfig(settings) {
    const file = GLib.build_filenamev([awakeDir(), 'config.json']);
    const want = normalizeAwakeConfig({
        lowPowerFloor: settings.get_int('awake-battery-floor'),
        endFloor: settings.get_int('awake-end-floor'),
        maxSeconds: settings.get_int('awake-max-hours') * 3600,
    });
    const have = normalizeAwakeConfig(readJSON(file) ?? {});
    const same = Object.keys(want).every(key => want[key] === have[key]);
    if (same && readJSON(file))
        return false;
    try {
        writeText(file, `${JSON.stringify(want, null, 2)}\n`, {mode: 0o600});
        return true;
    } catch {
        // a read-only state dir is not a reason to fail a poll
        return false;
    }
}

/**
 * The whole Awake picture for the dropdown: what holds the machine, what is
 * left, and whether a past session left a setting behind.
 *
 * @param {{nowMs?: number}} [opts]
 * @returns {Promise<ReturnType<typeof awakeState>>}
 */
export async function readAwakeState({nowMs = Date.now()} = {}) {
    const dir = awakeDir();
    const [session, journal] = await Promise.all([
        readJSONAsync(GLib.build_filenamev([dir, 'session.json'])),
        readJSONAsync(GLib.build_filenamev([dir, 'journal.json'])),
    ]);
    // The registry is walked only for a hold that actually depends on it. A
    // session parked on a permission prompt counts: an unanswered prompt is
    // exactly when the machine must not drop off.
    let sessions = 0;
    if (session?.whileSessions === true) {
        const [live, waiting] = await Promise.all([listLiveSessions(), listWaiting({nowMs})]);
        sessions = live.length > 0 ? live.length : waiting.length;
    }
    return awakeState({session, journal, sessions, nowMs});
}

/**
 * The claudectl argv behind each dropdown control.
 *
 * @param {string} cli      the installed claudectl
 * @param {string} action   'on' | 'off' | 'extend' | 'recover'
 * @param {object} [opts]
 * @param {?number} [opts.seconds]      --for, in seconds
 * @param {boolean} [opts.whileSessions]
 * @param {boolean} [opts.lid]
 */
export function awakeCommand(cli, action, {seconds = null, whileSessions = false, lid = false} = {}) {
    if (action === 'off')
        return [cli, 'awake', 'off'];
    if (action === 'recover')
        return [cli, 'awake', 'recover', '--force'];
    const argv = [cli, 'awake', action];
    if (seconds !== null)
        argv.push('--for', `${Math.round(seconds / 60)}m`);
    if (action === 'on') {
        if (whileSessions)
            argv.push('--while-sessions');
        if (lid)
            argv.push('--lid');
    }
    return argv;
}
