#!/usr/bin/env node
// Claude Code hook: mark or clear the waiting marker for THIS session.
// Wired by install.sh into ~/.claude/settings.json for Notification,
// UserPromptSubmit, PreToolUse, Stop and SessionEnd. Reads the hook
// payload on stdin, writes `<pid>.waiting.json` next to the live-session
// registry, never throws (a crashing hook is worse than a missed mark).
//
// Stop marks idle - the turn ended and the prompt is waiting on you.
// UserPromptSubmit / PreToolUse / SessionEnd clear. Notification marks
// with a more specific reason (permission / question / idle).

import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

import {handleHook} from './waiting.js';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let payload = {};
  const raw = readStdin();
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  handleHook(payload);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    // a hook must not fail the session
  }
}
