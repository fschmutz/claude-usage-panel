// Where each running Claude session sits on screen - which terminal window,
// which tab - so `claudectl session open` can put them back the same way
// instead of piling every session into one window.
//
// A session is matched by its controlling tty (kitty: its pid) against the
// terminals that can list theirs. SOURCES is that list, in precedence order:
// the first source that knows a session places it. Past them, the last
// resort is $ITERM_SESSION_ID (w0t3p0:…) from the process environment: no
// permission needed, but set when the tab opened and never updated, so a tab
// moved since then is placed where it was born.
//
// AppleScript sources need the macOS Automation permission, so only a `save`
// the user types asks them (askApps), never the scheduled autosave, and only
// an app that is already running: `tell application` would launch it.
// Anything else (gnome-terminal cannot list its tabs) stays unplaced, and a
// snapshot without placement reopens as before: one window.
//
// Pure: the parsers and placeRows. I/O: captureLayout, which only runs the
// queries (tools.js) and hands their text to the parsers.
//
// A saved `tab` is an ordinal within its window, compared only to notice a
// session that moved (sameSessions); tmux counts from its base-index, the
// others from 1. The ORDER of the saved rows is what `open` recreates.

import {onPath, query, toolEnv} from './tools.js';

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

/** Record key -> {window, tab, order} in `map` unless the key is known:
 *  the first listing of a tty or pid wins. */
function addLoc(map, key, window, tab) {
  if (!map.has(key)) map.set(key, {window, tab, order: map.size});
}

/** `key<sep>window<sep>tab` lines to Map(key -> {window: prefix+window, tab,
 *  order}), in listing order; malformed lines are skipped. */
export function parseTtyTable(text, prefix, sep = '\t') {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const [key, win, tab] = line.split(sep);
    if (key && win && /^\d+$/.test(tab ?? '')) addLoc(map, key, `${prefix}${win}`, Number(tab));
  }
  return map;
}

/** `tmux list-panes -a -F TMUX_LAYOUT_FORMAT` to the same Map. */
export const parseTmuxPanes = (text) => parseTtyTable(text, 'tmux:', ':');

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
  const map = new Map();
  const tabsOf = new Map();
  for (const p of parseJson(text)) {
    if (typeof p?.tty_name !== 'string' || !Number.isInteger(p.window_id) || !Number.isInteger(p.tab_id)) continue;
    const tabs = tabsOf.get(p.window_id) ?? [];
    if (!tabs.includes(p.tab_id)) tabs.push(p.tab_id);
    tabsOf.set(p.window_id, tabs);
    addLoc(map, p.tty_name, `wezterm:${p.window_id}`, tabs.indexOf(p.tab_id) + 1);
  }
  return map;
}

/** `kitty @ ls` to the same Map, keyed `pid:N` - kitty lists the pids in a
 *  window (its own process and the foreground ones), not the tty. */
