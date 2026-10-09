// gnome-terminal tabs. gnome-terminal gives no way to list its tabs or to ask
// which window holds a session, so `claudectl session open` records it: the
// windows it created (the D-Bus paths that appeared), and the sessions of
// each in tab order. Focus then selects that tab through the window's
// `active-tab` action and asks the GNOME extension (it alone may raise a
// window on Wayland) to bring the window up. A session not opened by
// claudectl, or a tab dragged to another position, cannot be found: focus
// says so instead of raising the wrong tab.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {gnomeTabsPath} from './paths.js';
import {writePrivate} from './private-fs.js';

const DEST = 'org.gnome.Terminal';
const WINDOWS = '/org/gnome/Terminal/window';
const WINDOW_RE = /^\/org\/gnome\/Terminal\/window\/\d+$/;
/** What the GNOME extension exports on the Shell's own bus connection. */
export const RAISE = {
  dest: 'org.gnome.Shell',
  path: '/io/github/fschmutz/ClaudeUsagePanel',
  method: 'io.github.fschmutz.ClaudeUsagePanel.RaiseWindow',
};
/** Windows gone or from an older gnome-terminal server are dropped; this
 *  caps what is left. */
const KEEP_WINDOWS = 20;

function gdbus(io, args) {
  try {
    return String((io.exec ?? execFileSync)('gdbus', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, env: io.env ?? process.env,
    }));
  } catch {
    return null;
  }
}

/** Every gnome-terminal window's D-Bus path, oldest first. */
export function terminalWindows(io = {}) {
  const out = gdbus(io, ['introspect', '--session', '--dest', DEST, '--object-path', WINDOWS]) ?? '';
  return [...out.matchAll(/^\s*node (\d+) \{/gm)].map((m) => Number(m[1]))
    .sort((a, b) => a - b).map((n) => `${WINDOWS}/${n}`);
}

/** The unique bus name serving org.gnome.Terminal: window paths restart
 *  at 1 with a new server, so a record is only good for the one it names. */
function terminalService(io) {
  const out = gdbus(io, ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
    '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetNameOwner', DEST]) ?? '';
  return /'(:[\d.]+)'/.exec(out)?.[1] ?? null;
}

/** A screen (one tab's terminal) still exists: a closed one introspects as
 *  an empty node. */
function screenAlive(io, screen) {
  const out = gdbus(io, ['introspect', '--session', '--dest', DEST, '--object-path', screen]);
  return out === null ? null : /\binterface\b/.test(out);
}

/** The gnome-terminal tab a process runs in, from its environment. */
export function terminalEnvOf(pid, io = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(io.procDir ?? '/proc', String(pid), 'environ'), 'utf8');
  } catch {
    return {};
  }
  const env = Object.fromEntries(raw.split('\0').filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  return {screen: env.GNOME_TERMINAL_SCREEN ?? null, service: env.GNOME_TERMINAL_SERVICE ?? null};
}

function load(io) {
  try {
    const r = JSON.parse(fs.readFileSync(gnomeTabsPath(io), 'utf8'));
    return r && typeof r.windows === 'object' ? r : {version: 1, windows: {}};
  } catch {
    return {version: 1, windows: {}};
  }
}

function store(io, record) {
  const entries = Object.entries(record.windows).sort(([, a], [, b]) => b.at - a.at).slice(0, KEEP_WINDOWS);
  writePrivate(gnomeTabsPath(io), `${JSON.stringify({version: 1, windows: Object.fromEntries(entries)}, null, 2)}\n`);
}

/**
 * After `open` launched `groups` (one array of rows per window, in launch
 * order) into gnome-terminal: wait for its new windows and record which
 * sessions each holds, in tab order. Returns how many windows it recorded;
 * 0 when they did not show up in time (focus then cannot find them).
 */
export async function recordTabs({before, groups, io = {}, timeoutMs = 5000, stepMs = 200}) {
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const known = new Set(before);
  let fresh = [];
  for (let waited = 0; ; waited += stepMs) {
    const now = terminalWindows(io);
    fresh = now.filter((w) => !known.has(w));
    if (fresh.length >= groups.length || waited >= timeoutMs) {
      const service = terminalService(io);
      if (!service || !fresh.length) return 0;
      const record = load(io);
      const alive = new Set(now);
      for (const [w, rec] of Object.entries(record.windows)) {
        if (rec.service !== service || !alive.has(w)) delete record.windows[w];
      }
      const at = io.nowMs ? io.nowMs() : Date.now();
      // gnome-terminal opens the --window groups of one command in order
      fresh.slice(0, groups.length).forEach((w, i) => {
        record.windows[w] = {service, at, tabs: groups[i].map((r) => ({session_id: r.session_id}))};
      });
      store(io, record);
      return Math.min(fresh.length, groups.length);
    }
    await sleep(stepMs);
  }
}

/**
 * Select `row`'s tab and raise its window. `live`: the running sessions
 * (pid + session_id), to learn the tab of each recorded session. false when
 * the session is not in a recorded window of the running gnome-terminal, or
 * the extension is not there to raise it.
 */
export function focusTab(row, live, io = {}) {
  const env = terminalEnvOf(row.pid, io);
  if (!env.screen || !env.service) return false;
  const record = load(io);
  const hit = Object.entries(record.windows).find(([w, rec]) => WINDOW_RE.test(w)
    && rec.service === env.service && rec.tabs?.some((t) => t.session_id === row.session_id));
  if (!hit) return false;
  const [window, rec] = hit;
  const pidOf = new Map(live.map((s) => [s.session_id, s.pid]));
  // A tab closed before ours moved ours one to the left. A tab is closed when
  // the screen it last ran in is gone; a session never seen running is
  // assumed still there (its tab keeps a shell after claude exits).
  let index = 0;
  for (const t of rec.tabs) {
    if (t.session_id === row.session_id) {
      t.screen = env.screen;
      break;
    }
    const pid = pidOf.get(t.session_id);
    if (pid) t.screen = terminalEnvOf(pid, io).screen ?? t.screen;
    if (!t.screen || screenAlive(io, t.screen) !== false) index++;
  }
  store(io, record);
  if (gdbus(io, ['call', '--session', '--dest', DEST, '--object-path', window,
    '--method', 'org.gtk.Actions.SetState', 'active-tab', `<${index}>`, '{}']) === null) return false;
  const raised = gdbus(io, ['call', '--session', '--dest', RAISE.dest, '--object-path', RAISE.path,
    '--method', RAISE.method, env.service, window]);
  return /\btrue\b/.test(raised ?? '');
}
