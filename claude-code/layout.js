// Where each running Claude session sits on screen - which terminal window,
// which tab - so `claudectl session open` can put them back the same way
// instead of piling every session into one window.
//
// A session is found by its controlling tty, matched against the terminals
// that can list theirs, most exact first:
//
//   tmux   - `tmux list-panes -a`: a session inside tmux belongs to its tmux
//            session (the window) and tmux window (the tab), whatever
//            terminal shows it.
//   iTerm  - AppleScript over windows > tabs > sessions: exact even after
//            tabs were dragged around. Needs the Automation permission once;
//            a scheduled run may be refused it, and then:
//   iTerm  - $ITERM_SESSION_ID (w0t3p0:…) from the process environment:
//            no permission, but set when the tab opened and never updated,
//            so a tab moved since then is placed where it was born.
//
// Anything else (gnome-terminal cannot list its tabs) stays unplaced, and a
// snapshot without placement reopens as before: one window.
//
// captureLayout() returns the rows with {window, tab} added where known and
// sorted window by window, tab by tab: the order `open` recreates them in.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {onPath} from './terminals.js';

/** Lists every iTerm session as `tty<TAB>window id<TAB>tab number`, windows
 *  front to back. `tab` is an iTerm class inside the tell block, hence the
 *  ASCII character. */
export const ITERM_LAYOUT_SCRIPT = `tell application "iTerm"
  set out to ""
  set tb to ASCII character 9
  repeat with w in windows
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      repeat with s in sessions of t
        set out to out & (tty of s) & tb & (id of w) & tb & ti & linefeed
      end repeat
    end repeat
  end repeat
  return out
end tell`;

export const TMUX_LAYOUT_FORMAT = '#{pane_tty}\t#{session_name}\t#{window_index}';

/** `tty<TAB>window<TAB>tab` lines to Map(tty -> {window: prefix+window, tab,
 *  order}); order is the line number, so the listing's own order is kept. */
export function parseTtyTable(text, prefix) {
  const map = new Map();
  String(text ?? '').split('\n').forEach((line, i) => {
    const [tty, win, tab] = line.split('\t');
    if (!tty || !win || !/^\d+$/.test(tab ?? '') || map.has(tty)) return;
    map.set(tty, {window: `${prefix}${win}`, tab: Number(tab), order: i});
  });
  return map;
}

/** $ITERM_SESSION_ID (w0t3p0:UUID) to {window, tab, order}, or null. */
export function parseItermEnv(value) {
  const m = /^w(\d+)t(\d+)p\d+/.exec(String(value ?? ''));
  if (!m) return null;
  return {window: `iterm-w${m[1]}`, tab: Number(m[2]) + 1, order: Number(m[1]) * 10000 + Number(m[2])};
}

/** A `ps -o tty=` value as a device path, or null when there is no tty. */
export function ttyPath(value) {
  const t = String(value ?? '').trim();
  if (!t || /^\?+$/.test(t)) return null;
  return t.startsWith('/') ? t : `/dev/${t}`;
}

/**
 * Place rows (live sessions with a pid) by window and tab. Pure: `sources`
 * are the three lookups, most exact first. Placed rows come first, window by
 * window in the order their source lists them, tabs in order; unplaced rows
 * follow in their own order.
 */
export function placeRows(rows, {ttyOf, tables, envOf}) {
  const placed = rows.map((r, i) => {
    const tty = ttyOf(r.pid);
    let loc = null;
    tables.forEach((table, rank) => {
      const hit = !loc && tty && table.get(tty);
      if (hit) loc = {...hit, rank};
    });
    if (!loc) {
      const env = parseItermEnv(envOf(r.pid));
      if (env) loc = {...env, rank: tables.length};
    }
    return {r, i, loc};
  });
  // a window's position is that of its first tab: windows never interleave
  const first = new Map();
  for (const p of placed) {
    if (!p.loc) continue;
    const key = [p.loc.rank, p.loc.order];
    const seen = first.get(p.loc.window);
    if (!seen || key[0] < seen[0] || (key[0] === seen[0] && key[1] < seen[1])) first.set(p.loc.window, key);
  }
  const cmp = (a, b) => {
    if (!a.loc || !b.loc) return (a.loc ? -1 : 0) + (b.loc ? 1 : 0) || a.i - b.i;
    const [wa, wb] = [first.get(a.loc.window), first.get(b.loc.window)];
    return wa[0] - wb[0] || wa[1] - wb[1] || a.loc.tab - b.loc.tab || a.i - b.i;
  };
  return placed.sort(cmp).map(({r, loc}) => (loc ? {...r, window: loc.window, tab: loc.tab} : r));
}

/** captureLayout's I/O: io.platform, io.env (PATH), io.exec, io.procDir. */
export function captureLayout(rows, io = {}) {
  const platform = io.platform ?? process.platform;
  const env = io.env ?? process.env;
  const exec = (cmd, args) => String((io.exec ?? execFileSync)(cmd, args,
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000}));
  const tryRun = (cmd, args) => {
    try {
      return exec(cmd, args);
    } catch {
      return '';
    }
  };
  const has = (bin) => onPath(bin, env.PATH);
  const hasPs = has('ps');

  const tables = [];
  if (has('tmux')) tables.push(parseTtyTable(tryRun('tmux', ['list-panes', '-a', '-F', TMUX_LAYOUT_FORMAT]), 'tmux:'));
  // only ask a running iTerm: `tell application` would launch it (pgrep
  // misses GUI apps under a sandbox; ps does not)
  const itermRunning = () => tryRun('ps', ['-axco', 'comm=']).split('\n').some((c) => c.trim() === 'iTerm2');
  if (platform === 'darwin' && hasPs && has('osascript') && itermRunning()) {
    tables.push(parseTtyTable(tryRun('osascript', ['-e', ITERM_LAYOUT_SCRIPT]), 'iterm:'));
  }

  const envOf = (pid) => {
    if (platform === 'linux') {
      try {
        const environ = fs.readFileSync(path.join(io.procDir ?? '/proc', String(pid), 'environ'), 'utf8');
        return environ.split('\0').find((e) => e.startsWith('ITERM_SESSION_ID='))?.slice(17) ?? null;
      } catch {
        return null;
      }
    }
    if (!hasPs) return null;
    return /(?:^|\s)ITERM_SESSION_ID=(\S+)/.exec(tryRun('ps', ['-wwE', '-o', 'command=', '-p', String(pid)]))?.[1] ?? null;
  };
  const ttyOf = (pid) => (hasPs && pid ? ttyPath(tryRun('ps', ['-o', 'tty=', '-p', String(pid)])) : null);
  return placeRows(rows, {ttyOf, tables, envOf});
}
