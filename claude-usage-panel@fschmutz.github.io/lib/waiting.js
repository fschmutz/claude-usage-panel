// Live-session registry + waiting markers, GNOME I/O. The join, age, reason
// and name fallback live in lib/pure/waiting.js; this only reads
// <config dir>/sessions the same way tabs.js does (dead pids dropped via
// /proc start time). Every read is async: it runs on each poll, on the
// Shell's main loop, and must never stall a frame.

import GLib from 'gi://GLib';

import {listChildrenAsync, readJSONAsync, readTextAsync} from './fs.js';
import {configDir} from './paths.js';
import {pidFromWaitingMarkerName, waitingList} from './pure.js';

/** Kernel start time (field 22) of a pid; comm may hold spaces and parens. */
async function procStart(pid) {
    const text = await readTextAsync(`/proc/${pid}/stat`);
    if (!text)
        return null;
    return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null;
}

/** One registry row as a live session, or null (not interactive, malformed,
 *  or its pid is gone / reused: the start time no longer matches). */
async function liveSession(file) {
    const d = await readJSONAsync(file);
    if (!d || d.kind !== 'interactive' || !Number.isInteger(d.pid) || !d.sessionId || !d.cwd)
        return null;
    if (await procStart(d.pid) !== String(d.procStart))
        return null;
    return {pid: d.pid, sessionId: d.sessionId, name: d.name ?? '', cwd: d.cwd};
}

/** Live sessions that are waiting, oldest wait first. */
export async function listWaiting({nowMs = Date.now()} = {}) {
    const dir = GLib.build_filenamev([configDir(), 'sessions']);
    const names = await listChildrenAsync(dir, 'standard::name', info => info.get_name());
    const files = names.map(name => ({name, file: GLib.build_filenamev([dir, name])}));
    const markerFiles = files.filter(f => pidFromWaitingMarkerName(f.name) !== null);
    const registry = files.filter(f => f.name.endsWith('.json') && !markerFiles.includes(f));
    const [markers, sessions] = await Promise.all([
        Promise.all(markerFiles.map(f => readJSONAsync(f.file))),
        Promise.all(registry.map(f => liveSession(f.file))),
    ]);
    return waitingList(sessions.filter(Boolean), markers.filter(Boolean), nowMs);
}
