// Awake I/O: the session being held, the recovery journal, the lock the
// holder and the backstop share, and the readings the floors run on. Every
// decision is lib/pure/awake.js's; this file only reads, writes and runs.
//
// Three files under `<state dir>/claude-usage-panel/awake/`, all 0600:
//   session.json  what is being held, by whom, until when
//   journal.json  what the machine owes back - written BEFORE every change
//   .hold.lock    the O_EXCL mutex the holder and scripts/awake-backstop.sh
//                 take around "read, decide, change, write"
//
// Nothing persistent is changed on Linux: the idle/sleep inhibitor and the
// lid inhibitor are both CHILD processes, so the kernel gives everything back
// when the holder exits, and the journal stays clean. macOS `pmset -a
// disablesleep 1` is a system setting that outlives the app, so that one is
// journaled, read back, and undone by the backstop if the app is gone.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  AWAKE_MAX_SECONDS, AWAKE_VERSION, awakeBackstopDue, awakeJournalEntry, awakeLidArgv,
  awakeLowPowerArgv, awakeRecoverySteps, awakeState, extendAwakeSession, newAwakeSession,
  normalizeAwakeConfig, parseAwakeJournal, parseAwakeSession, parsePmsetBattery,
  parseSleepDisabled, parseSysfsBattery, thermalFromMillidegrees, thermalFromSpeedLimit,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {awakeDir} from './paths.js';
import {readJSON, writePrivate} from './private-fs.js';
import {openTabs} from './tabs.js';
import {listWaiting} from './waiting.js';

/** A lock whose holder has not touched it for this long is taken over: a
 *  crashed holder must not block the backstop forever. */
const LOCK_STALE_MS = 60_000;
/** How long a waiter polls for the lock before giving up and doing nothing.
 *  Doing nothing is always safe here; acting unlocked is not. */
const LOCK_WAIT_MS = 5_000;

/** How long after `pmset -a disablesleep 1` the bit is read back. pmset can
 *  exit 0 while another process puts it straight back, which is exactly how
 *  Insomnia found a closed lid sleeping a Mac mid-session. */
const SETTLE_MS = 5_000;

const COMMAND_TIMEOUT_MS = 20_000;

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Everything the CLI, the MCP tool, the status line, the panels and the
 * holder itself go through. `io` is the usual shape plus `exec`, `nowMs`,
 * `pidAlive` and `hostname`, so the tests drive a fake machine.
 */
