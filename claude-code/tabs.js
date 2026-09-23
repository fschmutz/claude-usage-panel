// `claudectl session`, the I/O half: snapshot every running Claude Code session (its
// name, working directory and session id) and reopen a snapshot later as
// tabs of ONE terminal window - each tab in its own directory, resuming its
// own session. The use case is a reboot, a crashed desktop session or a
// terminal closed by mistake: nine sessions across nine repos come back with
// one command instead of nine `cd … && claude --resume …`.
//
// The truth source is Claude Code's own live-session registry,
// <claude dir>/sessions/<pid>.json, which carries the CURRENT session id (it
// moves on /clear, so the `--resume` id a process was started with can be
// stale), the cwd and the name. A registry file outlives a crash, so every
// entry is checked against the process table: on Linux the kernel start time
// in /proc/<pid>/stat must equal the entry's `procStart`, which also rejects a
// pid recycled by an unrelated process; elsewhere the pid must be alive and
// running a `claude` command line.
//
// Snapshots live one JSON file per label under <state dir>/tabs/. `autosave`
// is what the scheduled job runs: it writes an `auto-…` snapshot only when the
// set of sessions changed since the last one, and keeps the newest N autos so
// the store stays bounded. Manual saves are never pruned by autosave.
//
// Which terminal opens them, and how it gets a tab per session, is
// terminals.js: the one the panels are configured to use.
//
// `openTabs(io)` binds all of it to one home dir, platform, clock, exec,
// spawn and /proc root (every one overridable, read at call time), the same
// shape openStore(io) takes, so the tests run against a throwaway HOME and a
// fake /proc.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn as nodeSpawn} from 'node:child_process';

import {projectsDir, sessionRegistryDir, tabsDir} from './paths.js';
import {TMUX_SESSION, launchSteps, onPath, resolveTerminal} from './terminals.js';
import {formatClock, resetHint} from './stamps.js';

export const AUTO_PREFIX = 'auto-';
/** Autosaves kept by default: 48 half-hourly runs = one day of history. */
export const AUTO_KEEP = 48;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const isValidLabel = (label) => typeof label === 'string' && LABEL_RE.test(label);

/** Claude Code's transcript for a session: projects/<cwd, every non
 *  alphanumeric turned into '-'>/<id>.jsonl. */
