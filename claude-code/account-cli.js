// `claudectl account`: the command-line face of claude-code/accounts.js. Save
// the login Claude Code holds now under a name, list the saved ones (with
// their usage), switch, forget, refresh. claudectl.js dispatches here.

import {openAccountChrome} from './account-chrome.js';
import {openChromeCheck} from './account-chrome-check.js';
import {openAccountExec} from './account-exec.js';
import {DEFAULT_WAIT_S, openAccountLogin} from './account-login.js';
import {openStore} from './accounts.js';
import {nowOf} from './paths.js';
import {tokenState} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {usageReading} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';

export const HELP = `claudectl account - named Claude Code accounts, switch without a browser

  claudectl account list [--usage] [--json]   saved accounts, the active one marked
  claudectl account current [--json]          the active account's name
  claudectl account save NAME [--force]       save the current login as NAME
  claudectl account use NAME [--json]         make NAME the current login
  claudectl account rename NAME NEW           rename a saved account
  claudectl account remove NAME               forget a saved account
  claudectl account refresh [NAME]            refresh the stored token(s) now
  claudectl account exec NAME -- CMD [ARG...]  run CMD as NAME, the current login untouched
  claudectl account chrome [NAME] [--url=U] [--dry-run] [--check [--json]]
                                              an isolated Chrome signed in to claude.ai as NAME
                                              (default: the current login); --check probes it
  claudectl account login NAME|--expired [--wait=S] [--dry-run] [--json]
                                              a fresh sign-in for a dead saved login, one click

Names: letters, digits, . _ - (e.g. PRO, PERSO), case-insensitive. Running
Claude Code sessions keep their old login until restarted. Saved logins are
kept, mode 0600, in the accounts directory below.`;

// The store's directory is the caller's (io), so it is added at print time.
/** One paragraph per command, after its synopsis in `<command> --help`. */
export const DETAILS = {
  list: `Every saved account, the one Claude Code is logged in as marked, with
each token's state (valid, stale near expiry, expired). --usage also fetches
each account's plan usage, refreshing a stale saved token first.`,
  current: `The saved name of the login Claude Code uses now (matched by its token,
then its account), or a note that it is not saved.`,
  save: `Saves the login Claude Code uses now under NAME. --force replaces an
existing NAME. Names collide ignoring case.`,
  use: `Makes NAME the login Claude Code uses: the current login is first saved
back into its own profile (or parked under its email), and a stale NAME is
refreshed before it is installed, so a failed refresh changes nothing.
Running sessions keep their old login until restarted.`,
  rename: `Renames saved account NAME to NEW, keeping its login, its cached
usage and its kept weekly reset. The login Claude Code uses now is not
touched. NEW must be free, ignoring case; changing only the case is fine.`,
  remove: `Forgets NAME. The login Claude Code uses now is not touched.`,
  exec: `Runs CMD with a throwaway Claude Code config dir holding only NAME's
login (CLAUDE_CONFIG_DIR), so \`claude -p ...\` and anything else reading the
Claude login acts as NAME while the current login, running sessions and
~/.claude stay as they are. A stale token is refreshed first; a token the
command rotates is written back to NAME. The dir carries no settings, hooks
or MCP servers and is removed when CMD exits. Exits with CMD's code. The
current login itself is refused (run the command directly).`,
  chrome: `Opens Google Chrome with a profile of its own for NAME, the current
login when NAME is left out (kept, mode 0700, in the state dir; the main
Chrome profile is never written). Claude-in-Chrome pairs a browser with the
sessions of the same claude.ai account, so a session on NAME (the current
login, or \`account exec NAME\`) drives this window and no other. Each launch
prints the profile's state (claude.ai signed in or not, extension installed
or missing) and opens claude.ai/login only when it is signed out. A missing
extension is installed before Chrome starts: copied from a profile of the
main Chrome that has it, else downloaded from the Web Store's update service,
and registered with the permissions its manifest declares (Linux; not while
that profile's Chrome runs). Only when that cannot happen does the Web Store
page open. Then --url (default claude.ai). The extension's
native-messaging manifest is laid in the profile on every launch, naming the
live login's host, which Claude Code writes on its first /chrome. --only opens
--url alone, whatever is missing (what \`account login\` uses).
--check opens nothing: it probes Claude-in-Chrome as NAME (\`claude -p
--chrome\`, tabs_context_mcp, through \`account exec\` for a saved login that
is not the current one) and prints CONNECTED, NOT CONNECTED with the reasons
read from the files (native host, manifests, extension, sign-in, Chrome
running), or INCONCLUSIVE; then probes every other saved account, one after
the other, to tell which one the extension answers. Each probe is a short
\`claude -p\` run on that account (up to 2 min). --json prints the result.
Exit 0 only when CONNECTED.`,
  login: `A fresh sign-in for saved account NAME (or, with --expired, for every
saved login whose token is gone or refused, the current one aside), the
current login untouched. \`claude auth login\` runs in a throwaway config dir
and opens its page in NAME's own Chrome (\`account chrome\`, signed in to
claude.ai as NAME): click Authorize there and the login ends by itself, and
is saved into NAME. A login that comes back as another account is not saved.
--wait=S gives up after S seconds (default ${DEFAULT_WAIT_S}). --dry-run says what would run.
The current login itself is refused (run \`claude auth login\` directly).
Ctrl-C stops the batch. --json prints one row per account: {name, ok, email,
tokenState} or {name, ok: false, error}, and {name, email, dryRun} with
--dry-run. Exit 0 when every sign-in landed (or none was needed), else 1.`,
  refresh: `Refreshes the stored token of NAME, or of every saved login. The login
Claude Code uses now is never refreshed here: Claude Code holds the same
single-use refresh token.`,
};

