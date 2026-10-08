// The extension's file I/O, in one place: read text or JSON without throwing,
// and write ATOMICALLY - a temp file in the same directory, renamed over the
// target - so a crash mid-write can never leave a truncated session index, a
// half-pruned history or a half-written systemd unit behind. Pass `mode` for
// anything secret: the temp file is then CREATED with that mode, never a
// world-readable instant.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// The async half runs on the Shell's main loop without ever stalling a frame:
// a directory walk or a read that polls (sessions, transcripts) uses these.
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');

/** Children fetched per next_files_async round trip. */
const ENUMERATE_BATCH = 64;

/** The file's text, or null when it is missing or unreadable. */
export function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

/** The file parsed as JSON, or null when missing, unreadable or not JSON. */
export function readJSON(path) {
    const text = readText(path);
    if (text === null)
        return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** The file's text, read without blocking; null when missing or unreadable. */
export async function readTextAsync(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

/** readTextAsync parsed as JSON; null when missing, unreadable or not JSON. */
export async function readJSONAsync(path) {
    const text = await readTextAsync(path);
    if (text === null)
        return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * A directory's children as `map(Gio.FileInfo)` results, listed without
 * blocking; [] when it cannot be opened, and what was read when it vanishes
 * mid-listing. `attributes` is the Gio query string the map reads.
 */
export async function listChildrenAsync(path, attributes, map) {
    const out = [];
    let children;
    try {
        children = await Gio.File.new_for_path(path).enumerate_children_async(
            attributes, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
    } catch {
        return out;
    }
    try {
        for (;;) {
            const batch = await children.next_files_async(ENUMERATE_BATCH, GLib.PRIORITY_LOW, null);
            if (!batch.length)
                break;
            for (const info of batch)
                out.push(map(info));
        }
    } catch {
        // a directory that vanished mid-listing keeps what was read
    } finally {
        await children.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
    return out;
}

/**
 * Write `text` to `path` atomically. Creates the parent directory (0700 when
 * a mode is given, else the platform default). Throws on failure - callers
 * that can live without the write catch it.
 * @param {{mode?: number}} opts file mode for the new file (e.g. 0o600)
 */
export function writeText(path, text, {mode} = {}) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), mode === undefined ? 0o755 : 0o700);
    const tmp = `${path}.${GLib.get_real_time()}.tmp`;
    const bytes = new TextEncoder().encode(text);
    if (mode === undefined)
        GLib.file_set_contents(tmp, bytes);
    else
        GLib.file_set_contents_full(tmp, bytes, GLib.FileSetContentsFlags.CONSISTENT, mode);
    Gio.File.new_for_path(tmp).move(
        Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
}
