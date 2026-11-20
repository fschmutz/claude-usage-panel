// The session snapshots `claudectl session` keeps (claude-code/tabs.js), as
// the preferences window shows them. The CLI owns the store - one JSON file
// per label, {version, savedAt, sessions: [{name, cwd, session_id, window?, tab?}]} - and
// this only reads it, ordered the same way the CLI's `store` lists it.

/** Autosaves are the ones the 30-minute schedule writes. */
export const AUTO_SNAPSHOT_PREFIX = 'auto-';

/**
 * Summarise parsed snapshot files, newest first by savedAt, then label in
 * reverse code-point order (not localeCompare: the Swift port must agree).
 * Mirrored by ClaudeUsageCore/Snapshots.swift; tests/fixtures/snapshots.json.
 * @param {{label: string, data: any}[]} files one entry per `<label>.json`
 * @returns {{count: number, autos: number, newest: {label, savedAt, sessions}|null}}
 */
export function summarizeSnapshots(files) {
    const valid = files
        .filter(f => f.data && Array.isArray(f.data.sessions))
        .map(f => ({label: f.label, savedAt: Number(f.data.savedAt) || 0, sessions: f.data.sessions}))
        .sort((a, b) => b.savedAt - a.savedAt || (a.label === b.label ? 0 : (a.label < b.label ? 1 : -1)));
    return {
        count: valid.length,
        autos: valid.filter(s => s.label.startsWith(AUTO_SNAPSHOT_PREFIX)).length,
        newest: valid[0] ?? null,
    };
}

/**
 * How far apart two reads of the boot time may be and still be the same boot.
 * The boot time is derived from the wall clock (macOS `kern.boottime`, Linux
 * `/proc/stat` btime), so a clock adjustment moves it by a little; a reboot
 * moves it by at least the previous boot's uptime.
 */
const AUTOSAVE_BOOT_TOLERANCE_MS = 60_000;

/**
 * Is the scheduled autosave paused? `claudectl session autosave pause` writes
 * {version, at, bootAt} (epoch ms) and the pause lasts until the next boot.
 * A missing or broken file, or a boot time that cannot be read, is not
 * paused: a pause that never expires would silently stop the backups.
 * Mirrored by ClaudeUsageCore/Snapshots.swift; tests/fixtures/snapshots.json `pause`.
 * @param {any} data the parsed pause file, null when there is none
 * @param {number|null} bootAtMs this boot's start, epoch ms; null when unknown
 * @returns {{paused: boolean, since: number|null, expired: boolean}}
 *   `expired`: a file from an earlier boot, for the CLI to remove
 */
export function autosavePauseState(data, bootAtMs) {
    const valid = data !== null && typeof data === 'object' && !Array.isArray(data) &&
        Number.isFinite(data.at) && Number.isFinite(data.bootAt);
    if (!valid || !Number.isFinite(bootAtMs))
        return {paused: false, since: null, expired: false};
    if (Math.abs(data.bootAt - bootAtMs) > AUTOSAVE_BOOT_TOLERANCE_MS)
        return {paused: false, since: null, expired: true};
    return {paused: true, since: data.at, expired: false};
}
