// The slice of GLib / Gio that the GNOME session index (lib/sessionIndex.js,
// lib/paths.js, lib/fs.js) touches, backed by node:fs, so the real module
// runs under `node --test`. tests/session-index.test.js maps gi://GLib and
// gi://Gio here with module.registerHooks. The environment it reads - HOME,
// the cache dir, getenv - comes from globalThis.giStub, set per test.
//
// Only what those three files call is implemented; anything else throws, so
// a new GIO call in the index shows up as a test failure, not a silent pass,
// and every synchronous file call throws too.
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {setImmediate} from 'node:timers';

const cfg = () => globalThis.giStub;

// Every synchronous file call throws: the index runs on the Shell's main loop
// and must use the async variant of each (CLAUDE.md: nothing on the Shell
// main thread may block). A sync call slipping back in fails these tests.
const syncBan = (name) => () => {
    throw new Error(`gi stub: synchronous ${name} on the Shell main thread`);
};

class Bytes {
    constructor(data) {
        this.data = data;
    }

    get_data() {
        return this.data;
    }
}

export const GLib = {
    PRIORITY_LOW: 300,
    SeekType: {SET: 1},
    FileSetContentsFlags: {CONSISTENT: 1},
    Bytes,
    build_filenamev: (parts) => path.join(...parts),
    get_home_dir: () => cfg().home,
    get_user_cache_dir: () => cfg().cache,
    getenv: (name) => cfg().env[name] ?? null,
    get_real_time: () => Date.now() * 1000,
    path_get_dirname: (p) => path.dirname(p),
    mkdir_with_parents: (dir, mode) => fs.mkdirSync(dir, {recursive: true, mode}),
    file_get_contents: syncBan('file_get_contents'),
    file_set_contents: syncBan('file_set_contents'),
    file_set_contents_full: syncBan('file_set_contents_full'),
};

// GLib.Bytes as the index reads it.
const bytesOf = (buf) => ({get_size: () => buf.length, toArray: () => new Uint8Array(buf)});
const later = (value) => new Promise((resolve) => setImmediate(() => resolve(value)));

// GFileInfo for one directory entry: `time::modified` is whole seconds, as
// GIO reports it.
function infoOf(dir, name) {
    const st = fs.statSync(path.join(dir, name));
    return {
        get_name: () => name,
        get_size: () => st.size,
        get_file_type: () => (st.isDirectory() ? Gio.FileType.DIRECTORY : Gio.FileType.REGULAR),
        get_attribute_uint64: (attr) => {
            if (attr !== 'time::modified') throw new Error(`gi stub: attribute ${attr}`);
            return Math.floor(st.mtimeMs / 1000);
        },
    };
}

function fileFor(p) {
    return {
        get_path: () => p,
        enumerate_children: syncBan('enumerate_children'),
        read: syncBan('read'),
        move: syncBan('move'),
        load_contents: syncBan('load_contents'),
        async enumerate_children_async() {
            const names = fs.readdirSync(p); // throws on a missing dir, as GIO does
            let batch = names.map((n) => infoOf(p, n));
            await later();
            return {
                next_files_async: async () => {
                    const out = batch;
                    batch = [];
                    return later(out);
                },
                close_async: () => later(true),
            };
        },
        async load_contents_async() {
            const data = new Uint8Array(fs.readFileSync(p)); // throws when missing, as GIO does
            return later([data, null]);
        },
        async replace_contents_bytes_async(bytes) {
            // GIO writes a temp file beside the target and renames it over
            const tmp = `${p}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, bytes.get_data());
            fs.renameSync(tmp, p);
            return later([true, null]);
        },
        async read_async() {
            const fd = fs.openSync(p, 'r');
            let pos = 0;
            await later();
            return {
                seek: (offset) => {
                    pos = offset;
                },
                read_bytes_async(count) {
                    const buf = Buffer.alloc(count);
                    const n = fs.readSync(fd, buf, 0, count, pos);
                    pos += n;
                    return later(bytesOf(buf.subarray(0, n)));
                },
                close_async: () => {
                    fs.closeSync(fd);
                    return later(true);
                },
            };
        },
    };
}

export const Gio = {
    // lib/fs.js promisifies its async calls at import: this stand-in serves
    // them as promises already
    _promisify: () => {},
    FileEnumerator: {prototype: {}},
    InputStream: {prototype: {}},
    OutputStream: {prototype: {}},
    File: {new_for_path: fileFor, prototype: {}},
    FileQueryInfoFlags: {NONE: 0},
    FileCreateFlags: {NONE: 0},
    FileType: {REGULAR: 1, DIRECTORY: 2},
    FileCopyFlags: {OVERWRITE: 1},
};
