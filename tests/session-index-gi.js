// The slice of GLib / Gio that the GNOME session index (lib/sessionIndex.js,
// lib/paths.js, lib/fs.js) touches, backed by node:fs, so the real module
// runs under `node --test`. tests/session-index.test.js maps gi://GLib and
// gi://Gio here with module.registerHooks. The environment it reads - HOME,
// the cache dir, getenv - comes from globalThis.giStub, set per test.
//
// Only what those three files call is implemented; anything else throws, so
// a new GIO call in the index shows up as a test failure, not a silent pass.
import {Buffer} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {setImmediate} from 'node:timers';

const cfg = () => globalThis.giStub;

export const GLib = {
    PRIORITY_LOW: 300,
    SeekType: {SET: 1},
    FileSetContentsFlags: {CONSISTENT: 1},
    build_filenamev: (parts) => path.join(...parts),
    get_home_dir: () => cfg().home,
    get_user_cache_dir: () => cfg().cache,
    getenv: (name) => cfg().env[name] ?? null,
    get_real_time: () => Date.now() * 1000,
    path_get_dirname: (p) => path.dirname(p),
    mkdir_with_parents: (dir, mode) => fs.mkdirSync(dir, {recursive: true, mode}),
    file_get_contents: (p) => [true, new Uint8Array(fs.readFileSync(p))],
    file_set_contents: (p, bytes) => fs.writeFileSync(p, bytes),
    file_set_contents_full: (p, bytes, _flags, mode) => fs.writeFileSync(p, bytes, {mode}),
};

// GLib.Bytes as the index reads it.
const bytesOf = (buf) => ({get_size: () => buf.length, toArray: () => new Uint8Array(buf)});

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
        enumerate_children(_attrs, _flags, _cancellable) {
            const names = fs.readdirSync(p); // throws on a missing dir, as GIO does
            let i = 0;
            return {
                next_file: () => (i < names.length ? infoOf(p, names[i++]) : null),
                get_child: (info) => fileFor(path.join(p, info.get_name())),
            };
        },
        read(_cancellable) {
            const fd = fs.openSync(p, 'r');
            let pos = 0;
            return {
                seek: (offset) => {
                    pos = offset;
                },
                read_bytes_async(count, _prio, _cancellable, cb) {
                    const buf = Buffer.alloc(count);
                    const n = fs.readSync(fd, buf, 0, count, pos);
                    pos += n;
                    const self = this;
                    setImmediate(() => cb(self, buf.subarray(0, n)));
                },
                read_bytes_finish: (res) => bytesOf(res),
                close: () => fs.closeSync(fd),
            };
        },
        move(dest, _flags, _cancellable, _progress) {
            fs.renameSync(p, dest.get_path());
        },
    };
}

export const Gio = {
    FileQueryInfoFlags: {NONE: 0},
    FileType: {REGULAR: 1, DIRECTORY: 2},
    FileCopyFlags: {OVERWRITE: 1},
    File: {new_for_path: fileFor},
};
