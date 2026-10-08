// `claudectl session pause | resume | report | pause-status`: send the pause
// (or resume) protocol to the live Claude Code sessions and show, per
// session, whether it was delivered and what it answered. session-cli.js
// dispatches here; the store is pause.js, the shapes and texts
// lib/pure/pause.js, the reopen of a session that is no longer running
// tabs.js (the same path `claudectl session open` takes).

import fs from 'node:fs';
import os from 'node:os';

import {cleanPauseText, pauseExitCode, PAUSE_REASON_MAX} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pause.js';
import {formatClock} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pings.js';
import {openPause} from './pause.js';
import {describeLaunch, resumePrompt} from './tabs.js';

export const PAUSE_COMMANDS = new Set(['pause', 'resume', 'report', 'pause-status']);

export const PAUSE_HELP = `
  claudectl session pause [NAME...|--all] [--wait[=S]|--no-wait] [--json]
                                             send the pause protocol; wait (180 s)
                                             for each verdict; exit 0 all SAFE, 3 not,
                                             4 when a newer request replaced it
  claudectl session resume [NAME...|--all] [--wait[=S]|--no-wait] [--dry-run]
                                             every session paused and not resumed
                                             since (whichever request paused it):
                                             running: send the resume protocol;
                                             closed with a checkpoint: reopen it
  claudectl session pause-status [--json]    the last request, one row per session
  claudectl session report --request ID --verdict SAFE|NOT_SAFE
                         [--checkpoint P] [--reason TEXT|--reason-file F|-]
                         [--session ID]
                                             what a paused session runs to answer

Pause needs \`./install.sh pause\`: a background hook wakes an idle session
with the request, a tool call of a busy one is held back once to hand it
over. NAME is a session name, pid or session-id prefix; --all skips the
session you run it from (--include-self keeps it). Run from inside a Claude
Code session, the request says so, and each session asks you first.`;

const DEFAULT_WAIT_S = 180;
// `--wait` takes its value only as --wait=S: `pause --wait API` names API.
const VALUE_FLAGS = new Set(['request', 'verdict', 'checkpoint', 'reason', 'reason-file', 'session', 'from', 'terminal']);
/** `--from`, internal to the panels (they pass gnome / macos); not in HELP. */
const FLAG_SOURCES = new Set(['cli', 'gnome', 'macos']);
/** Exit status of a `--wait` whose request a newer one replaced. */
const EXIT_SUPERSEDED = 4;

/** `--k=v`, `--k v` (value flags only) and bare `--k`. */
function parseArgs(argv) {
  const args = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args.push(a);
      continue;
    }
    const [k, ...v] = a.slice(2).split('=');
    if (v.length) opts[k] = v.join('=');
    else if (VALUE_FLAGS.has(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
    else opts[k] = true;
  }
  return {args, opts};
}

function waitSeconds(opts) {
  if (opts['no-wait']) return 0;
  if (typeof opts.wait === 'string') {
    if (!/^\d+$/.test(opts.wait)) throw new Error('--wait takes whole seconds');
    return Number(opts.wait);
  }
  return DEFAULT_WAIT_S;
}

/** Live rows named by NAME... (name, pid or session-id prefix), or --all. */
function pick(live, names, {all, self, noun = 'running session'}) {
  if (all) return live.filter((r) => r.pid !== self);
  if (!names.length) throw new Error('name the sessions (NAME...) or pass --all');
  return names.map((key) => {
    const exact = live.filter((r) => String(r.pid) === key || r.session_id === key);
    const hits = exact.length ? exact : live.filter((r) => r.name === key || (key.length >= 4 && r.session_id.startsWith(key)));
    if (!hits.length) throw new Error(`no ${noun} named ${key}`);
    if (hits.length > 1) throw new Error(`${key} is ambiguous (${hits.map((r) => r.pid).join(', ')}) - pass the pid`);
    return hits[0];
  }).filter((r, i, list) => list.findIndex((x) => x.session_id === r.session_id) === i);
}

/**
 * Who is sending: `--from` (the panels), else cli - unless claudectl runs
 * inside a Claude Code session (its Bash tool sets CLAUDECODE / CLAUDE_PID,
 * or a claude is an ancestor). Then it is `session`, with that session's id,
 * whatever the flag says: a model must not be able to pass for a panel
 * click, and every receiving session is told to ask the user first.
 */
