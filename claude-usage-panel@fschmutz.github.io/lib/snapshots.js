// Read the `claudectl session` snapshot store: the files under
// <state dir>/tabs, parsed without blocking, handed to summarizeSnapshots().
// The dropdown's Reopen button and the preferences window both read it.

import GLib from 'gi://GLib';

import {listChildrenAsync, readJSONAsync, readTextAsync} from './fs.js';
import {stateDir} from './paths.js';
import {autosavePauseState, summarizeSnapshots} from './pure.js';

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

/** This boot's start, epoch ms, from /proc/stat btime (what the CLI reads); null when unreadable. */
async function bootAtMs() {
    const m = /^btime (\d+)$/m.exec(await readTextAsync('/proc/stat') ?? '');
    return m ? Number(m[1]) * 1000 : null;
}

/**
 * The scheduled autosave's pause (`claudectl session autosave pause`), read
 * without blocking; the CLI is the only writer.
 * @returns {Promise<ReturnType<typeof autosavePauseState>>}
 */
export async function readAutosavePause() {
    const [data, boot] = await Promise.all([
        readJSONAsync(GLib.build_filenamev([stateDir(), 'autosave-paused.json'])), bootAtMs()]);
    return autosavePauseState(data, boot);
}
