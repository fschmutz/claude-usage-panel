// Read the `claudectl session` snapshot store: the files under
// <state dir>/tabs, parsed without blocking, handed to summarizeSnapshots().
// The dropdown's Reopen button and the preferences window both read it.

import GLib from 'gi://GLib';

import {listChildrenAsync, readJSONAsync} from './fs.js';
import {stateDir} from './paths.js';
import {summarizeSnapshots} from './pure.js';

function snapshotsDir() {
    return GLib.build_filenamev([stateDir(), 'tabs']);
}

/** @returns {Promise<ReturnType<typeof summarizeSnapshots>>} */
export async function readSnapshots() {
    const dir = snapshotsDir();
    const names = await listChildrenAsync(dir, 'standard::name', info => info.get_name());
    const files = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => ({
        label: name.slice(0, -5), data: await readJSONAsync(GLib.build_filenamev([dir, name])),
    })));
    return summarizeSnapshots(files);
}
