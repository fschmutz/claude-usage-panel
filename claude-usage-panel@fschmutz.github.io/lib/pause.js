// Pause / resume, GNOME I/O: read the store `claudectl session pause`
// writes under <state dir>/pause/ (claude-code/pause.js owns the writes) and
// turn it into the rows the dropdown shows. The shapes and the row state are
// lib/pure/pause.js, the same calls the CLI makes; the live sessions are the
// registry scan of lib/waiting.js. Every read is async: this runs on each
// poll, on the Shell's main loop, and must never stall a frame. The panel
// never writes here - a click runs the installed claudectl.

import GLib from 'gi://GLib';

import {readJSONAsync} from './fs.js';
import {stateDir} from './paths.js';
import {
    isPauseSessionId, parsePauseDelivered, parsePauseRequest, parsePauseVerdict, pauseFileNames, pauseRows,
} from './pure.js';
import {listLiveSessions, procStart} from './waiting.js';

/** <state dir>/pause, the directory claude-code/paths.js pauseDir names. */
function pauseDir() {
    return GLib.build_filenamev([stateDir(), 'pause']);
}

const inDir = rel => GLib.build_filenamev([pauseDir(), ...rel.split('/')]);

/** A waiter lock {pid, procStart} whose process still runs (a recycled pid
 *  has another start time). */
async function waiterLive(sessionId) {
    const lock = await readJSONAsync(inDir(pauseFileNames(sessionId).waiter));
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0)
        return false;
    const start = await procStart(lock.pid);
    if (start === null)
        return false;
    return !lock.procStart || String(lock.procStart) === start;
}

/**
 * The current request and one row per session, for the dropdown: the pure
 * pauseRows join the CLI's `pause-status` runs too, so the panel, the
 * terminal and the menu-bar app name and rank the same rows the same way.
 *   request  the parsed request, or null (none, or unreadable). An old one
 *            is still shown: past the TTL its unanswered rows are final
 *            (expired), so nothing keeps polling for them.
 *   rows     the request's targets first, in request order, each with its
 *            row state; then every other live session with state null
 *   summary  pauseSummary over the targets
 * Every row carries `pid` (null when not running): the per-session Pause
 * button names the session by pid, never by a name two clones can share.
 */
export async function readPauseStatus({nowMs = Date.now()} = {}) {
    const [raw, live] = await Promise.all([
        readJSONAsync(inDir('request.json')),
        listLiveSessions(),
    ]);
    const request = parsePauseRequest(raw);
    const liveIds = live.map(s => s.sessionId).filter(isPauseSessionId);
    const ids = !request ? [] : request.targets === 'all' ? liveIds : request.targets;
    const records = Object.fromEntries(await Promise.all(ids.map(async sessionId => {
        const files = pauseFileNames(sessionId);
        const [delivered, verdict, waiter] = await Promise.all([
            readJSONAsync(inDir(files.delivered)).then(parsePauseDelivered),
            readJSONAsync(inDir(files.verdict)).then(parsePauseVerdict),
            waiterLive(sessionId),
        ]);
        return [sessionId, {delivered, verdict, waiterLive: waiter}];
    })));
    const {targets, others, summary} = pauseRows({request, live, records, nowMs});
    return {request, rows: [...targets, ...others], summary};
}
