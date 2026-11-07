// The extension's file I/O, in one place, and none of it blocks: everything
// here runs on the Shell's main loop (and in the preferences process, which
// shares these modules), so every read, listing and write is a Gio async call
// that never stalls a frame. Reads never throw (null / [] instead); writes
// are ATOMIC - GIO writes a temp file beside the target and renames it over
// on close - so a crash mid-write can never leave a truncated session index,
// a half-pruned history or a half-written systemd unit behind. Pass `mode`
// for anything secret: the temp file is then CREATED owner-only, never a
// world-readable instant.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'append_to_async', 'append_to_finish');
Gio._promisify(Gio.File.prototype, 'create_async', 'create_finish');
Gio._promisify(Gio.File.prototype, 'delete_async', 'delete_finish');
Gio._promisify(Gio.File.prototype, 'move_async', 'move_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');
Gio._promisify(Gio.OutputStream.prototype, 'close_async', 'close_finish');

/** Children fetched per next_files_async round trip. */
const ENUMERATE_BATCH = 64;

const bytesOf = text => new GLib.Bytes(new TextEncoder().encode(text));
const isError = (e, code) => e?.matches?.(Gio.IOErrorEnum, code) === true;

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
 * Write `text` to `path` atomically without blocking: GIO writes a temp file
 * beside it and renames it over the target on close. A symlinked target is
 * written through, so the link stays a link. The parent directory is created
 * first (one mkdir syscall, no file I/O): 0700 when a mode is given. Throws on
 * failure - callers that can live without the write catch it.
 * @param {{mode?: number}} opts 0o600 creates the file owner-only
 */
export async function writeTextAsync(path, text, {mode} = {}) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), mode === undefined ? 0o755 : 0o700);
    await Gio.File.new_for_path(path).replace_contents_bytes_async(bytesOf(text), null, false,
        mode === undefined ? Gio.FileCreateFlags.NONE : Gio.FileCreateFlags.PRIVATE, null);
}

/** Append `text` to `path` (created when missing), without blocking. Throws on failure. */
export async function appendTextAsync(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const stream = await Gio.File.new_for_path(path).append_to_async(
        Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
    try {
        await stream.write_bytes_async(bytesOf(text), GLib.PRIORITY_DEFAULT, null);
    } finally {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
}

/** Whether `path` exists (a dangling symlink does not). */
export async function existsAsync(path) {
    try {
        await Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        return true;
    } catch {
        return false;
    }
}

/** When `path` was last modified, in epoch ms; null when it is missing. */
export async function mtimeMsAsync(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        return info.get_modification_date_time().to_unix() * 1000;
    } catch {
        return null;
    }
}

/** Rename `from` over `to`. False when `from` is missing; other failures throw. */
export async function moveAsync(from, to) {
    try {
        await Gio.File.new_for_path(from).move_async(Gio.File.new_for_path(to),
            Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
        return true;
    } catch (e) {
        if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
            return false;
        throw e;
    }
}

/** Delete `path`; a missing file is no error, other failures throw. */
export async function removeAsync(path) {
    try {
        await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (!isError(e, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
}

/**
 * Create `path` with `text`, O_EXCL and owner-only (a lock file). False when
 * it already exists; other failures throw.
 */
export async function createExclusiveAsync(path, text) {
    let stream;
    try {
        stream = await Gio.File.new_for_path(path).create_async(
            Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (isError(e, Gio.IOErrorEnum.EXISTS))
            return false;
        throw e;
    }
    try {
        await stream.write_bytes_async(bytesOf(text), GLib.PRIORITY_DEFAULT, null);
    } finally {
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
    }
    return true;
}
