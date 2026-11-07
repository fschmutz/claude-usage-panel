// Durable usage history: one JSONL line per poll that MOVED, under
// XDG_STATE_HOME, kept for 90 days. The forecast's own history is a rolling
// 6-hour window in a temp file - this is what survives long enough to answer
// "is this week worse than last". All the logic is in pure.js; this is the I/O,
// and none of it blocks: the file runs to hundreds of KB, and it is loaded
// while the Shell enables the extension.

import GLib from 'gi://GLib';

import {appendTextAsync, readTextAsync, writeTextAsync} from './fs.js';
import {stateDir} from './paths.js';
import {parseWarehouse, pruneWarehouse} from './pure.js';

/** Same path the MCP server and the macOS app use, so all three write one file. */
function warehousePath() {
    return GLib.build_filenamev([stateDir(), 'history.jsonl']);
}

/** Load the file, dropping anything past the retention window. The pruned file
 *  is written back (atomically) only when it actually shrank, so a normal start
 *  writes nothing. */
export async function loadWarehouse(nowMs = Date.now(), path = warehousePath()) {
    const entries = parseWarehouse((await readTextAsync(path)) ?? '');
    const kept = pruneWarehouse(entries, nowMs);
    if (kept.length !== entries.length) {
        try {
            await writeTextAsync(path, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
        } catch (e) {
            logError(e, 'claude-usage-panel: could not prune the usage history');
        }
    }
    return kept;
}

/** Append one poll - the same entry object the caller keeps in memory (from
 *  pure's warehouseEntry). Best-effort: a failed write costs a data point,
 *  never a refresh. Creates the state directory on first use. */
export async function appendWarehouse(entry, path = warehousePath()) {
    try {
        await appendTextAsync(path, `${JSON.stringify(entry)}\n`);
        return true;
    } catch (e) {
        logError(e, 'claude-usage-panel: could not record usage history');
        return false;
    }
}
