// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there (the Node clients import
// this file directly).
//
// Pause / resume every live Claude Code session. `claudectl session pause`
// (or a panel button that runs it) writes ONE request file; each session's
// pause hook delivers it once - an asyncRewake waiter wakes an idle session,
// a PreToolUse deny reaches a busy one - and the session answers with a
// verdict file. This module owns the shapes of those files, which request a
// session still owes a delivery, the per-session row state and the row join
// the CLI and the panels show. The protocol texts a session receives are
// ./pause-protocol.js.
//
// Twin of ClaudeUsageCore/Pause.swift for what the menu-bar app reads: the
// request shape, the row states, the summary, the row names and the text
// cleaning (tests/fixtures/pause.json pins both). Node-only, no port to
// mirror: the delivery side (shouldDeliver, pauseBindingOk, pretoolEligible,
// pauseOwed, the delivery / verdict records, pauseRows, waiterOwnership, the
// hook JSON). What a session left running is pure/leftovers.js. The app never delivers and never joins records: it reads
// `claudectl session pause-status --json`, which pauseRows already built.

import {isObject} from './json.js';

export const PAUSE_VERSION = 1;
export const PAUSE_KINDS = Object.freeze(['pause', 'resume']);
export const PAUSE_VERDICTS = Object.freeze(['SAFE', 'NOT_SAFE']);
/** Who sent a request. `session` is set by claudectl itself when it runs
 *  inside a Claude Code session (a model's Bash call, or `!` from the
 *  prompt): never a flag, and the session is told it was not the user. */
export const PAUSE_SOURCES = Object.freeze(['cli', 'gnome', 'macos', 'session']);
export const PAUSE_VIAS = Object.freeze(['rewake', 'pretooluse']);
/** A request older than this is never delivered: a pause sent yesterday
 *  must not stop a session started this morning. */
export const PAUSE_REQUEST_TTL_MS = 3_600_000;
/** The asyncRewake hook's `timeout` (seconds). Claude Code kills the hook
 *  then (default 600 s); Stop re-arms a fresh waiter after every turn. A
 *  day, not less: the waiter is what wakes a session left idle overnight. */
export const PAUSE_HOOK_TIMEOUT_S = 86_400;
/** The PreToolUse backstop must never stall a tool call for long. */
const PAUSE_PRETOOL_TIMEOUT_S = 10;
/** Transcript writes this long after a checkpoint are new work, not the
 *  protocol's own last steps (gate, report, reply). */
export const PAUSE_CONSUMED_GRACE_MS = 600_000;
/** A pause older than this is never offered to resume again. */
export const PAUSE_OWED_MAX_AGE_MS = 14 * 86_400_000;
/** The longest verdict reason kept (code points); the rest is cut. */
export const PAUSE_REASON_MAX = 300;
const PAUSE_TEXT_MAX = 1024;

const KIND_SET = new Set(PAUSE_KINDS);
const VERDICT_SET = new Set(PAUSE_VERDICTS);
const SOURCE_SET = new Set(PAUSE_SOURCES);
const VIA_SET = new Set(PAUSE_VIAS);
// Session ids reach file names: a uuid in practice, never a path.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// C0, DEL and C1: a name, reason or path reaches a terminal and a panel,
// where ESC / OSC sequences would retitle it, write the clipboard or hide rows.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export const isPauseSessionId = (id) => typeof id === 'string' && SESSION_ID_RE.test(id);
const isPauseRequestId = (id) => typeof id === 'string' && REQUEST_ID_RE.test(id);

/** The files of one session in the pause dir, relative to it. */
export function pauseFileNames(sessionId) {
    return {
        delivered: `${sessionId}.delivered.json`,
        verdict: `${sessionId}.verdict.json`,
        waiter: `${sessionId}.waiter`,
        resumed: `${sessionId}.resumed.json`,
        reason: `${sessionId}.reason.txt`,
        checkpoint: `checkpoints/${sessionId}.md`,
    };
}