export function parseKittyLs(text) {
  const map = new Map();
  for (const osWin of parseJson(text)) {
    if (!Number.isInteger(osWin?.id)) continue;
    (osWin.tabs ?? []).forEach((tab, ti) => {
      for (const w of tab?.windows ?? []) {
        const pids = [w?.pid, ...(w?.foreground_processes ?? []).map((f) => f?.pid)];
        for (const pid of pids.filter(Number.isInteger)) addLoc(map, `pid:${pid}`, `kitty:${osWin.id}`, ti + 1);
      }
    });
  }
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

/** One batched `ps -o pid=,<field>=` listing to Map(pid -> rest of line). */
export function parsePsColumns(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/** `ps -wwE -o pid=,command=` (macOS: the environment follows the command)
 *  to Map(pid -> $ITERM_SESSION_ID). */
export function parsePsEnv(text) {
  const map = new Map();
  for (const [pid, line] of parsePsColumns(text)) {
    const m = /(?:^|\s)ITERM_SESSION_ID=(\S+)/.exec(line);
    if (m) map.set(pid, m[1]);
  }
  return map;
}

/**
 * The placement sources, most exact first. `when` gates the query (ctx:
 * {env, has, askApps, running}); `argv` is the query; `parse` turns its
 * stdout into a Map keyed by tty or `pid:N`.
 */
export const SOURCES = [
  // a session inside tmux belongs to its tmux session (the window) and tmux
  // window (the tab), whatever terminal shows it
  {name: 'tmux', when: (c) => c.has('tmux'),
    argv: () => ['tmux', 'list-panes', '-a', '-F', TMUX_LAYOUT_FORMAT], parse: parseTmuxPanes},
  // remote control over the caller's own kitty: outside it, `kitty @` would
  // talk to whatever tty it runs on
  {name: 'kitty', when: (c) => Boolean(c.env.KITTY_LISTEN_ON || c.env.KITTY_WINDOW_ID) && c.has('kitty'),
    argv: (c) => ['kitty', '@', ...(c.env.KITTY_LISTEN_ON ? ['--to', c.env.KITTY_LISTEN_ON] : []), 'ls'],
    parse: parseKittyLs},
  {name: 'wezterm', when: (c) => c.has('wezterm'),
    argv: () => ['wezterm', 'cli', '--no-auto-start', 'list', '--format', 'json'], parse: parseWeztermList},
  // exact even after tabs were dragged around
  {name: 'iterm', when: (c) => c.askApps && c.running().has('iTerm2'),
    argv: () => ['osascript', '-e', ITERM_LAYOUT_SCRIPT], parse: (t) => parseTtyTable(t, 'iterm:')},
  {name: 'terminal', when: (c) => c.askApps && c.running().has('Terminal'),
    argv: () => ['osascript', '-e', TERMINAL_LAYOUT_SCRIPT], parse: (t) => parseTtyTable(t, 'terminal:')},
];

/**
 * Place rows (live sessions with a pid) by window and tab. Pure: `tables`
 * are the SOURCES' maps in precedence order; `envOf` gives a pid's
 * $ITERM_SESSION_ID, the last resort. Placed rows come first, window by
 * window in the order their source lists them, tabs in order; unplaced rows
 * follow in their own order.
 */
export function placeRows(rows, {ttyOf, tables, envOf}) {
  const locate = (pid) => {
    const keys = [ttyOf(pid), `pid:${pid}`].filter(Boolean);
    for (const [rank, table] of tables.entries()) {
      const hit = keys.map((k) => table.get(k)).find(Boolean);
      if (hit) return {...hit, rank};
    }
    const env = parseItermEnv(envOf(pid));
    return env && {...env, rank: tables.length};
  };
  const placed = rows.map((r, i) => ({r, i, loc: locate(r.pid)}));
  // a window sorts where its first tab does: windows never interleave
  const before = (a, b) => a.rank - b.rank || a.order - b.order;
  const first = new Map();
  for (const {loc} of placed) {
    if (loc && !(first.has(loc.window) && before(first.get(loc.window), loc) <= 0)) first.set(loc.window, loc);
  }
  const cmp = (a, b) => {
    if (!a.loc || !b.loc) return (a.loc ? -1 : 0) + (b.loc ? 1 : 0) || a.i - b.i;
    return before(first.get(a.loc.window), first.get(b.loc.window)) || a.loc.tab - b.loc.tab || a.i - b.i;
  };
  return placed.sort(cmp).map(({r, loc}) => (loc ? {...r, window: loc.window, tab: loc.tab} : r));
}

/**
 * The rows with {window, tab} where some source knows them, sorted as
 * placeRows does. io: platform, env, exec, toolDirs (tools.js).
 * opts.askApps lets the AppleScript sources run: an interactive `save` only.
 */
export function captureLayout(rows, io = {}, {askApps = false} = {}) {
  const platform = io.platform ?? process.platform;
  const env = toolEnv(io);
  const run = (argv) => query(io, env, argv[0], argv.slice(1));
  const has = (bin) => onPath(bin, env.PATH);
  const pids = rows.map((r) => r.pid).filter(Number.isInteger);
  const hasPs = has('ps') && pids.length > 0;
  const ps = (flags, field) => (hasPs ? run(['ps', flags, '-o', `pid=,${field}=`, '-p', pids.join(',')]) : '');

  let apps = null;
  const ctx = {
    env: io.env ?? process.env, has,
    askApps: askApps && platform === 'darwin' && hasPs && has('osascript'),
    // pgrep misses GUI apps under a sandbox; ps does not
    running: () => (apps ??= new Set(run(['ps', '-axco', 'comm=']).split('\n').map((c) => c.trim()))),
  };
  const tables = SOURCES.filter((s) => s.when(ctx)).map((s) => s.parse(run(s.argv(ctx))));

  const ttys = parsePsColumns(ps('-ww', 'tty'));
  // $ITERM_SESSION_ID only exists for a process iTerm started: macOS only
  const envs = platform === 'darwin' ? parsePsEnv(ps('-wwE', 'command')) : new Map();
  return placeRows(rows, {ttyOf: (pid) => ttyPath(ttys.get(pid)), tables, envOf: (pid) => envs.get(pid) ?? null});
}