const helpText = (store) => `${HELP}\n  ${store.dir}`;

// "S 42%  W 12%" from normalized cards; "-" for a window the account lacks,
// and the no-reading dash for one with no honest reading (a placeholder, or a
// window that already rolled over) - never its stale figure.
function fmtUsage(cards, nowMs) {
  const cell = (label, key) => {
    const card = cards.find((c) => c.key === key);
    return card ? `${label} ${usageReading(card, nowMs).text}` : '-';
  };
  return `${cell('S', 'session')}  ${cell('W', 'weekly_all')}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function main(argv, io = {}) {
  // exec first: everything after `--` is the command's, flags included
  if (argv[0] === 'exec') {
    const sep = argv.indexOf('--');
    const name = argv[1];
    if (!name || name === '--' || sep < 0) throw new Error('usage: claudectl account exec NAME -- CMD [ARG...]');
    return openAccountExec(io).exec(name, argv.slice(sep + 1), {stdio: io.stdio ?? 'inherit'});
  }
  const store = openStore(io);
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  if (argv[0] === 'chrome') return chromeCmd(argv.slice(1), io, out);
  if (argv[0] === 'login') return login(argv.slice(1), io, out);
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const [cmd, name, newName] = args;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
      out(`${helpText(store)}\n`);
      return 0;
    case 'list': {
      const {active, accounts, live, pendingSwitch} = await store.listAccounts({usage: flags.has('--usage')});
      if (json) {
        out(`${JSON.stringify({active, accounts}, null, 2)}\n`);
        return 0;
      }
      if (!accounts.length) {
        out('no saved accounts - `claudectl account save NAME` saves the current login\n');
        return 0;
      }
      for (const a of accounts) {
        const tail = a.cards ? `  ${fmtUsage(a.cards, nowOf(io))}` : (a.error ? `  ${a.error}` : '');
        out(`${a.active ? '*' : ' '} ${a.name.padEnd(12)} ${(a.email ?? '').padEnd(32)} ` +
          `${(a.plan ?? '?').padEnd(5)} ${a.tokenState}${tail}\n`);
      }
      if (!active && live?.emailAddress) out(`  (current login ${live.emailAddress} is not saved yet)\n`);
      if (pendingSwitch) {
        out(`  (the switch to ${pendingSwitch.to} did not finish - \`claudectl account use ${pendingSwitch.to}\` ` +
          'completes it)\n');
      }
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
    case 'rename': {
      if (!name || !newName) throw new Error('rename needs a NAME and a NEW name');
      const p = await store.renameProfile(name, newName);
      out(json ? `${JSON.stringify({from: name, to: p.name})}\n` : `renamed ${name} -> ${p.name}\n`);
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
      // One dead login must not keep the others from being refreshed.
      let failed = 0;
      for (const p of targets) {
        if (p.name === active) {
          out(`${p.name}: active login, Claude Code refreshes it itself\n`);
          continue;
        }
        let fresh;
        try {
          fresh = await store.refreshProfile(p);
        } catch (e) {
          failed++;
          out(`${e.message.startsWith(`${p.name}: `) ? e.message : `${p.name}: ${e.message}`}\n`);
          continue;
        }
        const until = fresh.credentials.claudeAiOauth.expiresAt;
        out(`${p.name}: refreshed, ${Number.isFinite(until)
          ? `valid until ${new Date(until).toISOString()}` : tokenState(fresh)}\n`);
      }
      return failed ? 1 : 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${helpText(store)}`);
  }
}

/** `account login NAME | --expired [--wait=S] [--dry-run] [--json]`. */
const signedInText = (v) => (v === true ? 'signed in' : v === false ? 'NOT signed in' : 'unknown');

/** `account chrome [NAME] [--url=U] [--only] [--dry-run] [--check [--json]]`. */
async function chromeCmd(argv, io, out) {
  const name = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const url = argv.find((a) => a.startsWith('--url='))?.slice('--url='.length);
  if (argv.includes('--check')) {
    const err = io.stderr ?? ((s) => process.stderr.write(s));
    const r = await openChromeCheck(io).check(name, {onProbe: (n) => err(`probing Claude-in-Chrome as ${n}...\n`)});
    if (argv.includes('--json')) {
      out(`${JSON.stringify(r, null, 2)}\n`);
      return r.connected ? 0 : 1;
    }
    out(`${r.name}: ${r.verdict.toUpperCase().replace('-', ' ')} - ${r.detail}\n`);
    for (const why of r.reasons) out(`  - ${why}\n`);
    out(`${r.name}'s own Chrome: claude.ai ${signedInText(r.own.signedIn)}, extension ` +
      `${r.own.extension ? 'installed' : 'missing'}, ${r.own.running ? 'running' : 'not running'}\n`);
    if (r.main) {
      out(`main Chrome: extension in ${r.main.profiles.length ? r.main.profiles.join(', ') : 'no profile'}, ` +
        `${r.main.running ? 'running' : 'not running'}, native host ${r.main.host ?? 'not laid'}\n`);
    }
    const answered = r.probes.filter((p) => p.verdict === 'connected');
    out(answered.length
      ? `answered: ${answered.map((p) => `${p.name} (${p.where})`).join(', ')}\n`
      : `answered: no saved account (${r.probes.map((p) => `${p.name} ${p.verdict}`).join(', ')})\n`);
    return r.connected ? 0 : 1;
  }
  const chrome = openAccountChrome(io);
  const opts = {url, only: argv.includes('--only')};
  const dry = argv.includes('--dry-run');
  const p = dry ? chrome.plan(name, opts) : await chrome.launch(name, opts);
  out(`${dry ? 'would open' : 'opened'} Chrome for ${p.name}: ${p.dir}\n`);
  out(`  claude.ai: ${signedInText(p.signedIn)}${p.signedIn === false && !opts.only
    ? ` - sign in as ${p.name} in the claude.ai/login tab (the emailed link); kept for next time` : ''}\n`);
  let ext;
  if (p.installed) ext = `installed now, ${p.installed.version} from ${p.installed.from}`;
  else if (p.extension) ext = 'installed';
  else if (p.installError) ext = `MISSING - the install failed (${p.installError}); click "Add to Chrome" in the Web Store tab`;
  else if (dry && p.install.from) ext = `MISSING - would install it from ${p.install.from}`;
  else ext = `MISSING - ${p.install.why ?? 'not installable here'}; click "Add to Chrome" in the Web Store tab`;
  out(`  extension: ${ext}\n`);
  out(`  tabs: ${p.argv.slice(p.argv.indexOf('--new-window') + 1).join(' ')}\n`);
  return 0;
}

