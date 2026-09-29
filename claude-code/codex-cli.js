// `claudectl codex`: the command-line face of claude-code/codex.js. Save the
// ChatGPT login the `codex` CLI holds now under a name, list the saved ones,
// switch, forget. claudectl.js dispatches here.
//
// Deliberately smaller than `claudectl account`: there is no `refresh` command
// because nothing in this project mints a Codex token (that grant is the CLI's
// to use), and `usage` reports only what the Codex CLI itself recorded, marked
// as the estimate it is.

import {openCodexStore} from './codex.js';
import {codexIdentity} from './codex-contract.js';
import {resetHint} from './stamps.js';

export const HELP = `claudectl codex - named OpenAI Codex logins, switch without a browser

  claudectl codex list [--json]          saved Codex logins, the active one marked
  claudectl codex current [--json]       the active Codex login's name
  claudectl codex save NAME [--force]    save the current Codex login as NAME
  claudectl codex use NAME [--json]      make NAME the current Codex login
  claudectl codex remove NAME            forget a saved Codex login
  claudectl codex usage [--json]         the newest rate limits the Codex CLI recorded

A saved login is the auth.json the Codex CLI wrote, kept mode 0600. Switching
replaces exactly that file; config, history and sessions stay, and running
Codex processes keep the old login until restarted. Nothing is uploaded, and no
token is ever minted here - a login the CLI must re-authenticate reads
"expired" and \`codex login\` is the fix.

OpenAI publishes no plan-usage endpoint, so \`usage\` reports the rate limits the
Codex CLI itself recorded on its last turn. They are real figures, read at that
moment and not now, and are labelled est. accordingly.`;

// The store's directories are the caller's (io), so they are added at print time.
const helpText = (store) => `${HELP}\n\n  logins:   ${store.dir}\n  reads:    ${store.authPath}`;

const WHY = {
  no_sessions: 'no Codex sessions on this machine yet - nothing has recorded a limit',
  no_snapshot: 'the recent Codex sessions carry no rate limits',
  stale: 'the newest recorded reading is too old to mean anything now',
};

export async function main(argv, io = {}) {
  const store = openCodexStore(io);
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const [cmd, name] = args;
  const nowMs = io.nowMs ?? Date.now();

  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
      out(`${helpText(store)}\n`);
      return 0;
    case 'list': {
      const {active, accounts, live} = store.listAccounts();
      if (json) {
        out(`${JSON.stringify({active, accounts}, null, 2)}\n`);
        return 0;
      }
      if (!accounts.length) {
        out('no saved Codex logins - `claudectl codex save NAME` saves the current one\n');
        return 0;
      }
      for (const a of accounts) {
        out(`${a.active ? '*' : ' '} ${a.name.padEnd(12)} ${(a.email ?? '').padEnd(32)} ` +
          `${(a.planLabel || '?').padEnd(8)} ${a.tokenState}\n`);
      }
      if (!active && live) {
        const id = codexIdentity(live);
        out(`  (current Codex login ${id.email ?? 'unknown'} is not saved yet)\n`);
      }
      return 0;
    }
    case 'current': {
      const active = store.liveCodexName();
      const id = codexIdentity(store.readLiveAuth());
      out(json
        ? `${JSON.stringify({name: active, email: id.email, plan: id.plan})}\n`
        : `${active ?? `(not saved: ${id.email ?? 'no Codex login'})`}\n`);
      return active ? 0 : 1;
    }
    case 'save': {
      if (!name) throw new Error('save needs a NAME');
      const p = store.saveCurrent(name, {force: flags.has('--force')});
      const id = codexIdentity(p.auth);
      out(json ? `${JSON.stringify({name: p.name, email: id.email, plan: id.plan})}\n`
        : `saved ${p.name} (${id.email ?? 'unknown account'})\n`);
      return 0;
    }
    case 'use': {
      if (!name) throw new Error('use needs a NAME');
      const r = store.switchTo(name);
      if (json) {
        out(`${JSON.stringify(r)}\n`);
      } else if (!r.changed) {
        out(`${name} is already the current Codex login\n`);
      } else {
        out(`switched ${r.from ?? '?'} -> ${r.to}\n`);
        if (r.tokenState === 'expired') {
          out(`${r.to} needs a new sign-in - run \`codex login\`, then \`claudectl codex save ${r.to} --force\`\n`);
        } else if (r.tokenState === 'stale') {
          out(`${r.to}'s token is due a refresh - the codex CLI will do it on the next turn\n`);
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
    case 'usage': {
      const {cards, capturedAt, reason} = store.recordedUsage();
      if (json) {
        out(`${JSON.stringify({cards, capturedAt, reason, provenance: 'estimated'}, null, 2)}\n`);
        return reason ? 1 : 0;
      }
      if (reason) {
        out(`Codex usage unavailable: ${WHY[reason] ?? reason}\n`);
        return 1;
      }
      for (const c of cards) {
        const reset = resetHint(c.resetsAt, nowMs);
        out(`${c.label.padEnd(14)} ${String(c.percent).padStart(3)}%` +
          `${reset ? `  resets in ${reset}` : ''}\n`);
      }
      out(`est. - recorded by the codex CLI at ${capturedAt}, not read now\n`);
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${helpText(store)}`);
  }
}
