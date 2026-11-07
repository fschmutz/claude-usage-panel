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
// the CLI and the panels show, and the one copy of the protocol texts.
//
// Twin of ClaudeUsageCore/Pause.swift for what the menu-bar app reads: the
// request shape, the row states, the summary, the row names and the text
// cleaning (tests/fixtures/pause.json pins both). Node-only, no port to
// mirror: the delivery side (shouldDeliver, pauseBindingOk, pretoolEligible,
// pauseOwed, the delivery / verdict records, pauseRows, pauseLeftovers, the
// texts, the hook JSON). The app never delivers and never joins records: it reads
// `claudectl session pause-status --json`, which pauseRows already built.

import {shellQuote} from './sessions.js';

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

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
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

// ── Leftovers: what a session left running, seen from outside ───────────
// Every process Claude Code starts for a session carries the session's id
// in CLAUDE_CODE_SESSION_ID: its hooks, its MCP servers and every Bash tool
// command, which the harness runs as `bash -c source <config>/shell-
// snapshots/snapshot-<...>.sh ...`. A status label inside the session
// ("completed") is not proof; the process table is.
const JOB_SHELL_RE = /\/shell-snapshots\/snapshot-[^/\s]*\.sh(?:\s|$)/;
const LEFTOVER_CMD_MAX = 160;

/** What a Bash tool command runs: the `eval '...'` the harness wraps it in,
 *  unquoted; any other command line as is. */
export function jobCommand(cmd) {
    const text = String(cmd ?? '');
    if (!JOB_SHELL_RE.test(text))
        return text;
    const at = text.indexOf(" eval '");
    if (at < 0)
        return text;
    const body = text.slice(at + 7).replaceAll(`'"'"'`, "'").replaceAll(`'\\''`, "'");
    const end = body.lastIndexOf("' ");
    return `$ ${end > 0 ? body.slice(0, end) : body}`;
}

/**
 * The jobs each session left running, from one process table.
 *   procs  every process of the user: {pid, ppid, cmd, sessionId} where
 *          sessionId is the CLAUDE_CODE_SESSION_ID it carries (null: none)
 *   live   {sessionId: pid of its running claude}; absent = not running
 *   skip   pids never reported (claudectl itself and its ancestors)
 * A process of session S is a job when S is not running (all it left is
 * orphaned), when its parent chain no longer reaches S's claude (a shell
 * or a hook above it died: orphaned), or when it, or an ancestor below
 * claude, is a Bash tool command. Hook waiters and MCP servers, children
 * of a live claude through no Bash tool command, are the harness's own.
 * @returns {Array<{sessionId, running: boolean, jobs: Array<{pid, ppid, cmd, orphan}>}>}
 *          sessions with at least one job, by session id; jobs by pid
 */
export function pauseLeftovers({procs = [], live = {}, skip = []}) {
    const byPid = new Map();
    for (const p of procs) if (posInt(p?.pid)) byPid.set(p.pid, p);
    const skipSet = new Set(skip);
    const found = new Map();
    for (const p of byPid.values()) {
        const sid = p.sessionId;
        if (!isPauseSessionId(sid) || skipSet.has(p.pid))
            continue;
        const claude = posInt(live[sid]);
        if (p.pid === claude)
            continue;
        let job = claude === null;
        let orphan = claude === null;
        if (!job) {
            let reached = false;
            const seen = new Set();
            for (let q = p; q && !seen.has(q.pid); q = byPid.get(q.ppid)) {
                seen.add(q.pid);
                if (JOB_SHELL_RE.test(q.cmd ?? ''))
                    job = true;
                if (q.ppid === claude) {
                    reached = true;
                    break;
                }
            }
            if (!reached)
                job = orphan = true;
        }
        if (!job)
            continue;
        if (!found.has(sid))
            found.set(sid, {sessionId: sid, running: claude !== null, jobs: []});
        found.get(sid).jobs.push({
            pid: p.pid, ppid: posInt(p.ppid), orphan,
            cmd: cleanPauseText(jobCommand(p.cmd), LEFTOVER_CMD_MAX) ?? '',
        });
    }
    return [...found.values()]
        .map((s) => ({...s, jobs: s.jobs.sort((a, b) => a.pid - b.pid)}))
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}