const isStamp = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Text safe to print: every control character (C0, DEL, C1) becomes a
 * space, and at most `max` code points are kept. null for a non-string or
 * an empty string.
 */
export function cleanPauseText(v, max = PAUSE_TEXT_MAX) {
    if (typeof v !== 'string' || !v)
        return null;
    return [...v.replace(CONTROL_RE, ' ')].slice(0, max).join('');
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const optStart = (v) => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : null);

/**
 * A request, or null when a field has the wrong JSON type. `targets` is
 * "all" or a non-empty list of session ids (invalid ids dropped; none left
 * is null). `sessions` is the metadata the CLI records per target: name and
 * cwd for the rows (a session that ended still has its name), pid and
 * procStart so a later process resuming the same id is not paused by it.
 * `origin` is the sending session's id when `from` is "session".
 */
export function parsePauseRequest(raw) {
    if (!isObject(raw))
        return null;
    const {id, kind, at, from} = raw;
    if (raw.version !== PAUSE_VERSION || !isPauseRequestId(id) || !KIND_SET.has(kind) || !isStamp(at))
        return null;
    let targets;
    if (raw.targets === 'all') {
        targets = 'all';
    } else if (Array.isArray(raw.targets)) {
        targets = [...new Set(raw.targets.filter(isPauseSessionId))];
        if (!targets.length)
            return null;
    } else {
        return null;
    }
    const sessions = (Array.isArray(raw.sessions) ? raw.sessions : [])
        .filter((s) => isObject(s) && isPauseSessionId(s.sessionId))
        .map((s) => ({
            sessionId: s.sessionId, name: cleanPauseText(s.name) ?? '', cwd: cleanPauseText(s.cwd) ?? '',
            pid: posInt(s.pid), procStart: optStart(s.procStart),
        }));
    return {
        version: PAUSE_VERSION, id, kind, at, targets, from: SOURCE_SET.has(from) ? from : 'cli', sessions,
        origin: isPauseSessionId(raw.origin) ? raw.origin : null,
    };
}

/** A delivery record, or null. */
export function parsePauseDelivered(raw) {
    if (!isObject(raw) || !isPauseRequestId(raw.requestId) || !isStamp(raw.at) || !VIA_SET.has(raw.via))
        return null;
    return {requestId: raw.requestId, at: raw.at, via: raw.via};
}

/** A verdict, or null. `reason` (cut at PAUSE_REASON_MAX) and `checkpoint`
 *  are optional strings, control characters blanked. */
export function parsePauseVerdict(raw) {
    if (!isObject(raw) || !isPauseRequestId(raw.requestId) || !isStamp(raw.at) || !VERDICT_SET.has(raw.verdict))
        return null;
    return {
        requestId: raw.requestId, at: raw.at, verdict: raw.verdict,
        reason: cleanPauseText(raw.reason, PAUSE_REASON_MAX), checkpoint: cleanPauseText(raw.checkpoint),
    };
}

/** The request names this session (and has not expired at `nowMs`). */
function pauseTargets(request, sessionId, nowMs) {
    const r = parsePauseRequest(request);
    if (!r || !isPauseSessionId(sessionId))
        return false;
    if (nowMs - r.at > PAUSE_REQUEST_TTL_MS)
        return false;
    return r.targets === 'all' || r.targets.includes(sessionId);
}

/** A hook should deliver: the request names this session and its delivery
 *  record is for another request (or there is none). */
export function shouldDeliver(request, sessionId, delivered, nowMs) {
    if (!pauseTargets(request, sessionId, nowMs))
        return false;
    return parsePauseDelivered(delivered)?.requestId !== request.id;
}

/**
 * The process asking for a delivery is the one the request was sent to.
 * A request names session ids, and `claude --resume <id>` reopens an id in a
 * new process: a session closed before it got the pause, then reopened,
 * must not pause itself on the old request. `current` = {pid, procStart,
 * startedAt} of the asking process (any field may be null).
 *   recorded pid      the same pid, and the same start time when both are known
 *   no recorded pid   ("all", an older CLI) not started after the request
 */
