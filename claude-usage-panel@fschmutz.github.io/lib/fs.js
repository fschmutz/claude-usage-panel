// The extension's file I/O, in one place: read text or JSON without throwing,
// and write ATOMICALLY - a temp file in the same directory, renamed over the
// target - so a crash mid-write can never leave a truncated session index, a
// half-pruned history or a half-written systemd unit behind. Pass `mode` for
// anything secret: the temp file is then CREATED with that mode, never a
// world-readable instant.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