export function openAwake(io = {}) {
  const now = () => Math.floor(io.nowMs ? io.nowMs() : Date.now());
  const platform = () => io.platform ?? process.platform;
  const exec = io.exec ?? execFileSync;
  const pidAlive = (pid) => (io.pidAlive ?? defaultPidAlive)(pid);
  const host = () => io.hostname ?? os.hostname();
  const dir = () => awakeDir(io);
  const sessionFile = () => path.join(dir(), 'session.json');
  const journalFile = () => path.join(dir(), 'journal.json');
  const lockFile = () => path.join(dir(), '.hold.lock');
  const configFile = () => path.join(dir(), 'config.json');

  /** The floors and the ceiling. `io.awakeConfig` wins (the tests), then
   *  config.json - which the panels write from their own settings, so one
   *  machine has one set of floors whichever surface started the session. */
  const config = () => normalizeAwakeConfig(io.awakeConfig ?? readJSON(configFile()) ?? {});

  function writeConfig(values) {
    const next = normalizeAwakeConfig({...config(), ...values});
    writePrivate(configFile(), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  const readSession = () => parseAwakeSession(readJSON(sessionFile()));
  const readJournal = () => parseAwakeJournal(readJSON(journalFile()));

  function writeSession(session) {
    writePrivate(sessionFile(), `${JSON.stringify(session, null, 2)}\n`);
  }

  function writeJournal(journal) {
    writePrivate(journalFile(), `${JSON.stringify(journal, null, 2)}\n`);
  }

  /** How many Claude Code sessions are alive right now: a running one, or one
   *  parked waiting on the user. Both count - a permission prompt nobody has
   *  answered is exactly when the machine must not go to sleep. */
  function liveSessions() {
    if (io.liveSessions) return io.liveSessions();
    try {
      const live = openTabs(io).liveSessions().length;
      return live > 0 ? live : listWaiting(io).length;
    } catch {
      return 0;
    }
  }

  /** The whole picture: what holds, what is left, and whether anything is
   *  owed back. Never throws - every surface renders from this.
   *
   *  The registry is walked only for a hold that actually depends on it: the
   *  status line renders this on every prompt, and a `ps` / `/proc` sweep per
   *  render for a count nothing reads is not free. */
  function status() {
    const session = readSession();
    const sessions = session?.whileSessions ? liveSessions() : 0;
    return awakeState({session, journal: readJournal(), sessions, nowMs: now()});
  }

  // ── the lock ────────────────────────────────────────────────────────────
  // One transaction: read, decide, change the machine, write, release. The
  // backstop script takes the same file, so no undo can run beside a change.

  function statOrNull(p) {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  }

  /** Hold the lock for `fn`, or return `{ok: false}` without doing anything.
   *  A caller that cannot get the lock must NEVER proceed unlocked. */
  function withLock(fn) {
    fs.mkdirSync(dir(), {recursive: true, mode: 0o700});
    const file = lockFile();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(file, `${process.pid}\n`, {mode: 0o600, flag: 'wx'});
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const seen = statOrNull(file);
        // A lock whose holder is gone, or that has sat untouched past the
        // stale window, is removed and the create retried.
        const heldPid = Number(String(readText(file) ?? '').trim());
        const dead = Number.isInteger(heldPid) && heldPid > 0 && !pidAlive(heldPid);
        if (seen && (dead || Date.now() - seen.mtimeMs > LOCK_STALE_MS)) {
          fs.rmSync(file, {force: true});
          continue;
        }
        if (Date.now() >= deadline) return {ok: false, reason: 'busy'};
        sleepMs(50);
      }
    }
    try {
      return {ok: true, value: fn()};
    } finally {
      fs.rmSync(file, {force: true});
    }
  }

  // ── readings the floors run on ──────────────────────────────────────────

  function readText(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  function run(argv) {
    try {
      const out = exec(argv[0], argv.slice(1), {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS,
      });
      return {ok: true, stdout: String(out ?? '')};
    } catch (e) {
      return {
        ok: false,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? e.message ?? ''),
      };
    }
  }

  /** The battery, as the floors need it: a desktop has none (so no floor
   *  applies), a battery we could not read is a very different thing. */
  function readBattery() {
    if (platform() === 'darwin') {
      const r = run(['/usr/bin/pmset', '-g', 'batt']);
      if (!r.ok) return {percent: null, charging: false, hasBattery: true};
      return parsePmsetBattery(r.stdout);
    }
    const base = io.powerSupplyDir ?? '/sys/class/power_supply';
    let names;
    try {
      names = fs.readdirSync(base);
    } catch {
      return {percent: null, charging: true, hasBattery: false};
    }
    const bat = names.find((n) => /^BAT/i.test(n));
    if (!bat) return {percent: null, charging: true, hasBattery: false};
    return parseSysfsBattery({
      capacity: readText(path.join(base, bat, 'capacity')),
      status: readText(path.join(base, bat, 'status')),
    });
  }

  /** The thermal state: what macOS reports about its own throttling, or the
   *  hottest Linux thermal zone. */
  function readThermal() {
    if (platform() === 'darwin') {
      const r = run(['/usr/bin/pmset', '-g', 'therm']);
      return r.ok ? thermalFromSpeedLimit(r.stdout) : 'nominal';
    }
    const base = io.thermalDir ?? '/sys/class/thermal';
    let zones;
    try {
      zones = fs.readdirSync(base).filter((n) => /^thermal_zone\d+$/.test(n));
    } catch {
      return 'nominal';
    }
    let hottest = 0;
    for (const zone of zones) {
      const raw = Number(String(readText(path.join(base, zone, 'temp')) ?? '').trim());
      if (Number.isFinite(raw) && raw > hottest) hottest = raw;
    }
    return thermalFromMillidegrees(hottest);
  }

  // ── machine changes, each journaled first ───────────────────────────────

  /**
   * Turn the closed-lid setting on or off. macOS only has a persistent one
   * (`pmset -a disablesleep`), so that is the only one journaled; on Linux
   * the lid inhibitor is a child process the holder owns, and letting it go
   * IS the release.
   *
   * A disable is READ BACK after a settle: pmset can exit 0 while something
   * else puts the bit straight back, and a lid mode that cannot be proven on
   * is reported as failed rather than trusted.
   */
  function setLidDisabled(on, {settleMs = io.settleMs ?? SETTLE_MS} = {}) {
    const argv = awakeLidArgv(platform(), on);
    if (!argv) return {ok: false, reason: 'unsupported'};
    const r = run(argv);
    if (!r.ok) {
      return {
        ok: false,
        reason: 'command-failed',
        message: `${argv.join(' ')}: ${lastLine(r.stderr) || 'failed'}`,
      };
    }
    if (!on) return {ok: true};
    if (settleMs > 0) sleepMs(settleMs);
    const back = parseSleepDisabled(run(['/usr/bin/pmset', '-g']).stdout);
    if (back === true) return {ok: true};
    return {
      ok: false,
      reason: back === false ? 'reverted' : 'unreadable',
      message: back === false
        ? 'SleepDisabled read 0 again after the settle; something else is resetting it, '
          + 'so a closed lid would still sleep this Mac'
        : 'pmset -g printed no SleepDisabled value, so the change could not be read back',
    };
  }

  function setLowPower(on) {
    const argv = awakeLowPowerArgv(platform(), on);
    if (!argv) return {ok: false, reason: 'unsupported'};
    const r = run(argv);
    return r.ok ? {ok: true} : {ok: false, reason: 'command-failed', message: lastLine(r.stderr)};
  }

  /**
   * Give the machine back everything the journal still owns, in the journal's
   * own order, and clear each flag only after its undo succeeded. The one
   * path `claudectl awake off`, the holder's exit and a recovery all take.
   *
   * @returns {{ok: boolean, undone: string[], failed: string[], reason?: string}}
   */
  function recover({force = false} = {}) {
    const locked = withLock(() => {
      const journal = readJournal();
      const steps = awakeRecoverySteps(journal);
      if (!steps.length) {
        fs.rmSync(sessionFile(), {force: true});
        return {ok: true, undone: [], failed: []};
      }
      if (!force && !awakeBackstopDue(journal, now(), {force: false})) {
        return {ok: false, undone: [], failed: steps, reason: 'session-still-running'};
      }
      const undone = [];
      const failed = [];
      let next = {...journal};
      for (const step of steps) {
        const result = step === 'sleepDisabled' ? setLidDisabled(false) : setLowPower(false);
        if (result.ok) {
          undone.push(step);
          next = {...next, [step]: false};
          writeJournal(next);
        } else {
          failed.push(step);
        }
      }
      if (!failed.length) fs.rmSync(sessionFile(), {force: true});
      return {ok: failed.length === 0, undone, failed};
    });
    return locked.ok ? locked.value : {ok: false, undone: [], failed: [], reason: 'busy'};
  }

  // ── starting and stopping a hold ────────────────────────────────────────

  /** The live holder, or null: a session whose owner process is gone is not
   *  being held by anyone, whatever the file says. */
  function liveOwner() {
    const session = readSession();
    const pid = session?.owner?.pid ?? 0;
    if (!pid || session.owner.host !== host()) return null;
    return pidAlive(pid) ? session.owner : null;
  }

  /**
   * Start a hold by spawning the detached holder (awake-worker.js), which
   * takes the lock, writes the journal and session and owns the inhibitor
   * child for the whole session. The worker, not this call, is the holder:
   * `claudectl awake on` has to be able to return to the prompt.
   */
  function start({seconds = null, whileSessions = false, lid = false, waitMs = 4_000} = {}) {
    const existing = liveOwner();
    if (existing) return {ok: false, reason: 'already-held', owner: existing};
    const journal = readJournal();
    if (awakeRecoverySteps(journal).length) {
      return {ok: false, reason: 'recovery-pending', steps: awakeRecoverySteps(journal)};
    }
    fs.mkdirSync(dir(), {recursive: true, mode: 0o700});
    const argv = [workerPath(), '--seconds', seconds === null ? 'none' : String(seconds)];
    if (whileSessions) argv.push('--while-sessions');
    if (lid) argv.push('--lid');
    const child = (io.spawn ?? spawn)(process.execPath, argv, {
      detached: true, stdio: 'ignore', env: {...(io.env ?? process.env)},
    });
    child.unref?.();
    // The worker writes session.json under the lock; wait for it so the
    // caller can report a real state rather than "probably started".
    const deadline = Date.now() + waitMs;
    for (;;) {
      const session = readSession();
      if (session?.owner?.pid) return {ok: true, session, status: status()};
      if (Date.now() >= deadline) break;
      sleepMs(100);
    }
    return {ok: false, reason: 'no-holder', log: tail(logFile(), 10)};
  }

  /**
   * End the hold. The holder is asked to stop (SIGTERM, which runs its own
   * release), and whatever it could not give back is recovered here. With no
   * live holder this IS the recovery.
   */
  function stop({waitMs = 6_000} = {}) {
    const owner = liveOwner();
    if (owner) {
      try {
        process.kill(owner.pid, 'SIGTERM');
      } catch {
        // already gone; the recovery below is the backstop
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (!pidAlive(owner.pid)) break;
        sleepMs(100);
      }
    }
    const recovered = recover({force: true});
    return {...recovered, hadHolder: Boolean(owner)};
  }

  /** Push the deadline out. Only the holder may rewrite its own session, so
   *  this writes the file and lets the holder pick it up on its next poll. */
  function extend(extraSeconds) {
    const locked = withLock(() => {
      const session = readSession();
      if (!session) return {ok: false, reason: 'not-held'};
      const next = extendAwakeSession(session, extraSeconds, now(), config().maxSeconds);
      writeSession(next);
      const journal = readJournal();
      if (journal) writeJournal({...journal, endsAt: next.endsAt});
      return {ok: true, session: next};
    });
    return locked.ok ? locked.value : {ok: false, reason: 'busy'};
  }

  function logFile() {
    return path.join(dir(), 'awake.log');
  }

  /** One line in the holder's log. Best effort: a log that cannot be written
   *  must never cost the machine its release. */
  function log(line) {
    try {
      fs.mkdirSync(dir(), {recursive: true, mode: 0o700});
      fs.appendFileSync(logFile(), `${new Date(now()).toISOString()} ${line}\n`, {mode: 0o600});
    } catch {
      // nothing to do about it
    }
  }

  return {
    config, writeConfig, dir, sessionFile, journalFile, configFile, lockFile, logFile,
    readSession, readJournal, writeSession, writeJournal,
    liveSessions, status, liveOwner,
    withLock, readBattery, readThermal,
    setLidDisabled, setLowPower, recover,
    start, stop, extend, log,
    now, platform, host,
    newSession: (opts) => newAwakeSession({nowMs: now(), maxSeconds: config().maxSeconds, ...opts}),
    newJournal: (opts) => awakeJournalEntry({nowMs: now(), ...opts}),
    version: AWAKE_VERSION,
    maxSeconds: () => config().maxSeconds ?? AWAKE_MAX_SECONDS,
  };
}

/** The detached holder this module starts. Resolved relative to this file so
 *  it works from the checkout and from the installed tree alike. */
function workerPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'awake-worker.js');
}

function lastLine(text) {
  const lines = String(text ?? '').trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].trim() : '';
}

function tail(file, count) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.slice(-count).join('\n');
  } catch {
    return '';
  }
}

/** A blocking sleep. The holder and the CLI are short-lived single-purpose
 *  processes waiting on a file or a pid; an event loop buys them nothing and
 *  a busy loop would spin a core. */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