/** The jobs no other job started (what to stop: their children go with
 *  them), each with how many jobs run under it. */
export function leftoverRoots(jobs) {
    const list = jobs ?? [];
    const byPid = new Map(list.map((j) => [j.pid, j]));
    const rootOf = (j) => {
        const seen = new Set();
        while (byPid.has(j.ppid) && !seen.has(j.pid)) {
            seen.add(j.pid);
            j = byPid.get(j.ppid);
        }
        return j;
    };
    const counts = new Map();
    for (const j of list) {
        const r = rootOf(j);
        counts.set(r.pid, (counts.get(r.pid) ?? 0) + (r === j ? 0 : 1));
    }
    return list.filter((j) => counts.has(j.pid)).map((j) => ({...j, children: counts.get(j.pid)}));
}

/** One line per root job: `pid 4242 (orphaned, +3 under it): sleep 600`. */
export function leftoverLines(jobs, indent = '  ') {
    return leftoverRoots(jobs).map((j) => {
        const tags = [j.orphan ? 'orphaned' : '', j.children ? `+${j.children} under it` : ''].filter(Boolean);
        return `${indent}pid ${j.pid}${tags.length ? ` (${tags.join(', ')})` : ''}: ${j.cmd}`;
    }).join('\n');
}

function leftoversFound(found) {
    if (!found?.length)
        return '';
    const n = leftoverRoots(found).length;
    return `claudectl already sees ${n} job${n === 1 ? '' : 's'} of this ` +
        `session still running (step 4b lists them again):\n${leftoverLines(found)}\n` +
        'Each one goes through steps 1 to 4: stop it, or name it with a reason.\n\n';
}

