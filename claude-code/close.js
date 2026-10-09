// `claudectl session close`: end running Claude Code sessions and the
// terminal tab each one sits in. A tab closes when the last process on its
// tty exits, and a window when its last tab does, so the tab is closed by
// ending the shells that started claude on that tty (`bash -lc 'claude ...;
// exec bash'`, an interactive shell, a tmux pane's shell) - never by asking
// the terminal, which works the same for gnome-terminal, kitty, WezTerm,
// iTerm, Terminal.app and tmux. Node-only, like tabs.js: no port to mirror.

import {execFileSync} from 'node:child_process';

// Only these are ended as "the tab's shell": walking up stops at the first
// process that is not one (the terminal, tmux, sshd, login, sudo).
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'elvish']);

/** `ps -A -o pid=,ppid=,tty=,comm=` as rows. comm may hold spaces, so it is
 *  the rest of the line; a login shell's leading `-` is dropped. */
export function parsePsTable(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!m) continue;
    const comm = m[4].replace(/^-/, '').split('/').pop();
    rows.push({pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], comm});
  }
  return rows;
}

const noTty = (tty) => !tty || tty === '?' || tty === '??' || tty === '-';

/**
 * What ending `pid` takes, from a process table: `shells`, the shell
 * ancestors on the same tty, innermost first (ending them closes the tab),
 * and `foreign`, every other process on that tty that is neither one of them
 * nor a descendant of claude (work closing the tab would kill too). A claude
 * with no tty has neither.
 */
export function closePlan(table, pid) {
  const byPid = new Map(table.map((r) => [r.pid, r]));
  const self = byPid.get(pid);
  if (!self || noTty(self.tty)) return {tty: null, shells: [], foreign: []};
  const shells = [];
  for (let p = byPid.get(self.ppid); p && p.pid > 1 && p.tty === self.tty && SHELLS.has(p.comm); p = byPid.get(p.ppid)) {
    shells.push(p.pid);
  }
  const mine = new Set([pid, ...shells]);
  // descendants of claude: hooks, MCP servers, its shells
  for (let grew = true; grew;) {
    grew = false;
    for (const r of table) {
      if (!mine.has(r.pid) && r.pid !== r.ppid && mine.has(r.ppid) && !shells.includes(r.ppid)) {
        mine.add(r.pid);
        grew = true;
      }
    }
  }
  const foreign = table.filter((r) => r.tty === self.tty && !mine.has(r.pid)).map((r) => ({pid: r.pid, comm: r.comm}));
  return {tty: self.tty, shells, foreign};
}

/** Why a session is not closed without --force, or null. */
export function closeBlocker(row, plan, {self}) {
  if (row.pid === self) return 'the session you are in';
  if (row.status === 'busy') return 'busy (mid-turn)';
  if (plan.foreign.length) {
    return `other processes on its tab: ${plan.foreign.slice(0, 3).map((f) => `${f.comm} ${f.pid}`).join(', ')}` +
      `${plan.foreign.length > 3 ? ', ...' : ''}`;
  }
  return null;
}

/**
 * Bind close to one environment. io (all optional): exec (execFileSync),
 * kill (process.kill), sleep (ms => Promise), graceMs.
 */
export function openClose(io = {}) {
  const exec = (...a) => (io.exec ?? execFileSync)(...a);
  const kill = (pid, sig) => (io.kill ?? process.kill)(pid, sig);
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = io.graceMs ?? 10_000;

  function table() {
    return parsePsTable(exec('ps', ['-A', '-o', 'pid=,ppid=,tty=,comm='],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024}));
  }

  function alive(pid) {
    try {
      kill(pid, 0);
      return true;
    } catch (e) {
      return e?.code === 'EPERM';
    }
  }

  function signal(pid, sig) {
    try {
      kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }

  async function gone(pid) {
    for (let waited = 0; waited < graceMs; waited += 250) {
      if (!alive(pid)) return true;
      await sleep(250);
    }
    return !alive(pid);
  }

  /** End one session: SIGTERM claude, wait the grace, SIGKILL only with
   *  `force`; once claude is gone, SIGHUP its shells (as a closing tab
   *  would), which closes the tab. Returns {closed, tab, how}. */
  async function closeOne(row, plan, {force = false} = {}) {
    signal(row.pid, 'SIGTERM');
    let how = 'SIGTERM';
    if (!(await gone(row.pid))) {
      if (!force) return {closed: false, tab: false, how: `still running ${graceMs / 1000}s after SIGTERM (--force sends SIGKILL)`};
      signal(row.pid, 'SIGKILL');
      how = 'SIGKILL';
      if (!(await gone(row.pid))) return {closed: false, tab: false, how: 'still running after SIGKILL'};
    }
    // innermost first: a `bash -lc '...; exec bash'` has already exec'd
    // into an interactive bash under the same pid, which SIGHUP ends
    for (const pid of plan.shells) signal(pid, 'SIGHUP');
    return {closed: true, tab: plan.shells.length > 0, how};
  }

  return {table, closeOne};
}
