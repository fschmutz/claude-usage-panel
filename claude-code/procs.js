// The process-table primitives of the Node port, one copy each: is a pid
// alive, what /proc/<pid>/stat says about it, is a command line Claude Code,
// and what identifies a process across a check and a later signal. The
// registry (registry.js), the leftover scan (leftovers.js), the pause waiter
// and claudectl session close all read processes through these.

import fs from 'node:fs';
import path from 'node:path';

/** process.kill(pid, 0): alive (EPERM = alive, someone else's). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * The fields of /proc/<pid>/stat this port reads: {ppid, ttyNr, startTime}
 * (startTime, field 22, as the kernel prints it: a string compared as is),
 * or null when the pid is gone or the line is not a stat line. comm (field
 * 2) may hold spaces and parens, so the fields are split after the LAST ')'.
 */
export function procStat(pid, procDir = '/proc') {
  let stat;
  try {
    stat = fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // after ')': state(3) ppid(4) pgrp(5) session(6) tty_nr(7) ... starttime(22)
  const f = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(f[1]);
  const ttyNr = Number(f[4]);
  return {
    ppid: Number.isInteger(ppid) ? ppid : 0,
    ttyNr: Number.isInteger(ttyNr) ? ttyNr : 0,
    startTime: f[19] ?? null,
  };
}

const CLI_JS_RE = /(^|\/)@anthropic-ai\/claude-code\/cli\.m?js$/;

/** A command line's arguments to claude, or null when it is not claude:
 *  the native binary (`claude ...`, any directory) or an npm install run by
 *  its interpreter (`node .../claude ...`, `node .../@anthropic-ai/claude-code/cli.js ...`). */
export function claudeArgs(argv) {
  const bin = path.basename(argv[0] ?? '');
  if (bin === 'claude') return argv.slice(1);
  if (/^(node|nodejs|bun)$/.test(bin) && (path.basename(argv[1] ?? '') === 'claude' || CLI_JS_RE.test(argv[1] ?? ''))) {
    return argv.slice(2);
  }
  return null;
}

/** The one "is this Claude Code" test, on an argv. */
export const isClaudeArgv = (argv) => claudeArgs(argv) !== null;

/** The same test on a `ps -o command=` / `args=` line (words split on
 *  whitespace: an install path with a space in it is not recognized). */
export const isClaudeCommand = (line) => isClaudeArgv(String(line ?? '').trim().split(/\s+/));

/**
 * What identifies `pid` across a check and a later signal, or null when it
 * is gone: the kernel start time on Linux; elsewhere `ps`'s start time and
 * command line (macOS has no /proc). A pid recycled in between reads
 * differently, so a signal is only sent while the identity is unchanged.
 * io: platform, procDir, exec (execFileSync).
 */
export function processIdentity(io, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if ((io.platform ?? process.platform) === 'linux') return procStat(pid, io.procDir ?? '/proc')?.startTime ?? null;
  try {
    const out = String(io.exec('ps', ['-o', 'lstart=,command=', '-p', String(pid)],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})).trim();
    return out || null;
  } catch {
    return null;
  }
}
