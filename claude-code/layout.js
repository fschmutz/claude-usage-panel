// Where each running Claude session sits on screen - which terminal window,
// which tab - so `claudectl session open` can put them back the same way
// instead of piling every session into one window.
//
// A session is found by its controlling tty (or, for kitty, its pid),
// matched against the terminals that can list theirs, most exact first:
//
//   tmux     - `tmux list-panes -a`: a session inside tmux belongs to its tmux
//              session (the window) and tmux window (the tab), whatever
//              terminal shows it.
//   kitty    - `kitty @ ls` (remote control, asked only from inside kitty or
//              with $KITTY_LISTEN_ON): OS windows > tabs > foreground pids.
//   WezTerm  - `wezterm cli --no-auto-start list`: windows > tabs > ttys.
//   iTerm    - AppleScript over windows > tabs > sessions: exact even after
//   Terminal   tabs were dragged around. Needs the Automation permission, so
//              only an interactive `save` asks (askApps), never the scheduled
//              autosave, and only an app that is already running.
//   iTerm    - $ITERM_SESSION_ID (w0t3p0:…) from the process environment:
//              no permission, but set when the tab opened and never updated,
//              so a tab moved since then is placed where it was born.
//
// The CLI tools are looked up on PATH plus TOOL_DIRS: the launchd / systemd
// job that autosaves has neither /opt/homebrew/bin nor always /usr/local/bin.
// Anything else (gnome-terminal cannot list its tabs) stays unplaced, and a
// snapshot without placement reopens as before: one window.
//
// captureLayout() returns the rows with {window, tab} added where known and
// sorted window by window, tab by tab: the order `open` recreates them in.

import {execFileSync} from 'node:child_process';

import {onPath, toolPath, TOOL_DIRS} from './terminals.js';

// `tab` is a class inside both tell blocks, hence the ASCII character.
const tabbedScript = (app, perTab) => `tell application "${app}"
  set out to ""
  set tb to ASCII character 9
  repeat with w in windows
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
${perTab}
    end repeat
  end repeat
  return out
end tell`;

/** Every iTerm session as `tty<TAB>window id<TAB>tab number`, windows front
 *  to back. */
export const ITERM_LAYOUT_SCRIPT = tabbedScript('iTerm', `      repeat with s in sessions of t
        set out to out & (tty of s) & tb & (id of w) & tb & ti & linefeed
      end repeat`);

/** Every Terminal.app tab, same shape: a tab has one tty. */
export const TERMINAL_LAYOUT_SCRIPT = tabbedScript('Terminal',
  '      set out to out & (tty of t) & tb & (id of w) & tb & ti & linefeed');

// `:` separates: tmux prints a tab in -F output as `_` (3.6), and forbids
// `:` in a session name; a tty path and a window index have none either.
export const TMUX_LAYOUT_FORMAT = '#{pane_tty}:#{session_name}:#{window_index}';

/** `key<TAB>window<TAB>tab` lines to Map(key -> {window: prefix+window, tab,
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

const parseJson = (text) => {
  try {
    const v = JSON.parse(String(text ?? ''));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** `wezterm cli list --format json` to the same Map, keyed by tty. Tabs are
 *  numbered in listing order within their window, from 1. */
export function parseWeztermList(text) {
  const lines = [];
  const tabsOf = new Map();
  for (const p of parseJson(text)) {
    if (typeof p?.tty_name !== 'string' || !Number.isInteger(p.window_id) || !Number.isInteger(p.tab_id)) continue;
    const tabs = tabsOf.get(p.window_id) ?? [];
    if (!tabs.includes(p.tab_id)) tabs.push(p.tab_id);
    tabsOf.set(p.window_id, tabs);
    lines.push(`${p.tty_name}\t${p.window_id}\t${tabs.indexOf(p.tab_id) + 1}`);
  }
  return parseTtyTable(lines.join('\n'), 'wezterm:');
}

/** `kitty @ ls` to the same Map, keyed `pid:N` - kitty lists the pids in a
 *  window (its own process and the foreground ones), not the tty. */
