// GLib + Gio file I/O over a plain object, for the GNOME tests that run real
// extension modules on a fake file tree: `files` maps a path to its text, and
// directories are implied by the paths under them. Only the ASYNC Gio calls
// are served; every synchronous file call throws, so a module that slips a
// blocking read or write back onto the Shell's main thread fails its tests
// (CLAUDE.md: nothing on the Shell main thread may block).
//
// `mtimes` maps a path to its mtime in epoch ms (default: now). The hooks
// stand in for one answer: onRead(path) -> text, onQueryInfo(path) -> a
// GFileInfo; onList(path) sees every directory listing. Every path written,
// moved to or appended to is pushed on `writes`.
import {setImmediate} from 'node:timers';
import {TextDecoder, TextEncoder} from 'node:util';

const encode = new TextEncoder();
const decode = new TextDecoder();
const later = (value) => new Promise((resolve) => { setImmediate(() => resolve(value)); });

const DIRECTORY = 2;
const gioError = (code) => Object.assign(new Error(`gio: ${code}`), {matches: (_domain, c) => c === code});

/** A synchronous file call: always an error here. */
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

export function memoryFs({files, mtimes = {}, onRead = null, onQueryInfo = null, onList = null, writes = []}) {
    const children = (dir) => {
        const out = new Map();
        for (const f of Object.keys(files)) {
            if (!f.startsWith(`${dir}/`))
                continue;
            const rest = f.slice(dir.length + 1).split('/');
            out.set(rest[0], (out.get(rest[0]) ?? false) || rest.length > 1);
        }
        return out;
    };
    const isDir = (path) => children(path).size > 0;
    const mtimeMs = (path) => mtimes[path] ?? Date.now();
    const info = (path, name = path.slice(path.lastIndexOf('/') + 1)) => ({
        get_name: () => name,
        get_file_type: () => (isDir(path) ? DIRECTORY : 1),
        get_size: () => (files[path] ?? '').length,
        get_attribute_uint64: () => Math.floor(mtimeMs(path) / 1000),
        get_modification_date_time: () => ({to_unix: () => Math.floor(mtimeMs(path) / 1000)}),
    });
    const put = (path, text) => {
        files[path] = text;
        mtimes[path] = Date.now();
        writes.push(path);
    };
    const stream = (path) => ({
        write_bytes_async: (bytes) => {
            files[path] = (files[path] ?? '') + decode.decode(bytes.data);
            return later(bytes.data.length);
        },
        close_async: () => later(true),
    });

    const file = (path) => ({
        path,
        get_path: () => path,
        enumerate_children: syncBan('enumerate_children'),
        load_contents: syncBan('load_contents'),
        replace_contents: syncBan('replace_contents'),
        query_info: syncBan('query_info'),
        create: syncBan('create'),
        move: syncBan('move'),
        delete: syncBan('delete'),
        append_to: syncBan('append_to'),
        query_exists: syncBan('query_exists'),
        async load_contents_async() {
            const early = onRead?.(path);
            if (typeof early === 'string')
                return later([encode.encode(early), null]);
            if (!(path in files))
                throw gioError('NOT_FOUND');
            return later([encode.encode(files[path]), null]);
        },
        async read_async() {
            if (!(path in files))
                throw gioError('NOT_FOUND');
            const data = encode.encode(files[path]);
            let pos = 0;
            return later({
                seek: (offset) => { pos = offset; },
                read_bytes_async: (count) => {
                    const out = data.subarray(pos, pos + count);
                    pos += out.length;
                    return later({get_data: () => out});
                },
                close_async: () => later(true),
            });
        },
        async replace_contents_bytes_async(bytes) {
            put(path, decode.decode(bytes.data));
            return later([true, null]);
        },
        async enumerate_children_async() {
            onList?.(path);
            if (!isDir(path))
                throw gioError('NOT_FOUND');
            let batch = [...children(path).keys()].map((name) => info(`${path}/${name}`, name));
            return later({
                next_files_async: () => {
                    const out = batch;
                    batch = [];
                    return later(out);
                },
                close_async: () => later(true),
            });
        },
        async query_info_async() {
            const early = onQueryInfo?.(path);
            if (early)
                return later(early);
            if (!(path in files) && !isDir(path))
                throw gioError('NOT_FOUND');
            return later(info(path));
        },
        // O_EXCL, owner-only: the refresh lock
        async create_async() {
            if (path in files)
                throw gioError('EXISTS');
            put(path, '');
            return later(stream(path));
        },
        async append_to_async() {
            files[path] ??= '';
            writes.push(path);
            return later(stream(path));
        },
        async delete_async() {
            if (!(path in files))
                throw gioError('NOT_FOUND');
            delete files[path];
            delete mtimes[path];
            return later(true);
        },
        async move_async(target) {
            if (!(path in files))
                throw gioError('NOT_FOUND');
            files[target.path] = files[path];
            mtimes[target.path] = mtimes[path];
            delete files[path];
            delete mtimes[path];
            writes.push(target.path);
            return later(true);
        },
    });

    const GLib = {
        PRIORITY_DEFAULT: 0,
        PRIORITY_LOW: 300,
        SOURCE_REMOVE: false,
        Bytes,
        build_filenamev: (parts) => parts.join('/'),
        path_get_dirname: (p) => p.slice(0, p.lastIndexOf('/')),
        mkdir_with_parents: () => 0,
        file_get_contents: syncBan('file_get_contents'),
        file_set_contents: syncBan('file_set_contents'),
        file_set_contents_full: syncBan('file_set_contents_full'),
    };
    const Gio = {
        _promisify: () => {},
        FileEnumerator: {prototype: {}},
        InputStream: {prototype: {}},
        OutputStream: {prototype: {}},
        FileQueryInfoFlags: {NONE: 0, NOFOLLOW_SYMLINKS: 1},
        FileCreateFlags: {NONE: 0, PRIVATE: 1},
        FileCopyFlags: {NONE: 0, OVERWRITE: 1},
        FileType: {REGULAR: 1, DIRECTORY},
        IOErrorEnum: {EXISTS: 'EXISTS', NOT_FOUND: 'NOT_FOUND'},
        File: {new_for_path: file, prototype: {}},
    };
    return {GLib, Gio, writes};
}