function sender(pause, opts, io, live) {
  const flag = opts.from === undefined ? 'cli' : opts.from;
  if (typeof flag !== 'string' || !FLAG_SOURCES.has(flag)) {
    throw new Error(`--from takes ${[...FLAG_SOURCES].join(', ')}, not ${JSON.stringify(flag)}`);
  }
  const env = io.env ?? process.env;
  const self = pause.tabs.selfPid(live);
  const inSession = env.CLAUDECODE === '1' || Number(env.CLAUDE_PID) > 0 || self !== null;
  if (!inSession) return {from: flag, origin: null};
  if (flag !== 'cli') throw new Error(`--from=${flag} is for the panels; this runs inside a Claude Code session`);
  const origin = live.find((r) => r.pid === self)?.session_id ??
    env.CLAUDE_CODE_SESSION_ID ?? pause.tabs.sessionOfPid(Number(env.CLAUDE_PID))?.session_id ?? null;
  return {from: 'session', origin};
}

function printTable(out, {request, rows, summary}) {
  if (!request) {
    out('no pause request yet\n');
    return;
  }
  out(`${request.kind} ${request.id}  sent ${formatClock(request.at)} from ${request.from}: ${summary.label}\n`);
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  out(`  ${'NAME'.padEnd(w)}  SESSION   STATE\n`);
  for (const r of rows) out(`  ${r.name.padEnd(w)}  ${r.sessionId.slice(0, 8)}  ${r.label}\n`);
}

/** Poll the request until every row is terminal or `seconds` pass,
 *  printing each row whose state moved (text mode). */
async function follow(pause, request, seconds, io, {json, out}) {
  const now = () => (io.nowMs ? io.nowMs() : Date.now());
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + seconds * 1000;
  const seen = new Map();
  for (;;) {
    // A newer request (a panel click, another claudectl) replaced this one:
    // its records now answer that one, so following on would only report
    // false "no waiter" rows.
    const current = pause.readRequest();
    if (current && current.id !== request.id) {
      if (!json) out(`superseded by ${current.kind} ${current.id} from ${current.from}\n`);
      return {...pause.status(request), superseded: current};
    }
    const st = pause.status(request);
    if (!json) {
      for (const r of st.rows) {
        if (seen.get(r.sessionId) === r.label) continue;
        seen.set(r.sessionId, r.label);
        out(`  ${r.name}: ${r.label}\n`);
      }
    }
    if (st.summary.done || now() >= deadline) return st;
    await sleep(1000);
  }
}

async function sendAndFollow(pause, kind, rows, opts, io, out, who) {
  const request = pause.sendRequest({kind, rows, ...who});
  const json = Boolean(opts.json);
  const seconds = waitSeconds(opts);
  if (!json) out(`${kind} ${request.id} sent to ${rows.map((r) => r.name).join(', ')}\n`);
  const st = seconds ? await follow(pause, request, seconds, io, {json, out}) : pause.status(request);
  if (json) out(`${JSON.stringify(st, null, 2)}\n`);
  else {
    printTable(out, st);
    if (seconds && !st.summary.done && !st.superseded) {
      out(`still open after ${seconds}s - \`claudectl session pause-status\` follows up\n`);
    }
  }
  return st;
}

async function pauseCmd(pause, args, opts, io, out) {
  const live = pause.tabs.liveSessions();
  const self = opts['include-self'] ? null : pause.tabs.selfPid(live);
  const who = sender(pause, opts, io, live);
  const rows = pick(live, args, {all: Boolean(opts.all), self});
  if (!rows.length) throw new Error('no running Claude Code session to pause');
  const st = await sendAndFollow(pause, 'pause', rows, opts, io, out, who);
  if (st.superseded) return EXIT_SUPERSEDED;
  return waitSeconds(opts) ? pauseExitCode(st.summary) : 0;
}

/** A closed session to reopen: the name and cwd known.json kept from the
 *  request that paused it, else the newest snapshot holding the id. */
function closedRow(pause, sessionId, known) {
  const k = known.get(sessionId);
  if (k?.cwd) return {name: k.name || sessionId.slice(0, 8), cwd: k.cwd, session_id: sessionId};
  for (const snap of pause.tabs.snapshots()) {
    const row = snap.sessions.find((r) => r.session_id === sessionId);
    if (row) return {name: row.name, cwd: row.cwd, session_id: sessionId};
  }
  return null;
}