// The protocol texts. The source of truth is this file; PAUSE_PROTOCOL steps
// 3c, 4b and 5 name the checkpoint path, the leftovers command and the
// report command of the request.
function pauseProtocol({checkpoint, report, leftovers, found, verdictFile, reasonFile, requestId}) {
    const cp = shellQuote(checkpoint);
    return `PAUSE PROTOCOL
${leftoversFound(found)}Run it before anything else. The protocol is the same for a 5-minute break and
for a shutdown: everything stops, and everything needed to resume is written to disk.
You may not say it is safe to close until the gate in step 4 passes.

Scope: only the jobs this session launched and the repos it touched. The user may send
the same pause to several sessions in parallel. Never stop, stash, reset or edit
anything owned by another session.

1. INVENTORY - be over-inclusive. A job you list that turns out to be already dead
   costs nothing. A job you miss is the failure this protocol exists to prevent.
   Go through your own history and list every launch that has no terminal
   completed/failed/killed/stopped notification after it:
   a. Harness jobs: background shell commands, monitors, subagents (background,
      forked, named teammates), workflow runs and their child agents, /loop and
      scheduled wake-ups, session cron jobs, git worktrees you entered or created,
      browser-automation tabs and recordings, requests sent to other sessions that
      are still awaiting a reply.
   b. Processes you started: dev servers, watchers, test runners, headless browsers,
      containers, ssh / SSM / port-forward / tunnel sessions, database sessions,
      especially any with an open transaction.
   c. External work in flight: CI runs, deploys, cloud builds, migrations. Do NOT
      cancel these. Record the id and how to check the result.
   d. Persistent by design: cloud routines and remote triggers. Leave them running
      and record them.
   e. Repo state: rebase / merge / cherry-pick / bisect in progress, staged or
      unstaged edits, unpushed commits, stashes you created, lock files you hold.
   f. Things that expire while away: tokens, leases, approvals, OTP or sudo
      windows, pending scheduled actions.

2. STOP - in this order:
   a. Every agent and workflow child: tell it to commit only work that passes the
      repo's gates, write a stop report (done / half-done files / next step), and
      stop. Wait for each report, up to ~3 min.
   b. Then force-stop every id from 1a that is not yet terminal, the ones that
      answered included. If the stop call says "not found", the job is already
      dead: record it as such.
   c. For each workflow, record its run id, the agent or stage it was cut in (its
      writes may be half-applied) and the exact resume call. Copy its script next
      to the checkpoint (same directory, <run id>.js): the stored script sits under
      the project dir of the cwd it was launched from, which a reopened session
      may not be allowed to read.
   d. Kill the processes from 1b. Roll back open DB transactions: never leave one
      open, never commit one just to pause.
   e. Cancel pending wake-ups, loops and session crons, and record how to re-create
      each one.

3. SAVE - nothing that matters may live only in your context, in /tmp or in a
   scratch dir: those die with the session or a reboot.
   a. Leave half-done edits in the working tree. No stash, no reset, no revert.
      Commit only what passes the gates.
   b. Move work out of /tmp and the scratch dir to a durable directory, then
      re-point every path that names the old place (scripts, constants, workflow
      args) to the new one. A copy that scripts do not use is not saved: the
      resumed session must never re-create /tmp paths or symlinks.
   c. Overwrite ONE checkpoint file, at this fixed path (create its directory if
      needed); the next session reads it first:
      ${checkpoint}
      It must be enough to resume with no other context:
      - goal (one line) and definition of done
      - done: with commit SHAs
      - stopped mid: each half-done task split into done part + remaining part,
        with the files involved
      - every job from step 1: kind, id, state (stopped / already dead / external /
        persistent), resume or re-arm command
      - repo state per repo: branch, HEAD, ahead/behind, dirty files, op in progress
      - pending user actions and open questions, with options and a recommendation
      - next steps in order, each with its first command
      - tried and failed, and why
      - the smoke check to run first on resume
      - what expires, and when

4. GATE - verify; do not assume:
   a. Re-list harness jobs (task list, cron list, agent list) and force-stop every
      subagent, workflow and background task still listed, one shown as completed
      or dead included: a status label is not proof. "Not found" means it is gone.
   b. Run this; it lists every process still carrying this session's id that is
      not the harness's own (Bash jobs, their children, anything orphaned):
      ${leftovers}
      It must list nothing. Kill what it lists (they are yours), then run it again.
   c. Re-check what it cannot see: containers you started, ports you opened.
      Each must be gone.
   d. Read the checkpoint back. It must exist and contain every job id from step 1.
   e. Anything still alive must be either stopped now or named with a reason
      (external / persistent by design).

5. REPLY - first record the verdict, so the user's panel and claudectl see it:
      ${report} --verdict SAFE --checkpoint ${cp}
   or, when something is still running: write what is still running and why to
   ${reasonFile} with your file-writing tool (no shell quoting to get wrong), then:
      ${report} --verdict NOT_SAFE --checkpoint ${cp} --reason-file ${shellQuote(reasonFile)}
   If that command cannot run, write this JSON to ${verdictFile} instead
   (mode 0600; at = epoch milliseconds now; reason only for NOT_SAFE):
      {"requestId": "${requestId}", "at": <ms>, "verdict": "SAFE" or "NOT_SAFE", "reason": "...", "checkpoint": "${checkpoint}"}
   Then line 1 of your reply is exactly one of:
   SAFE TO CLOSE
   NOT SAFE: <what is still running and why>
   Then one short table: item | state | on return. Then the checkpoint path. Nothing else.`;
}

/** The approval rule a resumed session keeps. One copy: claude-code/tabs.js
 *  resumePrompt ends with it, and so does a delivered resume request. */
export const PAUSE_RESUME_GUARD = 'Same rules as before: nothing destructive, outward-facing or still ' +
    'waiting on the user\'s answer without asking the user first.';

