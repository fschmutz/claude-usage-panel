// Session pings from the extension: reads and writes the same systemd user
// units as `./install.sh sessionping`, so the installer and the preferences UI
// stay two frontends over one schedule. The unit files on disk are the source
// of truth - nothing is mirrored into GSettings - exactly like the macOS app
// and its launchd agent.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readText, writeText} from './fs.js';
import {stateDir} from './paths.js';
import {run} from './proc.js';

import {
    SP_UNIT, DEFAULT_DAYS, DEFAULT_TIMES,
    parseServiceExec, parseTimerTimes, serviceText, timerText,
} from './sessionPingUnit.js';

function unitDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user']);
}

function unitPath(ext) {
    return GLib.build_filenamev([unitDir(), `${SP_UNIT}.${ext}`]);
}

/** Where scripts/session-ping.sh records its last successful ping. */
export function lastPingPath() {
    return GLib.build_filenamev([stateDir(), 'last-ping']);
}

/** The raw stamp written by the last successful ping, or null. */
export function readLastPing() {
    const raw = readText(lastPingPath());
    return raw ? raw.trim() : null;
}

/**
 * The installed schedule.
 * @returns {{enabled: boolean, times: string[], days: number[], runner: ?string}}
 */
export function readSchedule() {
    const timer = readText(unitPath('timer'));
    const {runner, days} = parseServiceExec(readText(unitPath('service')));
    if (!timer)
        return {enabled: false, times: DEFAULT_TIMES.slice(), days: DEFAULT_DAYS.slice(), runner};
    const times = parseTimerTimes(timer);
    return {
        enabled: times.length > 0,
        times: times.length ? times : DEFAULT_TIMES.slice(),
        days: days ?? DEFAULT_DAYS.slice(),
        runner,
    };
}

/**
 * The ping worker script. Prefer the path the installed unit already uses (a
 * git-checkout install), else the copy `install.sh gnome` drops beside the
 * extension. Same resolution order as the macOS app's bundled Resources copy.
 */
export function resolveRunner(existing, extensionPath) {
    if (existing && GLib.file_test(existing, GLib.FileTest.IS_EXECUTABLE))
        return existing;
    const bundled = GLib.build_filenamev([extensionPath, 'scripts', 'session-ping.sh']);
    if (GLib.file_test(bundled, GLib.FileTest.EXISTS)) {
        // The exec bit can be lost in a copy; restore it best-effort.
        try {
            Gio.File.new_for_path(bundled).set_attribute_uint32(
                'unix::mode', 0o755, Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            // bash <runner> still works without it.
        }
        return bundled;
    }
    return null;
}

// Resolves to an error line, or null on success.
async function systemctl(args) {
    const {ok, stderr} = await run(['systemctl', '--user', ...args]);
    return ok ? null : stderr.trim() || 'systemctl failed';
}

export function hasSystemd() {
    return GLib.find_program_in_path('systemctl') !== null &&
        GLib.file_test('/run/systemd/system', GLib.FileTest.IS_DIR);
}

/**
 * Apply the desired schedule: write + enable the units, or disable + remove
 * them. Resolves to an error line for the UI, or null on success.
 */
export async function applySchedule({enabled, times, days, extensionPath}) {
    if (!hasSystemd()) {
        return 'No systemd user session here - schedule pings with ' +
            './install.sh sessionping instead.';
    }
    if (!enabled) {
        await systemctl(['disable', '--now', `${SP_UNIT}.timer`]);
        for (const ext of ['timer', 'service'])
            GLib.unlink(unitPath(ext));
        await systemctl(['daemon-reload']);
        return null;
    }
    if (!times.length)
        return 'Add at least one ping time (HH:MM).';
    const runner = resolveRunner(readSchedule().runner, extensionPath);
    if (!runner)
        return 'session-ping.sh not found - reinstall with ./install.sh gnome.';
    try {
        writeText(unitPath('service'), serviceText(runner, days));
        writeText(unitPath('timer'), timerText(times));
    } catch (e) {
        return `Could not write the systemd units: ${e.message}`;
    }
    const reload = await systemctl(['daemon-reload']);
    if (reload)
        return reload;
    return systemctl(['enable', '--now', `${SP_UNIT}.timer`]);
}