export function pauseBindingOk(request, sessionId, current) {
    const r = parsePauseRequest(request);
    if (!r)
        return false;
    const meta = r.sessions.find((s) => s.sessionId === sessionId);
    const cur = isObject(current) ? current : {};
    if (meta?.pid) {
        if (posInt(cur.pid) !== meta.pid)
            return false;
        const start = optStart(cur.procStart);
        return !(meta.procStart && start && start !== meta.procStart);
    }
    return !(isStamp(cur.startedAt) && cur.startedAt > r.at);
}

/** A PreToolUse payload the backstop may answer: the main session's own
 *  tool call. A subagent's carries agent_id, and a deny there would spend
 *  the one delivery on an agent that cannot pause its parent. */
export function pretoolEligible(payload) {
    if (!isObject(payload))
        return false;
    if (payload.agent_id !== undefined || payload.agentId !== undefined)
        return false;
    return isPauseSessionId(payload.session_id ?? payload.sessionId);
}

/**
 * A pause still owed a resume. `atMs` is when the session paused (its
 * checkpoint mtime or its verdict); owed while it is newer than the last
 * resume, younger than PAUSE_OWED_MAX_AGE_MS, and the session did no work
 * after it: a transcript written more than PAUSE_CONSUMED_GRACE_MS later is
 * the user carrying on in that session without a resume, and a checkpoint it
 * has left behind must never be replayed into a later reopen.
 */
export function pauseOwed({atMs, resumedAtMs = null, activityAtMs = null, nowMs}) {
    if (!isStamp(atMs))
        return false;
    if (isStamp(resumedAtMs) && atMs <= resumedAtMs)
        return false;
    if (isStamp(nowMs) && nowMs - atMs > PAUSE_OWED_MAX_AGE_MS)
        return false;
    return !(isStamp(activityAtMs) && activityAtMs - atMs > PAUSE_CONSUMED_GRACE_MS);
}

const TERMINAL = new Set(['safe', 'not-safe', 'resumed', 'gone', 'lost', 'expired', 'superseded']);

/**
 * Where one targeted session stands on `request`.
 *   safe / not-safe   its verdict for this request (wins over everything)
 *   resumed           a resume request was delivered
 *   superseded        a newer request replaced this one before it answered
 *   delivered         delivered, verdict not in yet (via says how)
 *   pending           live, not delivered, a waiter is armed
 *   unarmed           live, not delivered, no waiter (next tool call gets it)
 *   lost              delivered, then the session ended without a verdict
 *   gone              not live and never delivered
 *   expired           past the TTL: never delivered, or delivered and never
 *                     answered (via set)
 * @param {{request, sessionId, live: boolean, waiterLive: boolean,
 *   delivered, verdict, nowMs: number, superseded?: boolean}} input
 * @returns {{state: string, terminal: boolean, via: string|null,
 *   verdict: string|null, reason: string|null, checkpoint: string|null}}
 */
export function pauseRowState({request, sessionId, live, waiterLive, delivered, verdict, nowMs, superseded = false}) {
    const r = parsePauseRequest(request);
    const d = parsePauseDelivered(delivered);
    const v = parsePauseVerdict(verdict);
    const mine = (x) => Boolean(r && x && x.requestId === r.id);
    const row = (state, extra = {}) => ({
        state, terminal: TERMINAL.has(state), via: mine(d) ? d.via : null,
        verdict: null, reason: null, checkpoint: null, ...extra,
    });
    if (!r)
        return row('gone');
    if (r.kind === 'pause' && mine(v)) {
        return row(v.verdict === 'SAFE' ? 'safe' : 'not-safe',
            {verdict: v.verdict, reason: v.reason, checkpoint: v.checkpoint});
    }
    if (mine(d) && r.kind === 'resume')
        return row('resumed');
    // one delivery / verdict file per session: a newer request's records
    // overwrite this one's, so nothing more can be learned about it
    if (superseded)
        return row('superseded');
    const expired = nowMs - r.at > PAUSE_REQUEST_TTL_MS;
    if (mine(d)) {
        if (!live)
            return row('lost');
        return row(expired ? 'expired' : 'delivered');
    }
    if (expired || !isPauseSessionId(sessionId))
        return row('expired');
    if (!live)
        return row('gone');
    return row(waiterLive ? 'pending' : 'unarmed');
}

