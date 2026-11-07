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
// made and cleared only after its undo succeeded (claude-code/awake.js
// `journaledChange`), so scripts/awake-backstop.sh can put the machine back
// from the journal alone if this process never does.
//
// One function per phase: take the hold, closed-lid mode, one poll cycle,
// release.

import {spawn} from 'node:child_process';

import {
  AWAKE_POLL_SECONDS, awakeEndReason, awakeFloorActions,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {
  awakeInhibitArgv, awakeLidArgv,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake-power.js';
import {openAwake} from './awake.js';
import {isMain} from './is-main.js';

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

/** The child processes this holder owns. Letting go of them is what releases
 *  the assertion. */
function childPool(awake, spawnChild) {
  const children = [];
  return {
    start(argv, what) {
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
    },
    stopAll() {
      for (const child of children) {
        try {
          child?.kill?.('SIGTERM');
        } catch {
          // already gone
        }
      }
    },
  };
}

/** Take the hold under the lock: refused while someone else holds it. The
 *  journal goes first, with nothing owned yet - a crash between here and the
 *  first change leaves a clean journal, which is the truth. */
function take(awake, opts, kind) {
  return awake.underLock(() => {
    const live = awake.liveOwner();
    if (live) return {ok: false, reason: 'already-held', owner: live};
    const session = awake.newSession({
      seconds: opts.seconds,
      whileSessions: opts.whileSessions,
      lid: opts.lid,
      owner: {pid: process.pid, host: awake.host(), kind},
    });
    awake.writeJournal(awake.newJournal({endsAt: session.endsAt, owner: session.owner}));
    awake.writeSession(session);
    return {ok: true, session};
  });
}

/** Closed-lid mode. Linux: a logind inhibitor, a child like the idle one, so
 *  there is nothing persistent to journal. macOS: `pmset -a disablesleep 1`,
 *  journaled first, read back, and taken back if it did not stick. */
function lid(awake, session, children) {
  const platform = awake.platform();
  if (platform !== 'darwin') {
    const argv = awakeLidArgv(platform, true, {seconds: secondsLeft(session, awake.now())});
    if (!argv) return {ok: false, reason: 'unsupported'};
    return children.start(argv, 'lid inhibitor') ? {ok: true} : {ok: false, reason: 'command-failed'};
  }
  return awake.journaledChange('sleepDisabled', true, () => awake.setLidDisabled(true),
    {undo: () => awake.setLidDisabled(false)});
}

/** Low Power Mode on or off, as a floor action asked. */
function lowPower(awake, state, {action, cause}) {
  const on = action === 'low-power-on';
  const r = awake.journaledChange('lowPower', on, () => awake.setLowPower(on));
  if (r.ok || r.reason === 'unsupported') {
    // 'unsupported' is Linux, which has no single Low Power Mode: record the
    // cause as handled so it is not retried every cycle.
    state.lowPowerSetByUs = on;
    if (r.ok) awake.log(`low power ${on ? 'on' : 'off'}${cause ? ` (${cause})` : ''}`);
  } else {
    awake.log(`low power ${on ? 'on' : 'off'} failed: ${r.reason}`);
  }
}

/**
 * One poll: re-read the session, the live sessions, the battery and the
 * thermal state, and act on what the floors say. Returns what it read, or
 * 'handed-over' when another holder took the files over (a second panel, a
 * reinstall): this process is then no longer the owner and must let go
 * WITHOUT undoing anything the new owner now owns.
 */
function cycle(awake, state) {
  state.session = awake.readSession() ?? state.session;
  const {session} = state;
  if (session.owner?.pid && session.owner.pid !== process.pid) return 'handed-over';
  const sessions = awake.liveSessions();
  state.ask(awakeEndReason(session, {nowMs: awake.now(), sessions}));

  const battery = awake.readBattery();
  state.unreadableMisses = battery.percent === null && battery.hasBattery ? state.unreadableMisses + 1 : 0;
  const thermal = awake.readThermal();
  for (const action of awakeFloorActions({
    ...battery, unreadableMisses: state.unreadableMisses, thermal, lidClosed: state.lidHeld,
    lowPowerSetByUs: state.lowPowerSetByUs, config: awake.config(),
  })) {
    if (action.action === 'end') state.ask(action.reason);
    else lowPower(awake, state, action);
  }
  return {sessions, battery, thermal};
}

/** Let go of every child, then give back whatever the journal still owns.
 *  Exit 0 when everything is back, 1 when the backstop has to retry. */
function release(awake, children, stopping) {
  children.stopAll();
  const released = awake.recover({force: true});
  awake.log(`ended (${stopping})${released.failed.length
    ? ` - COULD NOT UNDO ${released.failed.join(', ')}` : ''}`);
  return released.failed.length ? 1 : 0;
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
  const children = childPool(awake, io.spawn ?? spawn);
  const platform = awake.platform();

  const start = take(awake, opts, io.kind ?? 'cli');
  if (!start.ok) {
    awake.log(`refused to start: ${start.reason}${start.owner ? ` (pid ${start.owner.pid})` : ''}`);
    return 3;
  }
  const state = {
    session: start.session, stopping: null, lowPowerSetByUs: false, unreadableMisses: 0, lidHeld: false,
    ask(reason) {
      if (reason && !this.stopping) this.stopping = reason;
    },
  };
  awake.log(`holding until ${new Date(state.session.endsAt).toISOString()}`
    + `${state.session.whileSessions ? ' / while sessions run' : ''}${state.session.lid ? ' / lid' : ''}`);

  const inhibitArgv = () => awakeInhibitArgv(platform, {
    seconds: secondsLeft(state.session, awake.now()), pid: process.pid,
  });
  let inhibitor = children.start(inhibitArgv(), 'inhibitor');
  if (!inhibitArgv())
    awake.log(`no inhibitor for platform ${platform}: the session is bookkeeping only`);

  if (state.session.lid) {
    const outcome = lid(awake, state.session, children);
    state.lidHeld = outcome.ok;
    awake.log(outcome.ok
      ? 'lid mode on'
      : `lid mode NOT on (${outcome.reason}): ${outcome.message ?? ''}`.trim());
  }

  process.on('SIGTERM', () => state.ask('user'));
  process.on('SIGINT', () => state.ask('user'));

  for (;;) {
    const seen = cycle(awake, state);
    if (seen === 'handed-over') {
      awake.log(`handed over to pid ${state.session.owner.pid}`);
      children.stopAll();
      return 0;
    }
    io.onCycle?.({
      session: state.session, ...seen, stopping: state.stopping, lowPowerSetByUs: state.lowPowerSetByUs,
    });
    if (state.stopping) break;
    // An inhibitor that died - killed, or its own sleep expired because the
    // session was extended past it - is restarted: the hold must outlast it.
    if (inhibitor && inhibitor.exitCode !== null && inhibitor.exitCode !== undefined) {
      awake.log('inhibitor exited early; restarting it');
      inhibitor = children.start(inhibitArgv(), 'inhibitor');
    }
    await sleep((io.pollSeconds ?? AWAKE_POLL_SECONDS) * 1000);
  }
  return release(awake, children, state.stopping);
}

if (isMain(import.meta.url)) {
  hold(parseWorkerArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    () => process.exit(1));
}