async function resumeCmd(pause, args, opts, io, out) {
  const live = pause.tabs.liveSessions();
  const who = sender(pause, opts, io, live);
  const liveIds = new Map(live.map((r) => [r.session_id, r]));
  const known = pause.readKnown();
  // Store state, not the last request: a per-session Pause or a resume sent
  // since must not hide a session an earlier "Pause all" stopped.
  const paused = pause.pausedSessions();
  let ids;
  if (opts.all) {
    ids = paused;
  } else {
    if (!args.length) throw new Error('name the sessions (NAME...) or pass --all');
    const candidates = [...live, ...paused.filter((sid) => !liveIds.has(sid))
      .map((sid) => ({name: known.get(sid)?.name || sid.slice(0, 8), session_id: sid, pid: null}))];
    ids = pick(candidates, args, {all: false, noun: 'running or paused session'}).map((r) => r.session_id);
  }
  const running = ids.filter((id) => liveIds.has(id)).map((id) => liveIds.get(id));
  const closed = [];
  for (const id of ids.filter((x) => !liveIds.has(x))) {
    const row = pause.pendingCheckpoint(id, known.get(id)?.cwd ?? null) ? closedRow(pause, id, known) : null;
    if (row) closed.push(row);
    else out(`skip ${id.slice(0, 8)}: not running and no pending checkpoint (\`claudectl session open\` reopens it)\n`);
  }
  if (!running.length && !closed.length) throw new Error('nothing to resume');
  const dryRun = Boolean(opts['dry-run']);
  let code = 0;
  if (closed.length) {
    const {open, skipped} = pause.tabs.plan({sessions: closed});
    for (const {row, why} of skipped) out(`skip ${row.name}: ${why}\n`);
    if (open.length) {
      const nowMs = io.nowMs ? io.nowMs() : Date.now();
      const peers = [...open, ...live];
      // "paused at" is this session's own pause, not the last request's time
      const prompt = (row) => resumePrompt({
        label: null, savedAt: pause.pausedAt(row.session_id) ?? nowMs, nowMs, peers,
        homedir: io.homedir ?? os.homedir(), checkpoint: pause.pendingCheckpoint(row.session_id, row.cwd),
      });
      const r = pause.tabs.launch(open, {terminal: typeof opts.terminal === 'string' ? opts.terminal : undefined, prompt, dryRun});
      if (!dryRun) for (const row of open) pause.markResumed(row.session_id);
      for (const row of open) out(`reopen ${row.name} ${row.session_id.slice(0, 8)} with its checkpoint\n`);
      if (dryRun) for (const st of r.steps) out(`${st.cmd} ${st.args.map((x) => JSON.stringify(x)).join(' ')}\n`);
      out(`${describeLaunch(r, open.length)}\n`);
    }
    if (skipped.length) code = 3;
  }
  if (running.length && dryRun) {
    for (const r of running) out(`would send resume to ${r.name} ${r.session_id.slice(0, 8)}\n`);
  } else if (running.length) {
    const st = await sendAndFollow(pause, 'resume', running, opts, io, out, who);
    if (st.superseded) code = EXIT_SUPERSEDED;
    else if (waitSeconds(opts) && !st.summary.ok) code = 3;
  }
  return code;
}

function sessionFromEnv(pause, io) {
  const env = io.env ?? process.env;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  return pause.tabs.sessionOfPid(Number(env.CLAUDE_PID))?.session_id ?? null;
}

/** --reason TEXT, or --reason-file PATH / - (stdin): a reason holding
 *  quotes never goes through shell quoting. Cut like the stored record. */
function reasonOf(opts, io) {
  if (typeof opts['reason-file'] === 'string') {
    const f = opts['reason-file'];
    const text = f === '-' ? (io.readStdin ?? (() => fs.readFileSync(0, 'utf8')))() : fs.readFileSync(f, 'utf8');
    return cleanPauseText(text.trim(), PAUSE_REASON_MAX);
  }
  return typeof opts.reason === 'string' ? opts.reason : null;
}

function reportCmd(pause, opts, io, out) {
  const sessionId = typeof opts.session === 'string' ? opts.session : sessionFromEnv(pause, io);
  if (!sessionId) throw new Error('report: no session id (--session ID, or run it from the Claude Code session)');
  if (typeof opts.request !== 'string') throw new Error('report needs --request ID');
  const verdict = String(opts.verdict ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  const checkpoint = typeof opts.checkpoint === 'string' ? opts.checkpoint : null;
  const reason = reasonOf(opts, io);
  const rec = pause.report({sessionId, requestId: opts.request, verdict, reason, checkpoint});
  const current = pause.readRequest();
  out(`recorded ${rec.verdict} for ${sessionId.slice(0, 8)} on request ${rec.requestId}\n`);
  if (current && current.id !== rec.requestId) out(`note: the current request is ${current.id}; this verdict answers an older one\n`);
  return 0;
}

/** Run one of PAUSE_COMMANDS; `argv` is everything after it. */
export async function runPause(cmd, argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const pause = openPause(io);
  const {args, opts} = parseArgs(argv);
  switch (cmd) {
    case 'pause':
      return pauseCmd(pause, args, opts, io, out);
    case 'resume':
      return resumeCmd(pause, args, opts, io, out);
    case 'report':
      return reportCmd(pause, opts, io, out);
    default: {
      const st = pause.status();
      if (opts.json) out(`${JSON.stringify(st, null, 2)}\n`);
      else printTable(out, st);
      return 0;
    }
  }
}
