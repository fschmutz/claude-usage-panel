#!/usr/bin/env node
// The Awake holder: one detached process per session, started by
// `claudectl awake on` (claude-code/awake.js `start`). It is the ONLY thing
// that holds the machine awake, and it holds it the safest way there is - as
// a CHILD process (`caffeinate -i -w <us>` / `systemd-inhibit … sleep <n>`),
// so the kernel gives the assertion back the moment this process goes away,
// SIGKILL included.
//
// Its loop is deliberately boring: every AWAKE_POLL_SECONDS, re-read the live
// sessions, the battery and the thermal state, ask lib/pure/awake.js what to
// do, and do exactly that. It ends on its own deadline, when the last session
// goes away, on a battery or thermal floor, or on SIGTERM from
// `claudectl awake off`.
//
// Every machine change outside the child processes is journaled BEFORE it is
// made and cleared only after its undo succeeded, so scripts/awake-backstop.sh
// can put the machine back from the journal alone if this process never does.

import {spawn} from 'node:child_process';

import {
  AWAKE_POLL_SECONDS, awakeEndReason, awakeFloorActions, awakeInhibitArgv, awakeLidArgv,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {openAwake} from './awake.js';

/** Flags the holder is started with (claude-code/awake.js `start`). */
export function parseWorkerArgs(argv) {
  const out = {seconds: null, whileSessions: false, lid: false};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--seconds') {
      const raw = argv[i + 1];
      const n = raw === undefined || raw === 'none' ? null : Number(raw);
      out.seconds = n !== null && Number.isFinite(n) ? n : null;
      i += 1;
    } else if (argv[i] === '--while-sessions') {
      out.whileSessions = true;
    } else if (argv[i] === '--lid') {
      out.lid = true;
    }
  }
  return out;
}

/** Seconds left on the session, at least one: what a bounded child is given. */
function secondsLeft(session, nowMs) {
  return Math.ceil(Math.max(1000, session.endsAt - nowMs) / 1000);
}

/**
 * Hold the machine awake until something says to stop. Returns the exit code:
 * 0 released cleanly, 1 something could not be undone (the backstop will
 * retry), 3 refused to start because someone else holds it.
 *
 * @param {object} opts  parseWorkerArgs output
 * @param {object} io    the usual shape, plus `sleep`, `pollSeconds` and
 *                       `onCycle` so the tests run the loop without waiting
 */
