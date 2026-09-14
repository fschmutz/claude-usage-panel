#!/usr/bin/env node
// claude-account: the command-line face of claude-code/accounts.js. Save the
// login Claude Code holds now under a name, list the saved ones (with their
// usage), switch, forget, refresh. `main` is exported for the tests; the file
// runs it when invoked directly (also through the npm bin shim).

import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

import {openStore} from './accounts.js';
import {tokenState} from './accounts-contract.js';
import {accountsDir} from './paths.js';

const HELP = `claude-account - named Claude Code accounts, switch without a browser

  claude-account list [--usage] [--json]   saved accounts, the active one marked
  claude-account current [--json]          the active account's name
  claude-account save NAME [--force]       save the current login as NAME
  claude-account use NAME [--json]         make NAME the current login
  claude-account remove NAME               forget a saved account
  claude-account refresh [NAME]            refresh the stored token(s) now

Names: letters, digits, . _ - (e.g. PRO, PERSO). Running Claude Code sessions
keep their old login until restarted. Saved logins are kept, mode 0600, under
${accountsDir()}`;

// "S 42%  W 12%" from normalized cards; "-" for a window the account lacks.
function fmtUsage(cards) {
  const pct = (key) => cards.find((c) => c.key === key)?.percent;
  const cell = (label, p) => (p === undefined ? '-' : `${label} ${p}%`);
  return `${cell('S', pct('session'))}  ${cell('W', pct('weekly_all'))}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function main(argv, io = {}) {
  const store = openStore(io);
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const [cmd, name] = args;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
      out(`${HELP}\n`);
      return 0;
    case 'list': {
      const {active, accounts, live} = await store.listAccounts({usage: flags.has('--usage')});
      if (json) {
        out(`${JSON.stringify({active, accounts}, null, 2)}\n`);
        return 0;
      }
      if (!accounts.length) {
        out('no saved accounts - `claude-account save NAME` saves the current login\n');
        return 0;
      }
      for (const a of accounts) {
        const tail = a.cards ? `  ${fmtUsage(a.cards)}` : (a.error ? `  ${a.error}` : '');
        out(`${a.active ? '*' : ' '} ${a.name.padEnd(12)} ${(a.email ?? '').padEnd(32)} ` +
          `${(a.plan ?? '?').padEnd(5)} ${a.tokenState}${tail}\n`);
      }
      if (!active && live?.emailAddress) out(`  (current login ${live.emailAddress} is not saved yet)\n`);
      return 0;
    }
    case 'current': {
      const active = store.liveAccountName();
      const live = store.readLiveAccount();
      out(json
        ? `${JSON.stringify({name: active, email: live?.emailAddress ?? null})}\n`
        : `${active ?? `(not saved: ${live?.emailAddress ?? 'no login'})`}\n`);
      return active ? 0 : 1;
    }
    case 'save': {
      if (!name) throw new Error('save needs a NAME');
      const p = store.saveCurrent(name, {force: flags.has('--force')});
      out(json ? `${JSON.stringify({name: p.name, email: p.account.emailAddress ?? null})}\n`
        : `saved ${p.name} (${p.account.emailAddress ?? 'unknown email'})\n`);
      return 0;
    }
    case 'use': {
      if (!name) throw new Error('use needs a NAME');
      const r = await store.switchTo(name);
      if (json) {
        out(`${JSON.stringify(r)}\n`);
      } else if (!r.changed) {
        out(`${name} is already the current login\n`);
      } else {
        out(`switched ${r.from ?? '?'} -> ${r.to} (${r.email ?? ''})\n`);
        if (r.running > 0) {
          out(`${plural(r.running, 'Claude Code session')} still running on the old login - restart to use ${r.to}\n`);
        }
      }
      return 0;
    }
    case 'remove': {
      if (!name) throw new Error('remove needs a NAME');
      store.removeProfile(name);
      out(`removed ${name}\n`);
      return 0;
    }
    case 'refresh': {
      const targets = name ? [store.readProfile(name)].filter(Boolean) : store.listProfiles();
      if (name && !targets.length) throw new Error(`no saved account named ${name}`);
      const active = store.liveAccountName();
      for (const p of targets) {
        if (p.name === active) {
          out(`${p.name}: active login, Claude Code refreshes it itself\n`);
          continue;
        }
        const fresh = await store.refreshProfile(p);
        const until = fresh.credentials.claudeAiOauth.expiresAt;
        out(`${p.name}: refreshed, ${Number.isFinite(until)
          ? `valid until ${new Date(until).toISOString()}` : tokenState(fresh)}\n`);
      }
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
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
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`claude-account: ${e.message}\n`);
      process.exit(1);
    });
}
