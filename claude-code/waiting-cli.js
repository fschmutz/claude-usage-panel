// `claudectl waiting`: the live Claude Code sessions that are blocked
// waiting for the user. claudectl.js dispatches here.

import {matchSession} from './tabs.js';
import {focusSession, listWaiting} from './waiting.js';

export const HELP = `claudectl waiting - live Claude Code sessions waiting on you

  claudectl waiting [list] [--json]     oldest wait first (permission / question / idle)
  claudectl waiting focus NAME|PID      raise that session's terminal

Stop marks a session idle (the turn ended; the prompt is waiting). A
Notification hook marks permission or a question. UserPromptSubmit,
PreToolUse, PostToolUse and SessionEnd clear the mark. Dead pids, and a
pid reused by a later session, are ignored. Focus by pid when two sessions
share a name.`;

function table(out, rows) {
  const w = Math.max(4, ...rows.map((r) => r.name.length));
  out(`  ${'NAME'.padEnd(w)}  REASON       AGE   CWD\n`);
  for (const r of rows)
    out(`  ${r.name.padEnd(w)}  ${r.reasonLabel.padEnd(11)}  ${r.age.padEnd(5)}  ${r.cwd}\n`);
}

export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const args = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  const cmd = args[0] === undefined || args[0] === 'list' ? 'list' : args[0];
  // before the flag filter dropped it: `waiting --help` is help, not a list
  if (argv.includes('--help') || cmd === 'help' || cmd === '-h') {
    out(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'focus') {
    const key = args[1];
    if (!key)
      throw new Error('waiting focus needs a name or pid');
    const row = matchSession(listWaiting(io), key, {what: 'waiting'});
    if (!focusSession(row, io))
      throw new Error(`could not focus ${row.name}`);
    out(`focused ${row.name}\n`);
    return 0;
  }
  if (cmd !== 'list')
    throw new Error(`unknown command ${cmd}\n${HELP}`);
  const rows = listWaiting(io);
  if (json) {
    out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (!rows.length) {
    out('nothing waiting\n');
    return 0;
  }
  out(`Waiting on you (${rows.length})\n`);
  table(out, rows);
  return 0;
}
