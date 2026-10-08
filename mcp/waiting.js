// The MCP `waiting` tool: live Claude Code sessions blocked on the user.
// server.js owns the transport; this file is the schema and the renderer.

import {listWaiting} from '../claude-code/waiting.js';

export const WAITING_TOOL = {
  name: 'waiting',
  title: 'Sessions waiting on you',
  description:
    'Live Claude Code sessions that are blocked waiting for your input: a ' +
    'permission prompt, a question, or idle after Stop. Oldest wait first. ' +
    'Dead pids are ignored. Each row names the session, the reason, how long ' +
    'it has been waiting, and the working directory.',
  inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  outputSchema: {
    type: 'object',
    properties: {
      count: {type: 'integer', minimum: 0},
      sessions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pid: {type: 'integer'},
            sessionId: {type: 'string'},
            name: {type: 'string'},
            cwd: {type: 'string'},
            reason: {type: 'string', enum: ['permission', 'question', 'idle']},
            at: {type: 'number', description: 'epoch milliseconds when it started waiting'},
            age: {type: 'string', description: 'compact age, e.g. "5m"'},
            reasonLabel: {type: 'string'},
          },
          required: ['pid', 'sessionId', 'name', 'cwd', 'reason', 'at', 'age'],
        },
      },
    },
    required: ['count', 'sessions'],
  },
  annotations: {readOnlyHint: true, openWorldHint: false},
};

export function renderWaiting(rows) {
  if (!rows.length)
    return 'Nothing waiting on you.';
  const lines = [`**Waiting on you** (${rows.length})`, ''];
  for (const r of rows)
    lines.push(`- **${r.name}** - ${r.reasonLabel} · ${r.age} · \`${r.cwd}\``);
  return lines.join('\n');
}

export function getWaiting(io = {}) {
  const sessions = listWaiting(io);
  return {
    content: [{type: 'text', text: renderWaiting(sessions)}],
    structuredContent: {count: sessions.length, sessions},
  };
}
