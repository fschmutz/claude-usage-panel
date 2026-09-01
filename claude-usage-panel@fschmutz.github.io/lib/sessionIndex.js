// Which Claude Code sessions spent the plan today, and where to resume them.
//
// The raw material is ~/.claude/projects/<project>/<session-id>.jsonl - append-
// only transcripts that reach tens of megabytes each (160 MB touched in one day
// is normal). Re-reading them on every dropdown open would hitch the shell, so
// this keeps an incremental index in the cache directory: each file is folded
// once, from the byte offset it was folded to last time, and only when its size
// or mtime moved. A per-refresh byte budget caps the work a single tick can do,
// so even the very first run (cold index, everything to read) warms up over a
// few refreshes instead of freezing the compositor once.
//
// The index file is shared, by design, with the node ports (status line, MCP
// server) - same machine, same logs, same shape.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {foldSessionLine, localDay, newSessionAcc, pruneByDay, rankSessions} from './pure.js';

const CHUNK_BYTES = 1 << 20; // 1 MiB reads: small enough to stay responsive
const DEFAULT_BUDGET = 64 << 20; // …and at most this much parsing per refresh:
// a full cold pass over a heavy day (160 MB of transcripts) measures ~720 ms of
// wall time, so this caps one refresh at roughly a third of that, and the
// extension re-runs sooner while `pending` is set.
const CARRY_MAX = 1 << 20; // a "line" longer than this is not a line
export const INDEX_VERSION = 1;

export function indexPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage-panel', 'sessions.json']);
}

function projectsDir() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
}

export function loadIndex() {
    try {
        const [ok, bytes] = GLib.file_get_contents(indexPath());
        if (!ok)
            return {version: INDEX_VERSION, files: {}};
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (parsed?.version !== INDEX_VERSION || typeof parsed.files !== 'object')
            return {version: INDEX_VERSION, files: {}};
        return parsed;
    } catch {
        return {version: INDEX_VERSION, files: {}};
    }
}

export function saveIndex(index) {
    try {
        const path = indexPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        GLib.file_set_contents(path, JSON.stringify(index));
    } catch {
        // A read-only cache dir just means no cache, not a broken panel.
    }
}

// Transcripts whose mtime is today or yesterday - the only ones that can carry
// tokens the UI will rank. Yesterday is kept so a session started before
// midnight still resolves its header fields.
function candidates(nowMs) {
    const cutoff = (nowMs - 2 * 86_400_000) / 1000;
    const out = [];
    const root = Gio.File.new_for_path(projectsDir());
    let dirs;
    try {
        dirs = root.enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return out; // no ~/.claude/projects yet
    }
    let dirInfo;
    while ((dirInfo = dirs.next_file(null)) !== null) {
        if (dirInfo.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;
        const dir = dirs.get_child(dirInfo);
        let files;
        try {
            files = dir.enumerate_children(
                'standard::name,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        let info;
        while ((info = files.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.jsonl'))
                continue;
            const mtime = info.get_attribute_uint64('time::modified');
            if (mtime < cutoff)
                continue;
            out.push({
                path: files.get_child(info).get_path(),
                size: info.get_size(),
                mtimeMs: mtime * 1000,
            });
        }
    }
    return out;
}

function readChunk(stream, cancellable) {
    return new Promise(resolve => {
        stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_LOW, cancellable, (self, res) => {
            try {
                resolve(self.read_bytes_finish(res));
            } catch {
                resolve(null);
            }
        });
    });
}

function lastNewline(bytes) {
    for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] === 0x0a)
            return i;
    }
    return -1;
}

