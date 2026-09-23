#!/usr/bin/env node
// claudectl: the one command-line entry point. `claudectl account …` manages
// named logins (account-cli.js over accounts.js), `claudectl session …`
// snapshots the running Claude Code sessions and reopens them as tabs
// (session-cli.js over tabs.js). This file only dispatches and owns the
// process edges (exit code, stderr, the TTY confirm); `main` is exported for
// the tests and runs when the file is invoked directly (the install.sh shim,
// the npm bin symlink).

import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

import * as account from './account-cli.js';
import * as session from './session-cli.js';

const GROUPS = {account, session};

const HELP = `claudectl - Claude Code from the command line

  claudectl account ...   named logins: list, current, save, use, remove, refresh
  claudectl session ...   running sessions: list, save, store, show, open, purge, autosave

  claudectl account help | claudectl session help   the commands of one group`;

export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const [group, ...rest] = argv;
  if (group === undefined || group === 'help' || group === '-h' || group === '--help') {
    out(`${HELP}\n`);
    return 0;
  }
  const cli = GROUPS[group];
  if (!cli) throw new Error(`unknown command ${group}\n${HELP}`);
  return cli.main(rest, io);
}

async function ttyConfirm(question) {
  if (!process.stdin.isTTY) return false;
  const {createInterface} = await import('node:readline/promises');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    return (await rl.question(question)).trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

// Run when executed directly - including through the npm bin shim, which
// invokes us via a node_modules/.bin symlink, so compare realpaths.
const invokedAs = (() => {
  try {
    return process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (invokedAs === import.meta.url) {
  main(process.argv.slice(2), {confirm: ttyConfirm}).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`claudectl: ${e.message}\n`);
      process.exit(1);
    });
}
