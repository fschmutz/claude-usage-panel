// The settings-file half every install-time JSON editor needs (json-edit.mjs,
// install/hooks-edit.mjs): read a JSON object that may not exist yet, find the
// file an edit really lands in, and write it back atomically with the mode it
// had. One copy: the two editors used to carry it line for line.
//
// Errors a user can act on (not JSON, not an object, a symlink loop) are
// thrown as JsonFileError with a message that names the file; the callers
// print it and exit non-zero.

import fs from 'node:fs';
import path from 'node:path';

import {writeAtomic} from '../../claude-code/private-fs.js';

export class JsonFileError extends Error {}

/** The JSON object in `file`; {} when the file does not exist. */
export function loadObject(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT')
            return {};
        throw e;
    }
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        throw new JsonFileError(`${file} is not valid JSON`);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        throw new JsonFileError(`${file} is not a JSON object`);
    return obj;
}

// The file the edit really lands in. A dotfile manager (stow, chezmoi, a
// dotfiles repo) makes ~/.claude/settings.json a symlink; renaming over the
// link would replace it with a detached regular file. Follows a chain, and a
// dangling link to the file it would create.
function realTarget(file) {
    let p = file;
    for (let hops = 0; hops < 40; hops++) {
        let st;
        try {
            st = fs.lstatSync(p);
        } catch (e) {
            if (e.code === 'ENOENT')
                return p;
            throw e;
        }
        if (!st.isSymbolicLink())
            return p;
        p = path.resolve(path.dirname(p), fs.readlinkSync(p));
    }
    throw new JsonFileError(`${file}: too many levels of symbolic links`);
}

/** Write `obj` over `file` (through its symlinks), atomically. The file
 *  keeps the mode it had (settings may be 0600 on purpose); a new one is
 *  private rather than whatever the umask allows. */
export function saveObject(file, obj) {
    writeAtomic(realTarget(file), `${JSON.stringify(obj, null, 2)}\n`, {mode: 0o600, keepMode: true});
}
