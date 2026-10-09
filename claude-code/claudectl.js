#!/usr/bin/env node
// claudectl: the one command-line entry point. `claudectl account …` manages
// named logins (account-cli.js over accounts.js), `claudectl session …`
// snapshots the running Claude Code sessions and reopens them as tabs
// (session-cli.js over tabs.js), `claudectl codex …` does for OpenAI Codex
// logins what `account` does for Claude ones (codex-cli.js over codex.js).
// This file only dispatches and owns the process edges (exit code, stderr, the
// TTY questions); `main` is exported for the tests and runs when the file is
// invoked directly (the install.sh shim, the npm bin symlink).

import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

import * as account from './account-cli.js';
import {commandHelp, helpRequest} from './cli-help.js';
import * as codex from './codex-cli.js';
import * as session from './session-cli.js';
import * as waiting from './waiting-cli.js';

const GROUPS = {account, codex, session, waiting};

const HELP = `claudectl - Claude Code from the command line

  claudectl account ...   named logins: list, current, save, use, remove, refresh
  claudectl session ...   running sessions: list, focus, save, store, show, open, purge, autosave
  claudectl codex ...     named OpenAI Codex logins: list, current, save, use, remove, usage
  claudectl waiting ...   live sessions waiting on you: list, focus

  claudectl <group> --help            the commands of one group
  claudectl <group> <command> --help  one command, in full (help and -h work too)`;

export async function main(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  // answered before any command runs: `session open --help` must not open
  const asked = helpRequest(argv);
  if (asked) return help(asked, out, io);
  const [group, ...rest] = argv;
  if (group === undefined) {
    out(`${HELP}\n`);
    return 0;
  }
  const cli = GROUPS[group];
  if (!cli) throw new Error(`unknown command ${group}\n${HELP}`);
  return cli.main(rest, io);
}

async function help({group, cmd}, out, io) {
  if (group === undefined) {
    out(`${HELP}\n`);
    return 0;
  }
  const cli = GROUPS[group];
  if (!cli) throw new Error(`unknown command ${group}\n${HELP}`);
  if (cmd === undefined) return cli.main(['help'], io);
  const page = commandHelp({help: cli.HELP, details: cli.DETAILS, aliases: cli.ALIASES}, group, cmd);
  if (!page) throw new Error(`unknown command ${group} ${cmd} - claudectl ${group} --help lists them`);
  out(`${page}\n`);
  return 0;
}

// The answer typed at the terminal, or null with no terminal to ask in (a
// pipe, a scheduler): the caller then keeps its non-interactive default.
async function ttyAsk(question) {
  if (!process.stdin.isTTY) return null;
  const {createInterface} = await import('node:readline/promises');
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const ttyConfirm = async (question) => (await ttyAsk(question))?.trim().toLowerCase() === 'y';

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
  main(process.argv.slice(2), {confirm: ttyConfirm, ask: ttyAsk}).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`claudectl: ${e.message}\n`);
      process.exit(1);
    });
}
