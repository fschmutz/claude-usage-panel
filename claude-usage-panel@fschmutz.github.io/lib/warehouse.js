// Durable usage history: one JSONL line per poll that MOVED, under
// XDG_STATE_HOME, kept for 90 days. The forecast's own history is a rolling
// 6-hour window in a temp file - this is what survives long enough to answer
// "is this week worse than last". All the logic is in pure.js; this is the I/O.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {warehouseLine, parseWarehouse, pruneWarehouse} from './pure.js';

/** Same path the MCP server and the macOS app use, so all three write one file. */
export function warehousePath() {
    const state = GLib.getenv('XDG_STATE_HOME') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    return GLib.build_filenamev([state, 'claude-usage-panel', 'history.jsonl']);
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch {
        return '';
    }
}

/** Load the file, dropping anything past the retention window. The pruned file
 *  is written back only when it actually shrank, so a normal start does no I/O. */
export function loadWarehouse(nowMs = Date.now(), path = warehousePath()) {
    const entries = parseWarehouse(readText(path));
    const kept = pruneWarehouse(entries, nowMs);
    if (kept.length !== entries.length) {
        try {
            GLib.file_set_contents(
                path, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
        } catch (e) {
            logError(e, 'claude-usage-panel: could not prune the usage history');
        }
    }
    return kept;
}

/** Append one poll. Best-effort: a failed write costs a data point, never a
 *  refresh. Creates the state directory on first use. */
export function appendWarehouse(cards, nowMs = Date.now(), path = warehousePath()) {
    const line = `${warehouseLine(cards, nowMs)}\n`;
    try {
        const file = Gio.File.new_for_path(path);
        file.get_parent()?.make_directory_with_parents(null);
    } catch {
        // already there
    }
    try {
        const file = Gio.File.new_for_path(path);
        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(line), null);
        stream.close(null);
        return true;
    } catch (e) {
        logError(e, 'claude-usage-panel: could not record usage history');
        return false;
    }
}
