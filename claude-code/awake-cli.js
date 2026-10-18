// `claudectl awake`: keep this machine awake while Claude Code is working, or
// for a timer. claudectl.js dispatches here; every decision is
// lib/pure/awake.js's and every file and command claude-code/awake.js's.

import {
  awakeBadge, formatAwakeDuration, parseAwakeDuration,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {openAwake} from './awake.js';

export const HELP = `claudectl awake - keep this machine awake while Claude Code works

  claudectl awake [status] [--json]      what is holding it, and until when
  claudectl awake on [--for 2h] [--while-sessions] [--lid]
                                         start a session (default: --for 1h)
  claudectl awake off                    end it now and give the machine back
  claudectl awake extend --for 30m       push the deadline out (never past the cap)
  claudectl awake recover [--force]      undo whatever the journal still owns

The machine is held awake by a CHILD process, so the assertion is released
whatever happens to the holder. Every session has a deadline, the battery and
thermal floors can end one early, and --lid is experimental: read
wiki/Awake.md before you shut a laptop in a bag.`;

/** One paragraph per command, after its synopsis in `<command> --help`. */
export const DETAILS = {
  status: `What is holding the machine awake, what is left on the timer, how many
Claude Code sessions are running, and whether a past session left anything
that has not been given back. Reads only; safe anywhere.`,
  on: `Starts a session. \`--for\` takes 2h, 90m, 1h30m or a bare number of
minutes; \`--while-sessions\` keeps it up while any Claude Code session is
running or waiting on you, and with no \`--for\` it ends when the last one
does. Every session is capped (12h) whatever is asked for. \`--lid\` also
disables lid sleep: macOS needs the sudoers rule \`./install.sh awakelid\`
installs, Linux uses a logind inhibitor and needs nothing.`,
  off: `Asks the holder to stop and waits for it, then gives back anything it could
not. With no holder running this is the recovery.`,
  extend: `Pushes the deadline out by \`--for\`, never past the 12h cap measured from
now - so no chain of extensions can walk a laptop through the night.`,
  recover: `Undoes whatever the recovery journal still owns: the macOS sleep setting and
the Low Power Mode a floor switched on. Refuses while the session it belongs
to is still running, unless \`--force\`. This is what
scripts/awake-backstop.sh runs with no panel in sight.`,
};

/** `--for 2h`, `--for=2h`, or null. Throws on a value nobody can read, rather
 *  than quietly holding the machine for some other length of time. */
export function durationFlag(argv) {
  const i = argv.findIndex((a) => a === '--for' || a.startsWith('--for='));
  if (i < 0) return null;
  const raw = argv[i].startsWith('--for=') ? argv[i].slice('--for='.length) : argv[i + 1];
  const seconds = parseAwakeDuration(raw);
  if (seconds === null)
    throw new Error(`--for ${raw ?? ''}: want 2h, 90m, 1h30m or a number of minutes`);
  return seconds;
}

/** The human lines `status` prints. */
export function statusLines(state) {
  if (!state.active) {
    const lines = [state.endReason
      ? `Not awake (last session ended: ${state.endReason})`
      : 'Not awake'];
    if (state.recovery) {
      lines.push(`  RECOVERY OWED: ${state.recovery.codes.join(', ')}`
        + ` - the session ended ${state.recovery.endedAgo} ago.`
        + ' Run `claudectl awake recover --force`.');
    }
    return lines;
  }
  const holds = state.holds.map((h) => (h === 'timer'
    ? `timer ${state.countdown}`
    : `${state.sessions} session${state.sessions === 1 ? '' : 's'}`));
  const lines = [`Awake - ${holds.join(' + ')}`];
  lines.push(`  until ${new Date(state.endsAt).toISOString()}`
    + ` (${formatAwakeDuration(state.remainingMs / 1000)} left)`);
  if (state.lid)
    lines.push('  lid mode on (experimental): keep it on a hard, ventilated surface');
  if (state.owner?.pid)
    lines.push(`  held by pid ${state.owner.pid}`);
  if (state.recovery)
    lines.push(`  recovery owed: ${state.recovery.codes.join(', ')}`);
  return lines;
}

export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const args = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  const cmd = args[0] === undefined || args[0] === 'status' ? 'status' : args[0];
  // before the flag filter dropped it: `awake --help` is help, not a status
  if (argv.includes('--help') || cmd === 'help' || cmd === '-h') {
    out(`${HELP}\n`);
    return 0;
  }
  const awake = openAwake(io);

  if (cmd === 'status') {
    const state = awake.status();
    if (json) {
      out(`${JSON.stringify({...state, badge: awakeBadge(state)}, null, 2)}\n`);
      return 0;
    }
    out(`${statusLines(state).join('\n')}\n`);
    return 0;
  }

  if (cmd === 'on') {
    const seconds = durationFlag(argv);
    const whileSessions = argv.includes('--while-sessions');
    const lid = argv.includes('--lid');
    // A bare `awake on` is an hour: a session with no end is the one thing
    // this feature must never create.
    const want = seconds ?? (whileSessions ? null : 3600);
    const result = awake.start({seconds: want, whileSessions, lid});
    if (!result.ok) {
      if (result.reason === 'already-held') {
        throw new Error(`already awake, held by pid ${result.owner.pid}`
          + ' - `claudectl awake off` ends it, `claudectl awake extend --for 30m` lengthens it');
      }
      if (result.reason === 'recovery-pending') {
        throw new Error('a previous session left '
          + `${result.steps.join(', ')} to give back - run \`claudectl awake recover --force\``);
      }
      throw new Error(`the holder did not start${result.log ? `:\n${result.log}` : ''}`);
    }
    out(`${statusLines(result.status).join('\n')}\n`);
    if (lid && !result.status.lid)
      out('  lid mode was asked for but is not on - see the log\n');
    return 0;
  }

  if (cmd === 'off') {
    const result = awake.stop();
    if (result.failed.length) {
      throw new Error(`could not give back ${result.failed.join(', ')}`
        + ' - the backstop will retry; `claudectl awake recover --force` retries now');
    }
    out(result.hadHolder ? 'awake off\n' : 'nothing was holding it\n');
    return 0;
  }

  if (cmd === 'extend') {
    const seconds = durationFlag(argv);
    if (seconds === null) throw new Error('awake extend needs --for (e.g. --for 30m)');
    const result = awake.extend(seconds);
    if (!result.ok) {
      throw new Error(result.reason === 'not-held'
        ? 'nothing to extend: `claudectl awake on` starts a session'
        : `could not extend (${result.reason})`);
    }
    out(`${statusLines(awake.status()).join('\n')}\n`);
    return 0;
  }

  if (cmd === 'recover') {
    const result = awake.recover({force: argv.includes('--force')});
    if (!result.ok && result.reason === 'session-still-running')
      throw new Error('a session is still running - `claudectl awake off` ends it first');
    if (result.failed.length)
      throw new Error(`could not undo ${result.failed.join(', ')}`);
    out(result.undone.length ? `gave back ${result.undone.join(', ')}\n` : 'nothing owed\n');
    return 0;
  }

  throw new Error(`unknown command ${cmd}\n${HELP}`);
}
