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
// A headless session (`claude -p`, the SDK) gets no waiter: print mode waits
// for its SessionStart hooks, so a waiter there hangs the run until Claude
// Code gives up ("No messages returned from query"). Claude Code marks it
// CLAUDE_CODE_SESSION_ATTENDED=0 and an `sdk-*` CLAUDE_CODE_ENTRYPOINT.
//
// Never throws: a crashing hook is worse than a missed delivery.

import fs from 'node:fs';
import {clearInterval, setInterval} from 'node:timers';

import {
  pauseDenyOutput, pretoolEligible, isPauseSessionId, PAUSE_HOOK_TIMEOUT_S, waiterOwnership,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';
import {openPause} from './pause.js';
import {isMain} from './is-main.js';

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

/** True for a session nobody sits at: print mode, the Agent SDK. */
export function unattended(env) {
  return env.CLAUDE_CODE_SESSION_ATTENDED === '0' || /^sdk-/.test(env.CLAUDE_CODE_ENTRYPOINT ?? '');
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

/** One waiter's lifecycle: `finish` runs every cleanup registered with
 *  `onFinish`, newest first, exactly once, then resolves `done`. */
function lifecycle() {
  let resolve = () => {};
  const done = new Promise((r) => {
    resolve = r;
  });
  const cleanups = [];
  let finished = false;
  return {
    done,
    isFinished: () => finished,
    onFinish(fn) {
      cleanups.push(fn);
    },
    finish(code, text = '') {
      if (finished) return;
      finished = true;
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          // best effort: a lock left behind is stale once this pid is gone
        }
      }
      resolve({code, text});
    },
  };
}

/**
 * "Is our session still ours" for this waiter, as a function to call on every
 * check: the decision is lib/pure/pause.js waiterOwnership, this only gathers
 * what it reads. On macOS the registry read spawns `ps`, so one answer is
 * reused for OURS_TTL_MS whatever the event rate; on Linux it is two reads.
 */
function ownership(pause, sessionId, owner, io) {
  if (!owner) return () => true;
  const armedStart = pause.registry.procStart(owner);
  const ttl = io.oursTtlMs ?? ((io.platform ?? process.platform) === 'linux' ? 0 : OURS_TTL_MS);
  let sawRegistry = false;
  let at = -Infinity;
  let last = true;
  return () => {
    if (Date.now() - at < ttl) return last;
    at = Date.now();
    const registry = pause.registry.sessionOfPid(owner);
    const alive = !registry && !sawRegistry && pause.pidAlive(owner);
    const verdict = waiterOwnership({
      sessionId, owner, registry, sawRegistry, alive, armedStart,
      start: alive && armedStart !== null ? pause.registry.procStart(owner) : null,
    });
    sawRegistry = verdict.sawRegistry;
    last = verdict.ours;
    return last;
  };
}

/** Watch the pause dir for request.json, collapsing a burst of events into
 *  one check. Every claim, delivery and verdict write lands there too: only
 *  request.json can owe us a delivery. */
function watchRequests(pause, waiter, check, debounceMs) {
  let debounce = null;
  waiter.onFinish(() => clearTimeout(debounce));
  try {
    const watcher = fs.watch(pause.dir(), {persistent: true}, (_event, name) => {
      if ((name && name !== 'request.json') || debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        check();
      }, debounceMs);
    });
    watcher.on('error', () => {});
    waiter.onFinish(() => watcher.close());
  } catch {
    // no watcher: the poll still runs
  }
}

/**
 * The asyncRewake waiter. Returns {done, stop}: `done` resolves {code,
 * text} - 2 with the protocol text when it delivered, 0 otherwise - and
 * `stop()` ends it at once with 0 (the lock released). io: env, pollMs,
 * maxMs, pid, pidAlive, plus everything openPause(io) takes.
 */
export function startWaiter(payload, io = {}) {
  const waiter = lifecycle();
  try {
    const sid = sessionOf(payload);
    const env = io.env ?? process.env;
    if (!sid || payload?.agent_id !== undefined || unattended(env)) {
      waiter.finish(0);
    } else {
      const pause = openPause(io);
      const release = pause.acquireWaiter(sid);
      if (!release) {
        waiter.finish(0); // another live waiter serves this session
      } else {
        waiter.onFinish(release);
        arm(waiter, pause, sid, claudePid(env), io);
      }
    }
  } catch {
    waiter.finish(0);
  }
  return {done: waiter.done, stop: () => waiter.finish(0)};
}

/** Check now, on every request.json event, every pollMs, and leave at maxMs. */
function arm(waiter, pause, sid, owner, io) {
  const ours = ownership(pause, sid, owner, io);
  const check = () => {
    if (waiter.isFinished()) return;
    try {
      if (!ours()) {
        waiter.finish(0);
        return;
      }
      const request = pause.readRequest();
      if (request && pause.claim(sid, request, 'rewake', {pid: owner})) {
        waiter.finish(2, pause.deliveryText(sid, request, 'rewake'));
      }
    } catch {
      // a half-written file: the next event or poll reads it whole
    }
  };
  watchRequests(pause, waiter, check, io.debounceMs ?? DEBOUNCE_MS);
  const timer = setInterval(check, io.pollMs ?? POLL_MS);
  waiter.onFinish(() => clearInterval(timer));
  const deadline = setTimeout(() => waiter.finish(0), io.maxMs ?? WAIT_MAX_MS);
  waiter.onFinish(() => clearTimeout(deadline));
  check();
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
  // Claude Code ends a session's hooks with SIGTERM: leave quietly, lock
  // released. Armed BEFORE startWaiter takes the lock: a signal landing
  // between the two would otherwise kill us the default way, lock left behind.
  // A signal is only delivered once this synchronous code has run, so
  // `waiter` is always set by then.
  let waiter = null;
  const stop = () => waiter?.stop();
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop);
  waiter = startWaiter(payload);
  const {code, text} = await waiter.done;
  if (code === 2) process.stderr.write(text);
  return code;
}

if (isMain(import.meta.url)) {
  main(process.argv[2]).then((code) => process.exit(code), () => process.exit(0));
}