/**
 * Counts and the one-line label the CLI and the panels show: "5/7 safe"
 * for a pause, "3/3 resumed" for a resume. `done` = every row terminal;
 * `ok` = every row reached the good end (all safe / all resumed).
 */
export function pauseSummary(rows, kind) {
    const list = Array.isArray(rows) ? rows : [];
    const count = (...states) => list.filter((x) => states.includes(x?.state)).length;
    const total = list.length;
    const safe = count('safe');
    const notSafe = count('not-safe');
    const resumed = count('resumed');
    const delivered = count('safe', 'not-safe', 'resumed', 'delivered', 'lost');
    const pending = count('pending', 'unarmed', 'delivered');
    const done = list.every((x) => TERMINAL.has(x?.state));
    const good = kind === 'resume' ? resumed : safe;
    return {
        total, delivered, safe, notSafe, resumed, pending, done,
        ok: total > 0 && good === total,
        label: `${good}/${total} ${kind === 'resume' ? 'resumed' : 'safe'}`,
    };
}

/** Exit code of `claudectl session pause --wait`: 0 only when all are safe. */
export const pauseExitCode = (summary) => (summary?.ok ? 0 : 3);

/** A cwd's last component ('' for none or the root). */
const baseName = (cwd) => (typeof cwd === 'string' ? cwd.replace(/\/+$/, '').split('/').pop() ?? '' : '');

/** A row's name: the live session's, else the one the request recorded,
 *  else the cwd basename, else the id prefix. Control characters blanked. */
export function pauseRowName(sessionId, live = null, meta = null) {
    const name = cleanPauseText(live?.name) || cleanPauseText(meta?.name) ||
        cleanPauseText(baseName(live?.cwd || meta?.cwd || ''));
    return name || String(sessionId).slice(0, 8);
}

/**
 * The one row join every client shows. `live` = the running sessions
 * [{sessionId, name, cwd, pid}] in the order to list them; `records` =
 * {[sessionId]: {delivered, verdict, waiterLive}} for the targets; a
 * `currentId` (the request on disk now) other than the request's marks it
 * superseded; null / undefined does not.
 * @returns {{targets: object[], others: object[], summary: object}}
 *   targets  one row per target in request order ("all" = the live ids):
 *            sessionId, name, cwd, pid (null when not running) + the row state
 *   others   every other live session: sessionId, name, cwd, pid, state null
 *   summary  pauseSummary over the targets
 */
export function pauseRows({request, currentId, live = [], records = {}, nowMs}) {
    const r = parsePauseRequest(request);
    const running = (Array.isArray(live) ? live : []).filter((l) => isPauseSessionId(l?.sessionId));
    const byId = new Map(running.map((l) => [l.sessionId, l]));
    const meta = new Map((r?.sessions ?? []).map((s) => [s.sessionId, s]));
    const ids = !r ? [] : r.targets === 'all' ? [...byId.keys()] : r.targets;
    const superseded = Boolean(r && currentId != null && currentId !== r.id);
    const targets = ids.map((sessionId) => {
        const l = byId.get(sessionId) ?? null;
        const m = meta.get(sessionId) ?? null;
        const rec = isObject(records[sessionId]) ? records[sessionId] : {};
        const st = pauseRowState({
            request: r, sessionId, live: Boolean(l), waiterLive: Boolean(rec.waiterLive),
            delivered: rec.delivered ?? null, verdict: rec.verdict ?? null, nowMs, superseded,
        });
        return {
            sessionId, name: pauseRowName(sessionId, l, m), cwd: cleanPauseText(l?.cwd || m?.cwd) ?? '',
            pid: posInt(l?.pid), ...st,
        };
    });
    const targeted = new Set(ids);
    const others = running.filter((l) => !targeted.has(l.sessionId)).map((l) => ({
        sessionId: l.sessionId, name: pauseRowName(l.sessionId, l), cwd: cleanPauseText(l.cwd) ?? '',
        pid: posInt(l.pid), state: null,
    }));
    return {targets, others, summary: pauseSummary(targets, r?.kind ?? 'pause')};
}

