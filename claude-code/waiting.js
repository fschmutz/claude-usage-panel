// Waiting-on-you I/O: Claude Code's live-session registry plus the
// `<pid>.waiting.json` markers the hooks write next to it. Pure joining,
// age and focus plans live in lib/pure/waiting.js; this file reads the
// registry the same way tabs.js does (dead pids dropped), writes markers
// atomically, and raises the session's terminal through the same layout
// terminals.js / layout.js already know.

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {
  applyHookEvent, focusArgv, focusPlan, hookEffect, hookSessionId, parseWaitingMarker,
  pidFromWaitingMarkerName,
  waitingList, waitingMarkerName, WAITING_MARKER_VERSION,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/waiting.js';
import {focusTab, terminalEnvOf} from './gnome-terminal.js';
import {captureLayout} from './layout.js';
import {sessionRegistryDir} from './paths.js';
import {writePrivate} from './private-fs.js';
import {openTabs} from './tabs.js';

function nowMs(io) {
  return io?.nowMs ? io.nowMs() : Date.now();
}

function envOf(io) {
  return io?.env ?? process.env;
}

function execOf(io) {
  return io?.exec ?? execFileSync;
}

/** Atomic 0600 write of one waiting marker. */
export function writeWaitingMarker(file, marker) {
  writePrivate(file, `${JSON.stringify(marker)}\n`);
}

function markerPath(io, pid) {
  return path.join(sessionRegistryDir(io), waitingMarkerName(pid));
}

function readMarker(file) {
  try {
    return parseWaitingMarker(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function readMarkers(io) {
  const dir = sessionRegistryDir(io);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (pidFromWaitingMarkerName(name) === null)
      continue;
    // unreadable or not JSON: skipped, never thrown - a status line / hook
    // must not die on a half-written marker
    const marker = readMarker(path.join(dir, name));
    if (marker)
      out.push(marker);
  }
  return out;
}

/**
 * Live sessions that are waiting, oldest wait first. Dead pids never appear:
 * openTabs already drops a registry row whose process is gone.
 */
export function listWaiting(io = {}) {
  const sessions = openTabs(io).liveSessions().map((r) => ({
    pid: r.pid,
    sessionId: r.session_id,
    name: r.name,
    cwd: r.cwd,
  }));
  return waitingList(sessions, readMarkers(io), nowMs(io));
}

function pidFromEnv(io) {
  const raw = envOf(io).CLAUDE_PID;
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidForSession(io, sessionId) {
  if (!sessionId)
    return null;
  return openTabs(io).liveSessions().find((r) => r.session_id === sessionId)?.pid ?? null;
}

/**
 * Apply one Claude Code hook payload. Never throws: a hook that crashes is
 * worse than a missed mark. `CLAUDE_PID` names the registry file; without
 * it the live session id is looked up.
 */
export function handleHook(payload, io = {}) {
  try {
    const event = payload?.hook_event_name ?? payload?.hookEventName ?? '';
    if (hookEffect(event) === 'ignore')
      return {action: 'ignore'};
    const sessionId = hookSessionId(payload);
    const pid = pidFromEnv(io) ?? pidForSession(io, sessionId);
    if (!pid)
      return {action: 'ignore'};
    const file = markerPath(io, pid);
    // The marker on disk: a re-mark for the same session and reason keeps
    // its `at`, so the wait does not restart at 0s.
    const decision = applyHookEvent(event, payload ?? {}, nowMs(io), readMarker(file));
    if (decision.action === 'ignore')
      return decision;
    if (decision.action === 'clear') {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      return decision;
    }
    writeWaitingMarker(file, {
      version: WAITING_MARKER_VERSION,
      sessionId,
      pid,
      reason: decision.reason,
      at: decision.at,
    });
    return decision;
  } catch {
    return {action: 'ignore'};
  }
}

function runArgv(argv, io) {
  try {
    execOf(io)(argv[0], argv.slice(1), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000,
      env: envOf(io),
    });
    return true;
  } catch {
    return false;
  }
}

function appleScript(plan) {
  const id = String(plan.id ?? '');
  if (plan.how === 'iterm') {
    return `tell application "iTerm"
  activate
  repeat with w in windows
    if (id of w as string) is ${JSON.stringify(id)} then
      select w
      return
    end if
  end repeat
end tell`;
  }
  return `tell application "Terminal"
  activate
  repeat with w in windows
    if (id of w as string) is ${JSON.stringify(id)} then
      set frontmost of w to true
      return
    end if
  end repeat
end tell`;
}

/**
 * Raise the terminal that holds `row` (pid / session id / name), waiting or
 * not. Uses the same placement sources as `claudectl session save` (tmux,
 * kitty, WezTerm, iTerm, Terminal.app), then the kitty pid match layout.js
 * already uses. A gnome-terminal tab is found through what
 * `claudectl session open` recorded (gnome-terminal.js). false when none of
 * them can.
 */
export function focusSession(row, io = {}) {
  const wantPid = Number.isInteger(row?.pid) ? row.pid : null;
  const wantId = row?.sessionId ?? row?.session_id ?? '';
  const wantName = row?.name ?? '';
  const live = openTabs(io).liveSessions();
  const found = live.find((s) =>
    (wantPid && s.pid === wantPid) || (wantId && s.session_id === wantId)
    || (wantName && s.name === wantName));
  if (!found)
    return false;
  let placed = found;
  try {
    placed = captureLayout([found], io, {askApps: true})[0] ?? found;
  } catch {
    placed = found;
  }
  const plan = focusPlan(placed);
  // not placed by tmux & co, but in a gnome-terminal tab: the tab
  // `claudectl session open` recorded for it
  if (plan.how === 'pid' && terminalEnvOf(found.pid, io).screen) return focusTab(found, live, io);
  if (plan.how === 'iterm' || plan.how === 'terminal')
    return runArgv(['osascript', '-e', appleScript(plan)], io);
  const argv = focusArgv(plan);
  return argv ? runArgv(argv, io) : false;
}