async function login(argv, io, out) {
  const names = argv.filter((a) => !a.startsWith('--'));
  const all = argv.includes('--expired');
  const dry = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const waitArg = argv.find((a) => a.startsWith('--wait='));
  const waitS = waitArg ? Number(waitArg.slice('--wait='.length)) : DEFAULT_WAIT_S;
  if (all === (names.length === 1) || names.length > 1 || !(Number.isInteger(waitS) && waitS > 0)) {
    throw new Error('usage: claudectl account login NAME|--expired [--wait=S] [--dry-run] [--json]');
  }
  const l = openAccountLogin(io);
  const targets = all ? await l.expired() : names;
  if (!targets.length) {
    out(json ? '[]\n' : 'no saved login needs a new sign-in\n');
    return 0;
  }
  const rows = [];
  let failed = 0;
  // One login that fails (or times out) must not keep the others from theirs.
  for (const name of targets) {
    try {
      if (dry) {
        const p = l.plan(name);
        rows.push({name: p.name, email: p.email, dryRun: true});
        if (!json) {
          out(`${p.name}: would run claude auth login${p.email ? ` --email ${p.email}` : ''} in a throwaway ` +
            `config dir, its page in ${p.name}'s Chrome; the current login untouched\n`);
        }
        continue;
      }
      const r = await l.login(name, {waitS, onWaiting: (p) => {
        if (!json) out(`${p.name}: ${p.name}'s Chrome opens on the sign-in page - click Authorize (waiting ${waitS}s)\n`);
      }});
      rows.push({...r, ok: true});
      if (!json) out(`${r.name}: signed in again (${r.email ?? 'unknown email'}), token ${r.tokenState}\n`);
    } catch (e) {
      failed++;
      rows.push({name, ok: false, error: e.message});
      if (!json) out(`${e.message.startsWith(`${name}: `) ? e.message : `${name}: ${e.message}`}\n`);
      if (e.interrupted) break;
    }
  }
  if (json) out(`${JSON.stringify(rows, null, 2)}\n`);
  return failed ? 1 : 0;
}