export function transcriptPath(projects, cwd, sessionId) {
  return path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/** Two session lists describe the same set (order-insensitive). */
export function sameSessions(a, b) {
  const key = (rows) => rows.map((r) => `${r.session_id}\t${r.cwd}\t${r.name}`).sort().join('\n');
  return key(a) === key(b);
}

/**
 * The first message a restored session gets. A restart kills everything
 * that lived only in the old process - background shells, Monitors, /loop
 * and scheduled wakeups, the watch on a push or a CI run - and the
 * conversation does not know it. So the prompt says so, has the session
 * re-read where it stopped and re-check what moved meanwhile before it
 * carries on, and restates that approvals do not carry over a restart.
 */
export function resumePrompt({label, savedAt, nowMs}) {
  const ago = resetHint(nowMs, savedAt) || 'moments';
  return `Resumed by claudectl after a restart: this session was saved in snapshot ${label} ` +
    `at ${formatClock(savedAt)} (${ago} ago) and reopened at ${formatClock(nowMs)}. ` +
    'Everything that lived only in the old process is gone: background shells, Monitors, ' +
    '/loop and scheduled wakeups, watchers on a push or a CI run.\n\n' +
    '1. Re-read the end of this conversation: my last request, what you finished, what was ' +
    'still running or waiting.\n' +
    '2. Check what moved while you were down: git status and recent commits here, and the ' +
    'push, CI run, build or job you were waiting on, if any.\n' +
    '3. Reply with a short status (done / interrupted / next), re-arm what you still need to ' +
    'watch, then carry on with the interrupted work.\n\n' +
    'Same rules as before: nothing destructive, outward-facing or still waiting on my answer ' +
    'without asking me first.';
}

/** A local-time label: 2026-09-23_192140. */
export function stampLabel(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Bind the tab operations to one environment. io (all optional):
 * homedir, env, platform, nowMs, pid, procDir, exec (execFileSync), spawn.
 */
export function openTabs(io = {}) {
  const platform = () => io.platform ?? process.platform;
  const procDir = () => io.procDir ?? '/proc';
  const exec = (...a) => (io.exec ?? execFileSync)(...a);
  const now = () => (io.nowMs ? io.nowMs() : Date.now());
  const store = () => tabsDir(io);

  // Kernel start time (field 22) of a pid; comm (field 2) may hold spaces
  // and parens, so split after the LAST ')'.
  function procStart(pid) {
    try {
      const stat = fs.readFileSync(path.join(procDir(), String(pid), 'stat'), 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null;
    } catch {
      return null;
    }
  }

  function isAlive(entry) {
    if (platform() === 'linux') return procStart(entry.pid) === String(entry.procStart);
    try {
      const cmd = exec('ps', ['-o', 'command=', '-p', String(entry.pid)],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      return /(^|\/)claude(\s|$)/.test(cmd.trim());
    } catch {
      return false;
    }
  }

  /** Running interactive sessions, oldest first. */
  function liveSessions() {
    let files;
    try {
      files = fs.readdirSync(sessionRegistryDir(io)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const rows = [];
    for (const f of files) {
      const d = readJSON(path.join(sessionRegistryDir(io), f));
      if (!d || d.kind !== 'interactive' || !d.pid || !d.sessionId || !d.cwd) continue;
      if (!isAlive(d)) continue;
      rows.push({
        name: d.name || path.basename(d.cwd),
        cwd: d.cwd,
        session_id: d.sessionId,
        pid: d.pid,
        status: d.status ?? '',
        startedAt: d.startedAt ?? 0,
      });
    }
    return rows.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The live session this process runs under (walks the parent chain), or
   *  null - lets `list` mark it and `save --exclude-self` drop it. */
  function selfPid(live) {
    const pids = new Set(live.map((r) => r.pid));
    let pid = io.pid ?? process.pid;
    for (let hops = 0; pid > 1 && hops < 64; hops++) {
      if (pids.has(pid)) return pid;
      try {
        const status = fs.readFileSync(path.join(procDir(), String(pid), 'status'), 'utf8');
        pid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Why a stored row cannot be resumed here, or null when it can. */
  function blocker(row) {
    if (!fs.existsSync(row.cwd)) return `cwd gone: ${row.cwd}`;
    if (!fs.existsSync(transcriptPath(projectsDir(io), row.cwd, row.session_id))) return 'transcript missing';
    return null;
  }

  /** Snapshots, newest first: {label, file, savedAt, sessions}. */
  function snapshots() {
    let files;
    try {
      files = fs.readdirSync(store()).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => {
        const d = readJSON(path.join(store(), f));
        if (!d || !Array.isArray(d.sessions)) return null;
        return {label: f.slice(0, -5), file: path.join(store(), f), savedAt: d.savedAt ?? 0, sessions: d.sessions};
      })
      .filter(Boolean)
      .sort((a, b) => b.savedAt - a.savedAt || (a.label === b.label ? 0 : (a.label < b.label ? 1 : -1)));
  }

  /** A label, a unique label prefix, or a 1-based index into snapshots();
   *  no ref = the newest. */
  function resolve(ref) {
    const all = snapshots();
    if (!all.length) throw new Error('no snapshots - `claudectl session save` stores the running sessions');
    if (ref === undefined || ref === null) return all[0];
    if (/^\d+$/.test(ref) && Number(ref) >= 1 && Number(ref) <= all.length) return all[Number(ref) - 1];
    const exact = all.filter((s) => s.label === ref);
    const hits = exact.length ? exact : all.filter((s) => s.label.startsWith(ref));
    if (hits.length !== 1) throw new Error(`snapshot ${ref}: ${hits.length ? 'ambiguous' : 'not found'}`);
    return hits[0];
  }

  function write(label, sessions) {
    if (!isValidLabel(label)) throw new Error(`bad label ${label} (letters, digits, . _ -)`);
    const snap = {
      version: 1,
      savedAt: now(),
      sessions: sessions.map(({name, cwd, session_id}) => ({name, cwd, session_id})),
    };
    const file = path.join(store(), `${label}.json`);
    fs.mkdirSync(store(), {recursive: true, mode: 0o700});
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, {mode: 0o600});
    fs.renameSync(tmp, file);
    return {label, file, ...snap};
  }

  function save(label, {excludeSelf = false} = {}) {
    let live = liveSessions();
    if (excludeSelf) {
      const me = selfPid(live);
      live = live.filter((r) => r.pid !== me);
    }
    if (!live.length) throw new Error('no running Claude Code session to save');
    return write(label ?? stampLabel(now()), live);
  }

  /** The scheduled job: a new auto snapshot only when the set changed, then
   *  prune autos beyond `keep`. Returns {saved, reason, pruned}. */
  function autosave({keep = AUTO_KEEP} = {}) {
    const live = liveSessions();
    let saved = null;
    let reason;
    const lastAuto = snapshots().find((s) => s.label.startsWith(AUTO_PREFIX));
    if (!live.length) {
      reason = 'no running session';
    } else if (lastAuto && sameSessions(lastAuto.sessions, live)) {
      reason = `unchanged since ${lastAuto.label}`;
    } else {
      saved = write(`${AUTO_PREFIX}${stampLabel(now())}`, live);
      reason = `${live.length} sessions`;
    }
    const pruned = snapshots().filter((s) => s.label.startsWith(AUTO_PREFIX)).slice(keep);
    for (const s of pruned) fs.rmSync(s.file, {force: true});
    return {saved, reason, pruned: pruned.map((s) => s.label)};
  }

  function purge(list) {
    for (const s of list) fs.rmSync(s.file, {force: true});
    return list.map((s) => s.label);
  }

  /** What `open` would do: {open: rows, skipped: [{row, why}]}. A session
   *  already running is skipped unless `force` - Claude Code refuses to
   *  resume a live session in a second process anyway. */
  function plan(snap, {only = [], skip = [], force = false} = {}) {
    const running = new Set(liveSessions().map((r) => r.session_id));
    const open = [];
    const skipped = [];
    for (const row of snap.sessions) {
      if (only.length && !only.includes(row.name)) continue;
      if (skip.includes(row.name)) continue;
      const why = running.has(row.session_id) && !force ? 'already running' : blocker(row);
      if (why) skipped.push({row, why});
      else open.push(row);
    }
    return {open, skipped};
  }

  /** Open rows in the terminal the panels use (terminals.js), or `terminal`
   *  when given. Returns {terminal, how, steps}; dryRun runs nothing. */
  function launch(rows, {terminal, windows = false, tmux = false, prompt = '', dryRun = false} = {}) {
    const env = io.env ?? process.env;
    const term = terminal ?? resolveTerminal({...io, env});
    const hasTmux = onPath('tmux', env.PATH);
    if (!term && !hasTmux) {
      throw new Error('no terminal found - set one in the panel preferences, $TERMINAL, or --terminal=BIN');
    }
    const {how, steps} = launchSteps(rows, term ?? 'tmux', {platform: platform(), hasTmux, windows, tmux, prompt});
    const result = {terminal: term ?? 'tmux', how, steps};
    if (dryRun) return result;
    if (steps.some((s) => s.cmd === 'tmux')) {
      let exists = true;
      try {
        exec('tmux', ['has-session', '-t', TMUX_SESSION], {stdio: 'ignore'});
      } catch {
        exists = false;
      }
      if (exists) {
        throw new Error(`tmux session ${TMUX_SESSION} already exists - tmux attach -t ${TMUX_SESSION}, ` +
          `or tmux kill-session -t ${TMUX_SESSION} first`);
      }
    }
    for (const s of steps) {
      if (s.detach) (io.spawn ?? nodeSpawn)(s.cmd, s.args, {detached: true, stdio: 'ignore'}).unref();
      else exec(s.cmd, s.args, {stdio: 'ignore'});
    }
    return result;
  }

  return {liveSessions, selfPid, blocker, snapshots, resolve, save, autosave, purge, plan, launch};
}