/** English words for a row, shared by the terminal and the GNOME panel
 *  (the Swift port has its own). */
export function pauseRowLabel(row) {
    const via = row?.via ? ` (${row.via === 'rewake' ? 'woken' : 'next tool call'})` : '';
    switch (row?.state) {
        case 'safe': return 'SAFE';
        case 'not-safe': return `NOT SAFE${row.reason ? `: ${row.reason}` : ''}`;
        case 'resumed': return `resumed${via}`;
        case 'superseded': return 'superseded by a newer request before it answered';
        case 'delivered': return `delivered${via}, working through the protocol`;
        case 'pending': return 'waiter armed, delivering';
        case 'unarmed': return 'no waiter yet (started before the hook, or busy): gets it on its next tool call or turn';
        case 'lost': return `delivered${via}, then the session ended without a verdict`;
        case 'expired': return row.via ? `delivered${via}, no verdict within the hour` : 'request expired before delivery';
        default: return 'not running';
    }
}

/**
 * Is the session a pause waiter was armed for still its own? A crashed claude
 * orphans the waiter, and /clear moves the live session to a new id with a
 * waiter of its own; either way this one must leave.
 *
 *   no owner pid        nothing to check against: ours
 *   a registry entry    ours while it names our session id (and from now on
 *                       the registry is what decides)
 *   no entry, never     (early SessionStart, before claude wrote it) ours
 *   seen one            while the pid lives with the start time it had when
 *                       the waiter armed - a recycled pid has another
 *   no entry, seen one  the session ended: not ours
 *
 * @param {{sessionId: string, owner: number|null, registry: object|null,
 *   sawRegistry: boolean, alive?: boolean, armedStart?: string|null,
 *   start?: string|null}} input
 * @returns {{ours: boolean, sawRegistry: boolean}} sawRegistry to pass to
 *   the next check
 */
export function waiterOwnership({
    sessionId, owner = null, registry = null, sawRegistry = false, alive = false,
    armedStart = null, start = null,
}) {
    if (!owner)
        return {ours: true, sawRegistry};
    if (registry)
        return {ours: registry.session_id === sessionId, sawRegistry: true};
    return {ours: !sawRegistry && alive && (armedStart === null || start === armedStart), sawRegistry};
}

/** The PreToolUse hook's stdout: deny this one call, the text as reason. */
export function pauseDenyOutput(text) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: text,
        },
    };
}

/**
 * The hooks `./install.sh pause` merges into settings.json, for the base
 * command `node "<tree>/claude-code/pause-hook.js"`. SessionStart arms a
 * waiter in a new, resumed or cleared session; Stop re-arms one after every
 * turn (a second waiter for the same session exits at once on the lock).
 * @returns {{event: string, matcher?: string, hook: object}[]}
 */
export function pauseHookEntries(base) {
    const wait = {type: 'command', command: `${base} wait`, asyncRewake: true, timeout: PAUSE_HOOK_TIMEOUT_S};
    return [
        {event: 'SessionStart', hook: wait},
        {event: 'Stop', hook: {...wait}},
        {event: 'PreToolUse', matcher: '*', hook: {type: 'command', command: `${base} pretool`, timeout: PAUSE_PRETOOL_TIMEOUT_S}},
    ];
}
