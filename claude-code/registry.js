// Which Claude Code sessions are running, read from Claude Code's own
// live-session registry, <claude dir>/sessions/<pid>.json, checked against
// the process table. The registry carries the CURRENT session id (it moves on
// /clear, so the `--resume` id a process was started with can be stale), the
// cwd and the name. A registry file outlives a crash, so every entry is
// checked: on Linux the kernel start time in /proc/<pid>/stat must equal the
// entry's `procStart`, which also rejects a pid recycled by an unrelated
// process; elsewhere the pid must be running a `claude` command line.
//
// The one reader for everything that asks "which sessions are up": tabs.js
// (snapshots, reopen), pause.js, awake.js and waiting.js. Building the
// snapshot store to ask about pids is what this module exists to avoid.
//
// `openRegistry(io)` binds it to one HOME, platform, exec, pid and /proc
// root (every one overridable, read at call time), so the tests run against
// a throwaway HOME and a fake /proc.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {sessionRegistryDir} from './paths.js';
import {readJSON} from './private-fs.js';
import {claudeArgs, isClaudeCommand, procStat} from './procs.js';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The value of a flag in `--flag V`, `--flag=V` or `-f V` form, or null.
 *  A value is optional for some flags (`-r` alone opens the picker), so a
 *  following argument that is itself a flag is not the value. */
export function flagValue(args, long, short) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1) || null;
    if (a === long || a === short) {
      const v = args[i + 1];
      return v && !v.startsWith('-') ? v : null;
    }
  }
  return null;
}

/** The session id a claude process resumed, or null: `--resume` also takes
 *  a search term for the picker, which names no session. */
function resumeIdOf(args) {
  const v = flagValue(args, '--resume', '-r');
  return v && SESSION_ID_RE.test(v) ? v : null;
}

/** io (all optional): homedir, env, platform, pid, procDir, exec. */
export function openRegistry(io = {}) {
  const platform = () => io.platform ?? process.platform;
  const procDir = () => io.procDir ?? '/proc';
  const exec = (...a) => (io.exec ?? execFileSync)(...a);

  /** Kernel start time (field 22) of a pid, or null. */
  function procStart(pid) {
    return procStat(pid, procDir())?.startTime ?? null;
  }

  function isAlive(entry) {
    if (platform() === 'linux') return procStart(entry.pid) === String(entry.procStart);
    try {
      const cmd = exec('ps', ['-o', 'command=', '-p', String(entry.pid)],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      return isClaudeCommand(cmd);
    } catch {
      return false;
    }
  }

  /** The live registry row of one claude pid ({session_id, cwd, name,
   *  status, pid}), or null when the pid has no registry file or is dead:
   *  one file and one liveness check, cheap enough for a poll. */
  function sessionOfPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const d = readJSON(path.join(sessionRegistryDir(io), `${pid}.json`));
    if (!d || d.pid !== pid || !d.sessionId || !isAlive(d)) return null;
    return {
      name: d.name || path.basename(d.cwd ?? ''), cwd: d.cwd ?? '', session_id: d.sessionId, pid,
      status: d.status ?? '', startedAt: d.startedAt ?? null,
    };
  }

  function registeredSessions() {
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

  /** Every live `claude` process (Linux: /proc), native or npm-installed
   *  (claudeArgs): its resumed session id (--resume/-r), --name, cwd, and
   *  whether it has a terminal. The registry is not the whole truth: a
   *  session launched as another session's child, or still at a startup
   *  prompt, never writes its registry file, and autosave went on reporting
   *  "unchanged" with eight of them open. */
  function claudeProcesses() {
    if (platform() !== 'linux') return [];
    let pids;
    try {
      pids = fs.readdirSync(procDir()).filter((d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
    const out = [];
    for (const pid of pids) {
      const dir = path.join(procDir(), pid);
      let argv;
      try {
        argv = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0');
      } catch {
        continue;
      }
      const args = claudeArgs(argv);
      if (!args) continue;
      let cwd = null;
      try {
        cwd = fs.readlinkSync(path.join(dir, 'cwd'));
      } catch {
        cwd = null;
      }
      const tty = (procStat(pid, procDir())?.ttyNr ?? 0) !== 0;
      out.push({pid: Number(pid), resumeId: resumeIdOf(args), name: flagValue(args, '--name', '-n'), cwd, tty});
    }
    return out;
  }

  /** Running interactive sessions, oldest first: the registry, plus the
   *  terminal-attached `claude --resume <id>` processes it does not know
   *  (status "unregistered", after the registered ones). */
  function liveSessions() {
    const rows = registeredSessions();
    const known = new Set(rows.map((r) => r.session_id));
    const pids = new Set(rows.map((r) => r.pid));
    for (const p of claudeProcesses()) {
      if (!p.tty || !p.resumeId || !p.cwd || known.has(p.resumeId) || pids.has(p.pid)) continue;
      known.add(p.resumeId);
      rows.push({
        name: p.name || path.basename(p.cwd), cwd: p.cwd, session_id: p.resumeId, pid: p.pid,
        status: 'unregistered', startedAt: Number.MAX_SAFE_INTEGER,
      });
    }
    return rows;
  }

  /** Terminal-attached claude processes that are neither registered nor
   *  resumed from a known id: running, but impossible to snapshot. */
  function unaccounted() {
    const registered = new Set(registeredSessions().map((r) => r.pid));
    return claudeProcesses().filter((p) => p.tty && !p.resumeId && !registered.has(p.pid));
  }

  // The parent of a pid: /proc on Linux, `ps` elsewhere (macOS has no
  // /proc). 0 when it cannot be read.
  function parentPid(pid) {
    if (platform() === 'linux') return procStat(pid, procDir())?.ppid ?? 0;
    try {
      return Number(String(exec('ps', ['-o', 'ppid=', '-p', String(pid)],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})).trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** The live session this process runs under, or null - lets `list` mark
   *  it and `save --exclude-self` drop it. Claude Code names it in
   *  CLAUDE_PID for every command it runs, on every platform; without that
   *  (a terminal of its own), walk the parent chain. */
  function selfPid(live) {
    const pids = new Set(live.map((r) => r.pid));
    const named = Number((io.env ?? process.env).CLAUDE_PID);
    if (pids.has(named)) return named;
    let pid = io.pid ?? process.pid;
    for (let hops = 0; pid > 1 && hops < 64; hops++) {
      if (pids.has(pid)) return pid;
      pid = parentPid(pid);
    }
    return null;
  }

  return {liveSessions, sessionOfPid, procStart, claudeProcesses, unaccounted, selfPid};
}
