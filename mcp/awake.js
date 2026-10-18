// The MCP `awake` tool: read whether this machine is being held awake, and
// start or stop a session. server.js owns the transport; this file is the
// schema, the renderer and the call.
//
// Deliberately narrow. The tool can start a timed hold, hold while Claude Code
// sessions run, and stop one. It CANNOT turn closed-lid mode on: that one
// needs a sudoers rule, a hard ventilated surface and a human who has read the
// warning, so it stays a `claudectl awake on --lid` / panel-toggle decision.

import {
  awakeBadge, formatAwakeDuration, parseAwakeDuration,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/awake.js';
import {openAwake} from '../claude-code/awake.js';

export const AWAKE_TOOL = {
  name: 'awake',
  title: 'Keep this machine awake',
  description:
    'Whether this machine is being kept awake for Claude Code, what is holding '
    + 'it and for how long, plus whether a past session left a setting that was '
    + 'not given back. With action "on" it starts a session (a duration like '
    + '"2h", and/or while any Claude Code session is running or waiting); with '
    + '"off" it ends one and releases everything. Every session has a deadline '
    + 'and is capped at 12 hours. Closed-lid mode cannot be switched on here.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'on', 'off'],
        description: 'status (default), on, or off',
      },
      duration: {
        type: 'string',
        description: 'how long to stay awake: "2h", "90m", "1h30m" or a number of minutes',
      },
      whileSessions: {
        type: 'boolean',
        description: 'hold while any Claude Code session is running or waiting on you',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      active: {type: 'boolean'},
      holds: {type: 'array', items: {type: 'string', enum: ['timer', 'sessions']}},
      timed: {type: 'boolean'},
      whileSessions: {type: 'boolean'},
      lid: {type: 'boolean'},
      sessions: {type: 'integer', minimum: 0},
      endsAt: {type: ['number', 'null'], description: 'epoch milliseconds'},
      remainingMs: {type: 'number'},
      countdown: {type: 'string'},
      badge: {type: 'string'},
      endReason: {type: ['string', 'null']},
      recoveryOwed: {type: 'array', items: {type: 'string'}},
    },
    required: ['active', 'holds', 'sessions', 'remainingMs', 'recoveryOwed'],
  },
  // Not read-only: "on" and "off" change how this machine sleeps.
  annotations: {readOnlyHint: false, destructiveHint: false, openWorldHint: false},
};

function structured(state) {
  return {
    active: state.active,
    holds: state.holds,
    timed: state.timed,
    whileSessions: state.whileSessions,
    lid: state.lid,
    sessions: state.sessions,
    endsAt: state.endsAt,
    remainingMs: state.remainingMs,
    countdown: state.countdown,
    badge: awakeBadge(state),
    endReason: state.endReason,
    recoveryOwed: state.recovery?.codes ?? [],
  };
}

function render(state) {
  const lines = [];
  if (state.active) {
    const holds = state.holds.map((h) => (h === 'timer'
      ? `a timer (${state.countdown} left)`
      : `${state.sessions} live Claude Code session${state.sessions === 1 ? '' : 's'}`));
    lines.push(`**Awake** - held by ${holds.join(' and ')}.`);
    lines.push(`Ends at ${new Date(state.endsAt).toISOString()}`
      + ` (${formatAwakeDuration(state.remainingMs / 1000)} left).`);
    if (state.lid)
      lines.push('Closed-lid mode is on. Keep the machine on a hard, ventilated surface.');
  } else {
    lines.push(state.endReason
      ? `**Not awake.** The last session ended: ${state.endReason}.`
      : '**Not awake.**');
  }
  if (state.recovery) {
    lines.push(`\u26a0 ${state.recovery.codes.join(', ')} was not given back`
      + ` (the session ended ${state.recovery.endedAgo} ago). Run \`claudectl awake recover --force\`.`);
  }
  return lines.join('\n');
}

export function callAwakeTool(args = {}, io = {}) {
  const awake = openAwake(io);
  const action = args?.action ?? 'status';
  if (action === 'on') {
    const raw = args?.duration;
    const seconds = raw === undefined || raw === null || raw === '' ? null : parseAwakeDuration(raw);
    if (raw !== undefined && raw !== null && raw !== '' && seconds === null)
      throw new Error(`duration ${JSON.stringify(raw)}: want "2h", "90m", "1h30m" or minutes`);
    const whileSessions = args?.whileSessions === true;
    const result = awake.start({seconds: seconds ?? (whileSessions ? null : 3600), whileSessions});
    if (!result.ok) {
      if (result.reason === 'already-held') {
        throw new Error(`already awake, held by pid ${result.owner.pid}.`
          + ' Use action "off" to end it.');
      }
      if (result.reason === 'recovery-pending') {
        throw new Error(`a previous session left ${result.steps.join(', ')} to give back.`
          + ' Run `claudectl awake recover --force` first.');
      }
      throw new Error('the holder did not start; see <state dir>/claude-usage-panel/awake/awake.log');
    }
  } else if (action === 'off') {
    const result = awake.stop();
    if (result.failed.length)
      throw new Error(`could not give back ${result.failed.join(', ')}; the backstop will retry`);
  } else if (action !== 'status') {
    throw new Error(`unknown action ${JSON.stringify(action)}: want status, on or off`);
  }
  const state = awake.status();
  return {
    content: [{type: 'text', text: render(state)}],
    structuredContent: structured(state),
  };
}