function concatBytes(a, b) {
    if (!a.length)
        return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * Fold the not-yet-read tail of one transcript into its index entry.
 *
 * Chunks are cut at the last newline BYTE before decoding, and the offset only
 * advances that far. A 1 MiB read can end mid-line and mid-UTF-8 sequence -
 * GJS's TextDecoder has no streaming mode to hold a split code point back, and
 * folding a half-written turn would count it wrong anyway. Whatever follows the
 * last newline is read again next time; transcripts are append-only, so that
 * costs one chunk at most.
 * @returns {Promise<number>} bytes read (0 when there was nothing to do)
 */
async function foldTail(file, entry, budget, nowMs, cancellable) {
    const start = entry.offset ?? 0;
    if (file.size <= start)
        return 0;
    const day = localDay(nowMs);
    let stream;
    try {
        stream = Gio.File.new_for_path(file.path).read(cancellable);
        if (start > 0)
            stream.seek(start, GLib.SeekType.SET, cancellable);
    } catch {
        return 0;
    }
    const decoder = new TextDecoder('utf-8');
    let read = 0;
    let carry = new Uint8Array(0);
    while (read < budget) {
        const bytes = await readChunk(stream, cancellable);
        const size = bytes ? bytes.get_size() : 0;
        if (!size)
            break;
        read += size;
        const buf = concatBytes(carry, bytes.toArray());
        const cut = lastNewline(buf);
        if (cut < 0) {
            // No complete line in this chunk. A "line" past the cap is not a
            // line at all - drop it rather than growing without bound.
            carry = buf.length > CARRY_MAX ? new Uint8Array(0) : buf;
            continue;
        }
        for (const line of decoder.decode(buf.subarray(0, cut + 1)).split('\n'))
            foldSessionLine(line, entry, day);
        carry = buf.slice(cut + 1);
    }
    try {
        stream.close(null);
    } catch {
        // closing a stream we already read is best-effort
    }
    entry.offset = start + Math.max(0, read - carry.length);
    entry.carry = '';
    entry.byDay = pruneByDay(entry.byDay, nowMs);
    return read;
}

/**
 * Update the index and return today's sessions, biggest spender first.
 * @param {{nowMs?: number, limit?: number, budgetBytes?: number,
 *          cancellable?: Gio.Cancellable}} opts
 * @returns {Promise<{sessions: object[], pending: boolean}>}
 *   `pending` is true when the byte budget ran out with files still to fold -
 *   the numbers are then a floor, and the next refresh continues where this one
 *   stopped.
 */
export async function refreshSessions({
    nowMs = Date.now(), limit = 5, budgetBytes = DEFAULT_BUDGET, cancellable = null,
} = {}) {
    const index = loadIndex();
    const files = candidates(nowMs);
    let budget = budgetBytes;
    let pending = false;
    let dirty = false;

    for (const file of files) {
        let entry = index.files[file.path];
        // Shrunk below what we already folded: the file was replaced, not
        // appended to. Start it over rather than folding from a stale offset.
        if (!entry || (entry.offset ?? 0) > file.size)
            entry = Object.assign(newSessionAcc(), {offset: 0, carry: ''});
        if (entry.size === file.size && entry.mtimeMs === file.mtimeMs) {
            index.files[file.path] = entry;
            continue;
        }
        if (budget <= 0) {
            pending = true;
            index.files[file.path] = entry;
            continue;
        }
        const used = await foldTail(file, entry, budget, nowMs, cancellable);
        budget -= used;
        dirty = true;
        // Only claim the file is fully folded when it actually is; otherwise
        // leave size/mtime stale so the next refresh picks the rest up.
        if (entry.offset >= file.size) {
            entry.size = file.size;
            entry.mtimeMs = file.mtimeMs;
        } else {
            pending = true;
        }
        index.files[file.path] = entry;
    }

    // Forget files that fell out of the candidate window - the index must not
    // grow for every session ever opened.
    const live = new Set(files.map(f => f.path));
    for (const path of Object.keys(index.files)) {
        if (!live.has(path)) {
            delete index.files[path];
            dirty = true;
        }
    }
    if (dirty)
        saveIndex(index);

    return {sessions: rankSessions(Object.values(index.files), {nowMs, limit}), pending};
}
