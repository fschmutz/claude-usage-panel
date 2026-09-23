// The session snapshots `claudectl session` keeps (claude-code/tabs.js), as
// the preferences window shows them. The CLI owns the store - one JSON file
// per label, {version, savedAt, sessions: [{name, cwd, session_id}]} - and
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
