// Pause / resume, the I/O half: the request file `claudectl session pause`
// writes, the per-session delivery records, verdicts, waiter locks and
// checkpoints under <state dir>/pause/ (paths.js pauseDir), all 0600 files
// in a 0700 dir written temp + rename (private-fs.js). The shapes, which
// request a session still owes, the row states and the row join are
// lib/pure/pause.js, the protocol texts lib/pure/pause-protocol.js; the live
// sessions come from registry.js (Claude Code's registry, checked against the
// process table), what each
// session left running from leftovers.js.
//
// Exactly-once delivery: the waiter (asyncRewake) and the PreToolUse
// backstop can race for the same session. Each claims under a short
// mutex (`<session>.claim`, excl-lock.js), re-reads the delivery record
// inside it, and only the one that writes the record delivers. A lock left
// by a crashed holder is taken over by an atomic rename, so two callers
// that both find it stale cannot both get in, and a holder only ever
// removes its own lock (owner token).
//
// `openPause(io)` binds it to one HOME / state dir / clock / pid probe
// (every one overridable), the shape openRegistry(io) takes.

import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  isPauseSessionId, parsePauseDelivered, parsePauseRequest, parsePauseVerdict, pauseBindingOk,
  pauseFileNames, pauseOwed, pauseRowLabel, pauseRows, PAUSE_OWED_MAX_AGE_MS, PAUSE_VERSION,
  shouldDeliver,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';
import {pauseDeliveryText} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause-protocol.js';
import {leftoversNote} from '../claude-usage-panel@fschmutz.github.io/lib/pure/leftovers.js';
import {formatClock} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pings.js';
import {shellQuote} from '../claude-usage-panel@fschmutz.github.io/lib/pure/sessions.js';
import {olderThan, releaseLock, tryLock} from './excl-lock.js';
import {nowOf, pauseDir, projectsDir, transcriptPath} from './paths.js';
import {openLeftovers} from './leftovers.js';
import {readJSON, writePrivate} from './private-fs.js';
import {pidAlive as defaultPidAlive, processIdentity} from './procs.js';
import {openRegistry} from './registry.js';

const CLAUDECTL_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claudectl.js');
/** A claim mutex older than this (real time, against its mtime) was left
 *  by a crashed hook. */
const CLAIM_STALE_MS = 10_000;
/** The waiter's revision, in its lock. Bumped whenever the waiter starts
 *  delivering something new (2: `claudectl session send` messages): a live
 *  waiter of an older revision still runs the code it loaded, so a new one
 *  asks it to leave (SIGTERM: it releases its lock and exits 0) and takes
 *  over, instead of leaving the session on the old code for up to a day. */
export const WAITER_REV = 2;
/** known.json keeps the name and cwd of this many sessions at most. */
const KNOWN_MAX = 256;

