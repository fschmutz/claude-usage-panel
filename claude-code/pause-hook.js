#!/usr/bin/env node
// Claude Code hook for `claudectl session pause` / `resume`. Wired by
// `./install.sh pause` (scripts/install/pause.sh) into ~/.claude/settings.json:
//
//   pause-hook.js wait     SessionStart + Stop, asyncRewake: a background
//                          waiter. When a request names this session and it
//                          was not delivered yet, it claims the delivery,
//                          prints the protocol on stderr and exits 2: Claude
//                          Code wakes the model with it, idle or not.
//   pause-hook.js pretool  PreToolUse backstop: a session without a waiter
//                          (started before the install) gets the request by
//                          one denied tool call, the protocol as the reason.
//
// What the probe of Claude Code 2.1.29x established, and this file obeys:
// exit 2 + stderr is the only thing that wakes the model (exit 0 is silent);
// Stop starts a new waiter after EVERY turn without cancelling the old one,
// so one live waiter per session (a lock) and exactly-once delivery (the
// claim in pause.js) are what stop a wake loop; /clear keeps the old waiter
// running under a new session id, so the registry's sessionId is re-checked;
// a crash of claude orphans the waiter, so CLAUDE_PID is polled (with its
// start time: a recycled pid is not our claude); the hook is killed at its
// `timeout`, so the waiter leaves on its own just before. A request names
// session ids, and both hooks pass CLAUDE_PID to the claim, so a process
// that reopened the id later does not take a request sent to the old one.
//
// Never throws: a crashing hook is worse than a missed delivery.

import fs from 'node:fs';
import {clearInterval, setInterval} from 'node:timers';
import {fileURLToPath} from 'node:url';

import {
  pauseDenyOutput, pretoolEligible, isPauseSessionId, PAUSE_HOOK_TIMEOUT_S,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';
import {openPause} from './pause.js';

/** How often the waiter re-checks without an fs event (and its session). */
const POLL_MS = 15_000;
/** File events arriving within this window are one check. */
const DEBOUNCE_MS = 250;
/** How long one answer of "is our session still ours" is reused where the
 *  check spawns `ps` (no /proc); on Linux it is two small reads. */
const OURS_TTL_MS = 5_000;
/** Leave a minute before Claude Code's kill, so the lock goes with us. */
const WAIT_MAX_MS = (PAUSE_HOOK_TIMEOUT_S - 60) * 1000;

function sessionOf(payload) {
  const id = payload?.session_id ?? payload?.sessionId;
  return isPauseSessionId(id) ? id : null;
}

function claudePid(env) {
  const pid = Number(env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The PreToolUse backstop. Returns the stdout object (a deny) or null.
 * Fast path first: no request file, nothing to read.
 */
export function handlePretool(payload, io = {}) {
  try {
    if (!pretoolEligible(payload)) return null;
    const pause = openPause(io);
    const request = pause.readRequest();
    if (!request) return null;
    const sid = sessionOf(payload);
    if (!pause.claim(sid, request, 'pretooluse', {pid: claudePid(io.env ?? process.env)})) return null;
    return pauseDenyOutput(pause.deliveryText(sid, request, 'pretooluse'));
  } catch {
    return null;
  }
}

/**
 * The asyncRewake waiter. Returns {done, stop}: `done` resolves {code,
 * text} - 2 with the protocol text when it delivered, 0 otherwise - and
 * `stop()` ends it at once with 0 (the lock released). io: env, pollMs,
 * maxMs, pid, pidAlive, plus everything openPause(io) takes.
 */
export function startWaiter(payload, io = {}) {
  let finish = () => {};
  const done = new Promise((resolve) => {
    let release = null;
    let watcher = null;
    let timer = null;
    let deadline = null;
    let finished = false;
    let stopDebounce = () => {};
    finish = (code, text = '') => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      stopDebounce();
      clearTimeout(deadline);
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      try {
        release?.();
      } catch {
        // a lock left behind is stale once this pid is gone
      }
      resolve({code, text});
    };
    try {
      const sid = sessionOf(payload);
      if (!sid || payload?.agent_id !== undefined) return finish(0);
      const owner = claudePid(io.env ?? process.env);
      const pause = openPause(io);
      release = pause.acquireWaiter(sid);
      if (!release) return finish(0); // another live waiter serves this session

      // Our session still runs, under our id: a crashed claude orphans us,
      // and /clear moves the live session to a new id with a waiter of its
      // own. No registry file yet (early SessionStart): the pid, checked
      // against the start time it had when we armed (a recycled pid has
      // another); once the registry named it, its entry going away means
      // the session ended. On macOS the registry check spawns `ps`, so it
      // runs at most once per OURS_TTL_MS whatever the event rate.
      const ownerStart = owner ? pause.tabs.procStart(owner) : null;
      let sawRegistry = false;
      let oursAt = -Infinity;
      let oursLast = true;
      const oursTtl = io.oursTtlMs ?? ((io.platform ?? process.platform) === 'linux' ? 0 : OURS_TTL_MS);
      const ours = () => {
        if (!owner) return true;
        if (Date.now() - oursAt < oursTtl) return oursLast;
        oursAt = Date.now();
        const reg = pause.tabs.sessionOfPid(owner);
        if (reg) {
          sawRegistry = true;
          oursLast = reg.session_id === sid;
        } else {
          oursLast = !sawRegistry && pause.pidAlive(owner) &&
            (ownerStart === null || pause.tabs.procStart(owner) === ownerStart);
        }
        return oursLast;
      };
      const check = () => {
        if (finished) return;
        try {
          if (!ours()) return finish(0);
          const request = pause.readRequest();
          if (request && pause.claim(sid, request, 'rewake', {pid: owner})) {
            finish(2, pause.deliveryText(sid, request, 'rewake'));
          }
        } catch {
          // a half-written file: the next event or poll reads it whole
        }
        return undefined;
      };
      // Every claim, delivery and verdict write lands in this directory:
      // only request.json can owe us a delivery, and a burst of events
      // collapses into one check.
      let debounce = null;
      const onEvent = (_event, name) => {
        if (name && name !== 'request.json') return;
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          check();
        }, io.debounceMs ?? DEBOUNCE_MS);
      };
      stopDebounce = () => clearTimeout(debounce);
      try {
        watcher = fs.watch(pause.dir(), {persistent: true}, onEvent);
        watcher.on('error', () => {});
      } catch {
        watcher = null; // the poll still runs
      }
      timer = setInterval(check, io.pollMs ?? POLL_MS);
      deadline = setTimeout(() => finish(0), io.maxMs ?? WAIT_MAX_MS);
      check();
    } catch {
      finish(0);
    }
    return undefined;
  });
  return {done, stop: () => finish(0)};
}

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

async function main(mode) {
  const payload = readStdin();
  if (mode === 'pretool') {
    const out = handlePretool(payload);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (mode !== 'wait') return 0;
  const waiter = startWaiter(payload);
  // Claude Code ends a session's hooks with SIGTERM: leave quietly, lock released.
  process.once('SIGTERM', waiter.stop);
  process.once('SIGHUP', waiter.stop);
  const {code, text} = await waiter.done;
  if (code === 2) process.stderr.write(text);
  return code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then((code) => process.exit(code), () => process.exit(0));
}
