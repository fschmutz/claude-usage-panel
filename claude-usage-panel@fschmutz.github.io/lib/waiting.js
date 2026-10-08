// Live-session registry + waiting markers, GNOME I/O. The join, age, reason
// and name fallback live in lib/pure/waiting.js; this only reads
// <config dir>/sessions the same way tabs.js does (dead pids dropped via
// /proc start time). Every read is async: it runs on each poll, on the
// Shell's main loop, and must never stall a frame.

import GLib from 'gi://GLib';

import {listChildrenAsync, readJSONAsync, readTextAsync} from './fs.js';
import {configDir} from './paths.js';
import {pidFromWaitingMarkerName, waitingList} from './pure.js';

/** Kernel start time (field 22) of a pid; comm may hold spaces and parens.
 *  null when the pid is gone. */
export async function procStart(pid) {
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

/** The registry dir split into marker files and registry rows. */
async function scanRegistry() {
    const dir = GLib.build_filenamev([configDir(), 'sessions']);
    const names = await listChildrenAsync(dir, 'standard::name', info => info.get_name());
    const markerFiles = [];
    const registry = [];
    for (const name of names) {
        const file = GLib.build_filenamev([dir, name]);
        if (pidFromWaitingMarkerName(name) !== null)
            markerFiles.push(file);
        else if (name.endsWith('.json'))
            registry.push(file);
    }
    return {markerFiles, registry};
}

const liveOf = async registry => (await Promise.all(registry.map(liveSession))).filter(Boolean);

/** Every live interactive session in the registry: {pid, sessionId, name, cwd}. */
export async function listLiveSessions() {
    return liveOf((await scanRegistry()).registry);
}

/** Live sessions that are waiting, oldest wait first. */
export async function listWaiting({nowMs = Date.now()} = {}) {
    const {markerFiles, registry} = await scanRegistry();
    const [markers, sessions] = await Promise.all([
        Promise.all(markerFiles.map(readJSONAsync)),
        liveOf(registry),
    ]);
    return waitingList(sessions, markers.filter(Boolean), nowMs);
}
