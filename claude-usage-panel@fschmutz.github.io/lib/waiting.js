// Live-session registry + waiting markers, GNOME I/O. The join, age and
// reason live in lib/pure/waiting.js; this only reads <config dir>/sessions
// the same way tabs.js does (dead pids dropped via /proc start time).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readJSON, readText} from './fs.js';
import {configDir} from './paths.js';
import {pidFromWaitingMarkerName, waitingList} from './pure.js';

export function sessionRegistryDir() {
    return GLib.build_filenamev([configDir(), 'sessions']);
}

function procStart(pid) {
    const text = readText(`/proc/${pid}/stat`);
    if (!text)
        return null;
    return text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null;
}

function isAlive(entry) {
    return procStart(entry.pid) === String(entry.procStart);
}

function listDir(dir) {
    const names = [];
    try {
        const en = Gio.File.new_for_path(dir)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            names.push(info.get_name());
        en.close(null);
    } catch {
        // no registry yet
    }
    return names;
}

/** Live sessions that are waiting, oldest wait first. */
export function listWaiting({nowMs = Date.now()} = {}) {
    const dir = sessionRegistryDir();
    const sessions = [];
    const markers = [];
    for (const name of listDir(dir)) {
        const file = GLib.build_filenamev([dir, name]);
        if (pidFromWaitingMarkerName(name) !== null) {
            const marker = readJSON(file);
            if (marker)
                markers.push(marker);
            continue;
        }
        if (!name.endsWith('.json'))
            continue;
        const d = readJSON(file);
        if (!d || d.kind !== 'interactive' || !d.pid || !d.sessionId || !d.cwd)
            continue;
        if (!isAlive(d))
            continue;
        sessions.push({
            pid: d.pid,
            sessionId: d.sessionId,
            name: d.name || d.cwd.replace(/\/+$/, '').split('/').pop() || 'session',
            cwd: d.cwd,
        });
    }
    return waitingList(sessions, markers, nowMs);
}