function resumeProtocol(checkpoint, exists, leftovers = null) {
    const where = exists
        ? `Your checkpoint: ${checkpoint}`
        : `No checkpoint was found at ${checkpoint}: re-read the end of this conversation instead.`;
    const sweep = leftovers
        ? `\n   Then run: ${leftovers}\n` +
          '   Whatever it lists outlived the pause: stop it, unless the checkpoint names it as\n' +
          '   persistent by design; then adopt it instead of starting a second copy.'
        : '';
    return `RESUME PROTOCOL
${where}
1. Read the checkpoint before anything else. Background shells, monitors, agents and
   workflows do NOT survive a restart: treat each one as dead unless a fresh check
   proves otherwise.${sweep}
2. For any action that was cut off mid-flight, check whether it took effect before
   redoing it (commit landed? file written? deploy started?).
3. Run the recorded smoke check on the dirty trees before any new work.
4. Re-arm: resume each workflow from its run id (resumeFromRunId keeps every
   finished agent's result). When its scriptPath is refused, pass the saved script
   inline (\`script\`) with the same run id and the durable paths as args. Start a
   fresh run only when the resume itself fails, and say why. Restart the needed
   monitors and watchers, re-check the external runs.
5. Continue the next steps without asking again. Report only what needs the user.`;
}

/** The RESUME PROTOCOL block a reopened session gets (claude-code/tabs.js
 *  resumePrompt) when it has a pending checkpoint; `leftovers` is the
 *  command that lists what the session left running, when known. */
export function resumeProtocolText(checkpoint, leftovers = null) {
    return resumeProtocol(checkpoint, true, leftovers);
}

const ORIGIN = {cli: 'typed `claudectl session pause`', gnome: 'clicked Pause in the GNOME panel', macos: 'clicked Pause in the menu-bar app'};

/** Who sent it, as far as claudectl can tell. The store is writable by any
 *  process of the user, so this is a claim, never proof: a request sent from
 *  inside a Claude Code session says so and asks for the user's go-ahead. */
function pauseHeader(r, sentAt, held) {
    const tag = `[claudectl ${r.kind} request ${r.id}]`;
    if (r.from === 'session') {
        const who = r.origin ? `Claude Code session ${r.origin.slice(0, 8)}` : 'another Claude Code session';
        const ask = r.kind === 'pause'
            ? 'Before stopping anything, ask the user whether they want this session paused; run the protocol below only if they say so.'
            : 'Before resuming any work, ask the user whether they want it resumed; run the protocol below only if they say so.';
        return `${tag} Sent at ${sentAt} from inside ${who}, not typed by the user. ${ask}${held}`;
    }
    const origin = r.kind === 'resume'
        ? ORIGIN[r.from].replace('pause', 'resume').replace('Pause', 'Resume')
        : ORIGIN[r.from];
    return `${tag} The user ${origin} at ${sentAt}; the claudectl pause hook installed with ` +
        `./install.sh pause delivered it.${held} ` +
        (r.kind === 'pause' ? 'Run the protocol below now, before anything else.' : 'Run the protocol below now.');
}

/**
 * What a session receives: who sent it (pauseHeader), then the protocol;
 * a resume ends with PAUSE_RESUME_GUARD. `via` = 'pretooluse' adds that the
 * held-back tool call was deliberate. Fields: request, sentAt ("14:05"),
 * checkpoint (absolute path), checkpointExists, report (the report command
 * up to --verdict), leftovers (the command listing what the session left
 * running) and found (what it listed at delivery: pauseLeftovers jobs),
 * verdictFile, reasonFile (where a NOT_SAFE reason is written, so it never
 * passes through shell quoting).
 */
export function pauseDeliveryText({request, sentAt, checkpoint, checkpointExists = false, report, leftovers, found = [], verdictFile, reasonFile, via}) {
    const r = parsePauseRequest(request);
    if (!r)
        return '';
    const held = via === 'pretooluse'
        ? ' The tool call you just tried was held back on purpose to hand you this; it is not an error.'
        : '';
    const body = r.kind === 'pause'
        ? pauseProtocol({checkpoint, report, leftovers, found, verdictFile, reasonFile, requestId: r.id})
        : `${resumeProtocol(checkpoint, checkpointExists, leftovers)}\n${PAUSE_RESUME_GUARD}`;
    return `${pauseHeader(r, sentAt, held)}\n\n${body}\n`;
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