function newRequestId(nowMs) {
  return `${nowMs.toString(36)}-${randomBytes(3).toString('hex')}`;
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function openPause(io = {}) {
  const registry = openRegistry(io);
  const leftoverScan = openLeftovers(io);
  // whole milliseconds on disk: the Swift port reads `at` as an integer
  const now = () => Math.floor(nowOf(io));
  const pidAlive = (pid) => (io.pidAlive ?? defaultPidAlive)(pid);
  const dir = () => pauseDir(io);
  // the one place a session id becomes a path: never an unvalidated one
  const file = (sessionId, key) => {
    if (!isPauseSessionId(sessionId)) throw new Error(`bad session id ${JSON.stringify(sessionId)}`);
    return path.join(dir(), pauseFileNames(sessionId)[key]);
  };
  const requestFile = () => path.join(dir(), 'request.json');
  const knownFile = () => path.join(dir(), 'known.json');

  function ensureDir() {
    fs.mkdirSync(path.join(dir(), 'checkpoints'), {recursive: true, mode: 0o700});
  }

  const readRequest = () => parsePauseRequest(readJSON(requestFile()));
  const readDelivered = (sid) => parsePauseDelivered(readJSON(file(sid, 'delivered')));
  const readVerdict = (sid) => parsePauseVerdict(readJSON(file(sid, 'verdict')));

  // ── known.json: name + cwd of every session a request named ────────────
  // One current request supersedes the last, but `resume` must still find
  // and reopen what an older one paused.
  function readKnown() {
    const raw = readJSON(knownFile())?.sessions;
    const out = new Map();
    if (!raw || typeof raw !== 'object') return out;
    for (const [sid, s] of Object.entries(raw)) {
      if (isPauseSessionId(sid) && s && typeof s.cwd === 'string' && typeof s.at === 'number') {
        out.set(sid, {name: typeof s.name === 'string' ? s.name : '', cwd: s.cwd, at: s.at});
      }
    }
    return out;
  }

  function remember(sessions, at) {
    const known = readKnown();
    for (const s of sessions) if (s.cwd) known.set(s.sessionId, {name: s.name, cwd: s.cwd, at});
    const keep = [...known].filter(([, s]) => at - s.at <= PAUSE_OWED_MAX_AGE_MS)
      .sort((a, b) => b[1].at - a[1].at).slice(0, KNOWN_MAX);
    writePrivate(knownFile(), `${JSON.stringify({version: 1, sessions: Object.fromEntries(keep)}, null, 2)}\n`);
  }

  /** Write the one current request (a newer one supersedes it). `rows`:
   *  live-session rows {session_id, name, cwd, pid}, or 'all'. Each target
   *  is recorded with its pid and start time: only that process takes it. */
  function sendRequest({kind, rows, from = 'cli', origin = null}) {
    const at = now();
    const targets = rows === 'all' ? 'all' : rows.map((r) => r.session_id);
    const sessions = rows === 'all' ? [] : rows.map((r) => ({
      sessionId: r.session_id, name: r.name, cwd: r.cwd, pid: r.pid ?? null,
      procStart: r.pid ? registry.procStart(r.pid) : null,
    }));
    const request = parsePauseRequest({version: PAUSE_VERSION, id: newRequestId(at), kind, at, targets, from, sessions, origin});
    if (!request) throw new Error('nothing to send: no valid session id among the targets');
    ensureDir();
    writePrivate(requestFile(), `${JSON.stringify(request, null, 2)}\n`);
    remember(request.sessions, at);
    return request;
  }

  const checkpointPath = (sid) => file(sid, 'checkpoint');
  const mtime = (p) => statOrNull(p)?.mtimeMs ?? null;

  /** When the session's transcript was last written: the last thing it
   *  did. `cwd` names it directly; without it every project dir is tried. */
  function activityAt(sid, cwd = null) {
    const projects = projectsDir(io);
    if (cwd) return mtime(transcriptPath(projects, cwd, sid));
    let dirs;
    try {
      dirs = fs.readdirSync(projects);
    } catch {
      return null;
    }
    let newest = null;
    for (const d of dirs) {
      const t = mtime(path.join(projects, d, `${sid}.jsonl`));
      if (t !== null && (newest === null || t > newest)) newest = t;
    }
    return newest;
  }

  function resumedAt(sid) {
    const r = readJSON(file(sid, 'resumed'));
    return typeof r?.at === 'number' ? r.at : null;
  }

  const owed = (sid, atMs, cwd) => pauseOwed({
    atMs, resumedAtMs: resumedAt(sid), activityAtMs: atMs === null ? null : activityAt(sid, cwd), nowMs: now(),
  });

  /** The checkpoint path while that pause is still owed a resume (pure
   *  pauseOwed: newer than the last resume, no work done after it, not too
   *  old), else null. */
  function pendingCheckpoint(sid, cwd = null) {
    if (!isPauseSessionId(sid)) return null;
    const p = checkpointPath(sid);
    return owed(sid, mtime(p), cwd) ? p : null;
  }

  /** The session paused and was not resumed since: a pending checkpoint,
   *  or a verdict still owed a resume. */
  function isPaused(sid, cwd = null) {
    if (!isPauseSessionId(sid)) return false;
    return Boolean(pendingCheckpoint(sid, cwd)) || owed(sid, readVerdict(sid)?.at ?? null, cwd);
  }

  /** When the session paused: its verdict or its checkpoint, the newer. */
  function pausedAt(sid) {
    if (!isPauseSessionId(sid)) return null;
    const stamps = [readVerdict(sid)?.at, mtime(checkpointPath(sid))].filter((x) => typeof x === 'number');
    return stamps.length ? Math.max(...stamps) : null;
  }

  /** Every session still owed a resume, whichever request paused it: the
   *  verdicts and checkpoints on disk, not the last request. */
  function pausedSessions() {
    const ids = new Set();
    const scan = (sub, suffix) => {
      try {
        for (const f of fs.readdirSync(path.join(dir(), sub))) {
          if (f.endsWith(suffix)) ids.add(f.slice(0, -suffix.length));
        }
      } catch {
        // no store yet
      }
    };
    scan('.', '.verdict.json');
    scan('checkpoints', '.md');
    const known = readKnown();
    return [...ids].filter((sid) => isPaused(sid, known.get(sid)?.cwd ?? null));
  }

  function markResumed(sid) {
    if (!isPauseSessionId(sid)) return;
    ensureDir();
    writePrivate(file(sid, 'resumed'), `${JSON.stringify({at: now()})}\n`);
  }

  // A short exclusive mutex (excl-lock.js) holding an owner token; a stale
  // one (crashed holder) is taken over atomically, and only the holder
  // removes it. Busy = false: the other hook is delivering.
  function withClaim(sid, fn) {
    ensureDir();
    const lock = tryLock(path.join(dir(), `${sid}.claim`), { // sid validated by claim()
      body: (token) => `${io.pid ?? process.pid}:${token}\n`, stale: olderThan(CLAIM_STALE_MS),
    });
    if (!lock) return false;
    try {
      return fn();
    } finally {
      releaseLock(lock);
    }
  }

  /** The asking process, for pauseBindingOk: `pid` when the hook knows it
   *  (CLAUDE_PID), else the live session holding the id. */
  function currentProcess(sid, pid) {
    if (Number.isInteger(pid) && pid > 0) {
      return {pid, procStart: registry.procStart(pid), startedAt: registry.sessionOfPid(pid)?.startedAt ?? null};
    }
    const row = registry.liveSessions().find((r) => r.session_id === sid);
    return row ? {pid: row.pid, procStart: registry.procStart(row.pid), startedAt: row.startedAt ?? null} : null;
  }

  /** Claim the delivery of `request` to `sid` by `via`. True for exactly
   *  one caller per (session, request); false when it is not owed, or the
   *  asking process is not the one the request was sent to. */
  function claim(sid, request, via, {pid = null} = {}) {
    if (!isPauseSessionId(sid) || !shouldDeliver(request, sid, readDelivered(sid), now())) return false;
    if (!pauseBindingOk(request, sid, currentProcess(sid, pid))) return false;
    return withClaim(sid, () => {
      // re-read inside the mutex: the other hook may have just delivered
      if (!shouldDeliver(request, sid, readDelivered(sid), now())) return false;
      writePrivate(file(sid, 'delivered'), `${JSON.stringify({requestId: request.id, at: now(), via})}\n`);
      if (request.kind === 'resume') markResumed(sid);
      return true;
    });
  }

  /** The command a session runs to report its verdict (up to --verdict). */
  function reportCommand(sid, requestId) {
    const node = io.execPath ?? process.execPath;
    return `${shellQuote(node)} ${shellQuote(io.claudectl ?? CLAUDECTL_JS)} session report ` +
      `--session ${sid} --request ${requestId}`;
  }

  /** The command a session runs to list what it left running. */
  function leftoversCommand(sid) {
    const node = io.execPath ?? process.execPath;
    return `${shellQuote(node)} ${shellQuote(io.claudectl ?? CLAUDECTL_JS)} session leftovers --session ${sid}`;
  }

  /** What every session left running (pure pauseLeftovers over the live
   *  process table): {ok, found, error}. A scan that fails is ok: false,
   *  never an empty list - the double check fails closed. */
  function leftovers() {
    try {
      return {ok: true, found: leftoverScan.scan(registry.liveSessions()), error: null};
    } catch (e) {
      return {ok: false, found: [], error: e?.message ?? String(e)};
    }
  }

  /** What `sid` receives for `request`, delivered by `via`. A pause names
   *  the jobs claudectl already sees running for it. */
  function deliveryText(sid, request, via) {
    const checkpoint = checkpointPath(sid);
    // a failed scan names nothing here; step 4b runs it again and fails closed
    const found = request.kind === 'pause' ? leftovers().found.find((s) => s.sessionId === sid)?.jobs ?? [] : [];
    return pauseDeliveryText({
      request, via, sentAt: formatClock(request.at), checkpoint,
      checkpointExists: fs.existsSync(checkpoint), leftovers: leftoversCommand(sid), leftoversNote: leftoversNote(found),
      report: reportCommand(sid, request.id), verdictFile: file(sid, 'verdict'), reasonFile: file(sid, 'reason'),
    });
  }

  /** Record a verdict (claudectl session report). Throws on a bad field.
   *  The record is the parsed one: control characters blanked, reason cut. */
  function report({sessionId, requestId, verdict, reason = null, checkpoint = null}) {
    if (!isPauseSessionId(sessionId)) throw new Error(`bad session id ${sessionId}`);
    const record = parsePauseVerdict({requestId, at: now(), verdict, reason, checkpoint});
    if (!record) throw new Error('report needs --request ID and --verdict SAFE|NOT_SAFE');
    ensureDir();
    writePrivate(file(sessionId, 'verdict'), `${JSON.stringify(record)}\n`);
    for (const kind of ['checkpoint', 'reason']) tightenModelFile(file(sessionId, kind));
    return record;
  }

  /** The checkpoint and reason files are written by the model's own Write
   *  tool, under its umask (0664 seen live): bring them to 0600 like every
   *  other store file. A regular file only - lstat, so a symlink is never
   *  followed to chmod its target. Absent = nothing to do. */
  function tightenModelFile(p) {
    const st = (() => { try { return fs.lstatSync(p); } catch { return null; } })();
    if (st?.isFile() && (st.mode & 0o777) !== 0o600) fs.chmodSync(p, 0o600);
  }

  // ── the waiter lock: at most one live waiter per session ───────────────
  function lockLive(lock) {
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || !pidAlive(lock.pid)) return false;
    // a recycled pid: the kernel start time moved (Linux; elsewhere the pid)
    if (lock.procStart && (io.platform ?? process.platform) === 'linux') {
      return registry.procStart(lock.pid) === lock.procStart;
    }
    return true;
  }

  /** The lock's pid is still the very process that wrote it: the Linux
   *  start time, else the `ps` identity. Only then is it ever signalled. */
  function provenSame(held) {
    if ((io.platform ?? process.platform) === 'linux') {
      return Boolean(held.procStart) && registry.procStart(held.pid) === held.procStart;
    }
    return Boolean(held.identity) && processIdentity({exec: execFileSync, ...io}, held.pid) === held.identity;
  }

  function waiterLive(sid) {
    return isPauseSessionId(sid) && lockLive(readJSON(file(sid, 'waiter')));
  }

  /** Take the waiter lock for `sid` as `pid`: a release function, or null
   *  when another live waiter holds it. The body is the JSON every reader
   *  (waiterLive, the GNOME panel) parses, with the owner token in it, so
   *  the release of a waiter that was taken over never removes its
   *  successor's lock. */
  function acquireWaiter(sid, pid = io.pid ?? process.pid) {
    if (!isPauseSessionId(sid)) return null;
    ensureDir();
    const procStart = registry.procStart(pid);
    const identity = processIdentity({exec: execFileSync, ...io}, pid);
    const lock = tryLock(file(sid, 'waiter'), {
      body: (token) => `${JSON.stringify({pid, at: now(), procStart, identity, rev: WAITER_REV, token})}\n`,
      stale: (snap) => {
        const held = parseJSON(snap.text);
        if (!lockLive(held)) return true;
        if ((held.rev ?? 1) >= WAITER_REV || !provenSame(held)) return false;
        try {
          (io.kill ?? process.kill)(held.pid, 'SIGTERM');
        } catch {
          // gone already
        }
        return true;
      },
    });
    return lock ? () => { releaseLock(lock); } : null;
  }

  /** The target rows of `request` (default: the current one) and the
   *  summary - what `pause --wait`, `pause-status` and the macOS panel show.
   *  The join is pure pauseRows, the one GNOME runs too. A request that is
   *  no longer the current one is marked superseded. */
  function status(request = readRequest()) {
    if (!request) return {request: null, rows: [], summary: pauseRows({request: null}).summary};
    const live = registry.liveSessions().map((r) => ({sessionId: r.session_id, name: r.name, cwd: r.cwd, pid: r.pid}));
    const ids = request.targets === 'all' ? live.map((l) => l.sessionId).filter(isPauseSessionId) : request.targets;
    const records = Object.fromEntries(ids.map((sid) => [sid, {
      delivered: readDelivered(sid), verdict: readVerdict(sid), waiterLive: waiterLive(sid),
    }]));
    const {targets, summary} = pauseRows({request, currentId: readRequest()?.id, live, records, nowMs: now()});
    return {request, rows: targets.map((r) => ({...r, label: pauseRowLabel(r)})), summary};
  }

  return {
    dir, readRequest, sendRequest, checkpointPath, pendingCheckpoint, isPaused, pausedAt, pausedSessions,
    readKnown, markResumed, claim, deliveryText, report, waiterLive, acquireWaiter, status, pidAlive, registry,
    leftovers, leftoversCommand,
  };
}
