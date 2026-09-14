// Durable usage history: one JSONL line per poll that MOVED, under
// XDG_STATE_HOME, kept for 90 days. The forecast's own history is a rolling
// 6-hour window in a temp file - this is what survives long enough to answer
// "is this week worse than last". All the logic is in pure.js; this is the I/O.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readText, writeText} from './fs.js';
import {stateDir} from './paths.js';
import {parseWarehouse, pruneWarehouse} from './pure.js';

/** Same path the MCP server and the macOS app use, so all three write one file. */
export function warehousePath() {
    return GLib.build_filenamev([stateDir(), 'history.jsonl']);
}

/** Load the file, dropping anything past the retention window. The pruned file
 *  is written back (atomically) only when it actually shrank, so a normal start
 *  does no I/O. */
export function loadWarehouse(nowMs = Date.now(), path = warehousePath()) {
    const entries = parseWarehouse(readText(path) ?? '');
    const kept = pruneWarehouse(entries, nowMs);
    if (kept.length !== entries.length) {
        try {
            writeText(path, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
        } catch (e) {
            logError(e, 'claude-usage-panel: could not prune the usage history');
        }
    }
    return kept;
}

/** Append one poll - the same entry object the caller keeps in memory (from
 *  pure's warehouseEntry). Best-effort: a failed write costs a data point,
 *  never a refresh. Creates the state directory on first use. */
export function appendWarehouse(entry, path = warehousePath()) {
    const line = `${JSON.stringify(entry)}\n`;
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        const stream = Gio.File.new_for_path(path).append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(line), null);
        stream.close(null);
        return true;
    } catch (e) {
        logError(e, 'claude-usage-panel: could not record usage history');
        return false;
    }
}