export async function hold(opts, io = {}) {
  const awake = openAwake(io);
  const sleep = io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const spawnChild = io.spawn ?? spawn;
  const platform = awake.platform();
  const children = [];

  /** Let go of every child: this is what releases the assertion. */
  const stopChildren = () => {
    for (const child of children) {
      try {
        child?.kill?.('SIGTERM');
      } catch {
        // already gone
      }
    }
  };

  const startChild = (argv, what) => {
    if (!argv) return null;
    try {
      const child = spawnChild(argv[0], argv.slice(1), {stdio: 'ignore'});
      child.on?.('error', (e) => awake.log(`${what} failed: ${e.message}`));
      children.push(child);
      return child;
    } catch (e) {
      awake.log(`${what} could not start (${argv[0]}): ${e.message}`);
      return null;
    }
  };

  // ── take the hold under the lock ────────────────────────────────────────
  const taken = awake.withLock(() => {
    const live = awake.liveOwner();
    if (live) return {ok: false, reason: 'already-held', owner: live};
    const session = awake.newSession({
      seconds: opts.seconds,
      whileSessions: opts.whileSessions,
      lid: opts.lid,
      owner: {pid: process.pid, host: awake.host(), kind: io.kind ?? 'cli'},
    });
    // The journal first, with nothing owned yet: a crash between here and the
    // first change leaves a clean journal, which is the truth.
    awake.writeJournal(awake.newJournal({endsAt: session.endsAt, owner: session.owner}));
    awake.writeSession(session);
    return {ok: true, session};
  });
  const start = taken.ok ? taken.value : {ok: false, reason: 'busy'};
  if (!start.ok) {
    awake.log(`refused to start: ${start.reason}${start.owner ? ` (pid ${start.owner.pid})` : ''}`);
    return 3;
  }
  let session = start.session;
  awake.log(`holding until ${new Date(session.endsAt).toISOString()}`
    + `${session.whileSessions ? ' / while sessions run' : ''}${session.lid ? ' / lid' : ''}`);

  // ── the inhibitor child ─────────────────────────────────────────────────
  const inhibitArgv = awakeInhibitArgv(platform, {
    seconds: secondsLeft(session, awake.now()), pid: process.pid,
  });
  let inhibitor = startChild(inhibitArgv, 'inhibitor');
  if (!inhibitArgv)
    awake.log(`no inhibitor for platform ${platform}: the session is bookkeeping only`);

  // ── closed-lid mode: journal first, then change, then read it back ──────
  let lidHeld = false;
  if (session.lid) {
    const locked = awake.withLock(() => {
      if (platform !== 'darwin') {
        // Linux: a logind inhibitor, a child like the one above, so there is
        // nothing persistent to journal and nothing for a backstop to undo.
        const argv = awakeLidArgv(platform, true, {seconds: secondsLeft(session, awake.now())});
        if (!argv) return {ok: false, reason: 'unsupported'};
        return {ok: Boolean(startChild(argv, 'lid inhibitor')), reason: 'command-failed'};
      }
      const journal = awake.readJournal();
      awake.writeJournal({...journal, sleepDisabled: true});
      const r = awake.setLidDisabled(true);
      if (!r.ok) {
        // It did not stick, so nothing is owed. Try the undo anyway in case
        // it half-took, then drop the claim.
        awake.setLidDisabled(false);
        awake.writeJournal({...journal, sleepDisabled: false});
      }
      return r;
    });
    const outcome = locked.ok ? locked.value : {ok: false, reason: 'busy'};
    lidHeld = outcome.ok;
    awake.log(outcome.ok
      ? 'lid mode on'
      : `lid mode NOT on (${outcome.reason}): ${outcome.message ?? ''}`.trim());
  }

  // ── the loop ────────────────────────────────────────────────────────────
  let stopping = null;
  const askStop = (reason) => {
    if (reason && !stopping) stopping = reason;
  };
  process.on('SIGTERM', () => askStop('user'));
  process.on('SIGINT', () => askStop('user'));

  let lowPowerSetByUs = false;
  let unreadableMisses = 0;

  for (;;) {
    session = awake.readSession() ?? session;
    // Another holder took the files over (a second panel, a reinstall): this
    // process is no longer the owner, so it lets go WITHOUT undoing anything
    // the new owner now owns.
    if (session.owner?.pid && session.owner.pid !== process.pid) {
      awake.log(`handed over to pid ${session.owner.pid}`);
      stopChildren();
      return 0;
    }
    const sessions = awake.liveSessions();
    askStop(awakeEndReason(session, {nowMs: awake.now(), sessions}));

    const battery = awake.readBattery();
    unreadableMisses = battery.percent === null && battery.hasBattery ? unreadableMisses + 1 : 0;
    const thermal = awake.readThermal();
    for (const action of awakeFloorActions({
      ...battery, unreadableMisses, thermal, lidClosed: lidHeld, lowPowerSetByUs,
      config: awake.config(),
    })) {
      if (action.action === 'end') {
        askStop(action.reason);
        continue;
      }
      const on = action.action === 'low-power-on';
      const locked = awake.withLock(() => {
        const journal = awake.readJournal();
        // Claim before the change, drop the claim once it is undone - or if
        // it never took.
        if (on) awake.writeJournal({...journal, lowPower: true});
        const r = awake.setLowPower(on);
        if (!r.ok || !on) awake.writeJournal({...journal, lowPower: Boolean(r.ok && on)});
        return r;
      });
      const r = locked.ok ? locked.value : {ok: false, reason: 'busy'};
      if (r.ok || r.reason === 'unsupported') {
        // 'unsupported' is Linux, which has no single Low Power Mode: record
        // the cause as handled so it is not retried every cycle.
        lowPowerSetByUs = on;
        if (r.ok)
          awake.log(`low power ${on ? 'on' : 'off'}${action.cause ? ` (${action.cause})` : ''}`);
      } else {
        awake.log(`low power ${on ? 'on' : 'off'} failed: ${r.reason}`);
      }
    }

    io.onCycle?.({session, sessions, battery, thermal, stopping, lowPowerSetByUs});
    if (stopping) break;
    // An inhibitor that died - killed, or its own sleep expired because the
    // session was extended past it - is restarted: the hold must outlast it.
    if (inhibitArgv && inhibitor && inhibitor.exitCode !== null && inhibitor.exitCode !== undefined) {
      awake.log('inhibitor exited early; restarting it');
      inhibitor = startChild(
        awakeInhibitArgv(platform, {seconds: secondsLeft(session, awake.now()), pid: process.pid}),
        'inhibitor');
    }
    await sleep((io.pollSeconds ?? AWAKE_POLL_SECONDS) * 1000);
  }

  // ── release ─────────────────────────────────────────────────────────────
  stopChildren();
  const released = awake.recover({force: true});
  awake.log(`ended (${stopping})${released.failed.length
    ? ` - COULD NOT UNDO ${released.failed.join(', ')}` : ''}`);
  return released.failed.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('awake-worker.js')) {
  hold(parseWorkerArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    () => process.exit(1));
}