export function parseKittyLs(text) {
  const lines = [];
  for (const osWin of parseJson(text)) {
    (osWin?.tabs ?? []).forEach((tab, ti) => {
      for (const w of tab?.windows ?? []) {
        const pids = [w?.pid, ...(w?.foreground_processes ?? []).map((f) => f?.pid)];
        for (const pid of pids.filter(Number.isInteger)) lines.push(`pid:${pid}\t${osWin.id}\t${ti + 1}`);
      }
    });
  }
  return parseTtyTable(lines.join('\n'), 'kitty:');
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

/** One batched `ps -o pid=,<field>=` listing to Map(pid -> rest of line). */
export function parsePsColumns(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/**
 * Place rows (live sessions with a pid) by window and tab. Pure: `tables`
 * are the lookups most exact first, keyed by tty or `pid:N`; `envOf` gives
 * a pid's $ITERM_SESSION_ID, the last resort. Placed rows come first, window
 * by window in the order their source lists them, tabs in order; unplaced
 * rows follow in their own order.
 */
export function placeRows(rows, {ttyOf, tables, envOf}) {
  const placed = rows.map((r, i) => {
    const keys = [ttyOf(r.pid), `pid:${r.pid}`].filter(Boolean);
    let loc = null;
    tables.forEach((table, rank) => {
      const hit = !loc && keys.map((k) => table.get(k)).find(Boolean);
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

/**
 * captureLayout's I/O: io.platform, io.env, io.exec, io.toolDirs.
 * opts.askApps lets it query running iTerm / Terminal.app by AppleScript,
 * which may raise the Automation prompt: an interactive `save` only.
 */
export function captureLayout(rows, io = {}, {askApps = false} = {}) {
  const platform = io.platform ?? process.platform;
  const baseEnv = io.env ?? process.env;
  const env = {...baseEnv, PATH: toolPath(baseEnv.PATH, io.toolDirs ?? TOOL_DIRS)};
  const run = (cmd, args) => {
    try {
      return String((io.exec ?? execFileSync)(cmd, args,
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, env}));
    } catch {
      return '';
    }
  };
  const has = (bin) => onPath(bin, env.PATH);
  const pids = rows.map((r) => r.pid).filter(Number.isInteger);
  const hasPs = has('ps') && pids.length > 0;
  const ps = (flags, field) => (hasPs
    ? parsePsColumns(run('ps', [flags, '-o', `pid=,${field}=`, '-p', pids.join(',')])) : new Map());

  const tables = [];
  if (has('tmux')) {
    const panes = run('tmux', ['list-panes', '-a', '-F', TMUX_LAYOUT_FORMAT]).replaceAll(':', '\t');
    tables.push(parseTtyTable(panes, 'tmux:'));
  }
  if ((baseEnv.KITTY_LISTEN_ON || baseEnv.KITTY_WINDOW_ID) && has('kitty')) {
    const to = baseEnv.KITTY_LISTEN_ON ? ['--to', baseEnv.KITTY_LISTEN_ON] : [];
    tables.push(parseKittyLs(run('kitty', ['@', ...to, 'ls'])));
  }
  if (has('wezterm')) tables.push(parseWeztermList(run('wezterm', ['cli', '--no-auto-start', 'list', '--format', 'json'])));
  if (platform === 'darwin' && askApps && hasPs && has('osascript')) {
    // only ask a running app: `tell application` would launch it (pgrep
    // misses GUI apps under a sandbox; ps does not)
    const running = new Set(run('ps', ['-axco', 'comm=']).split('\n').map((c) => c.trim()));
    if (running.has('iTerm2')) tables.push(parseTtyTable(run('osascript', ['-e', ITERM_LAYOUT_SCRIPT]), 'iterm:'));
    if (running.has('Terminal')) tables.push(parseTtyTable(run('osascript', ['-e', TERMINAL_LAYOUT_SCRIPT]), 'terminal:'));
  }

  const ttys = ps('-ww', 'tty');
  // $ITERM_SESSION_ID only exists for a process iTerm started: macOS only
  // (-E appends the environment to the command)
  const envs = platform === 'darwin' ? new Map([...ps('-wwE', 'command').entries()].map(([pid, line]) =>
    [pid, (/(?:^|\s)ITERM_SESSION_ID=(\S+)/.exec(line) ?? [])[1] ?? null])) : new Map();
  return placeRows(rows, {ttyOf: (pid) => ttyPath(ttys.get(pid)), tables, envOf: (pid) => envs.get(pid) ?? null});
}
