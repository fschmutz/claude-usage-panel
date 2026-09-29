// Named Claude Code accounts, the I/O half: save the login Claude Code holds
// right now under a name ("PRO", "PERSO"), and switch between the saved ones
// without a browser. The decisions (what a profile is, which saved login is
// live, token state, the auto-switch rule) are in accounts-contract.js.
//
// A login is two things: the credentials blob (~/.claude/.credentials.json on
// Linux, the "Claude Code-credentials" login-Keychain item on macOS) and the
// `oauthAccount` block of ~/.claude.json (who the account is). Switching swaps
// exactly those two and touches nothing else - settings, hooks, plugins, MCP
// servers and history stay. Claude Code sessions already running keep the old
// token until they restart; `switchTo` says how many there are.
//
// Saved logins live one file per account under the panel's state dir (0600).
// Claude Code rotates its tokens as it runs, so before every switch the live
// login is written back into its own profile (the stored copy would otherwise
// die with the old refresh token). An idle profile's access token expires
// within hours; it is refreshed with its refresh token when it is needed - for
// the switch, or to read that account's usage - and the rotated tokens are
// written to OUR store only. The live login is Claude Code's to refresh.
//
// `openStore(io)` binds all of this to one home dir, platform, clock, fetch
// and exec (every one overridable, read at call time) so every consumer - the
// claudectl CLI, the MCP tools, the status line, the tests - gets the
// same operations without threading paths through every call. It is also the
// ONE reader of the live login: the usage fetch for the MCP server and the
// Linux status bar goes through it too. The token and usage half (refresh,
// accessTokenFor, the usage fetch and its cache) is accounts-usage.js, bound
// here to the same io.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {
  PROFILE_VERSION, accountSummary, isTorn, isValidName, keychainServices, keychainWriteLine,
  liveProfileName, parkName, parseProfile, saveRefusal, sameJSON, switchPlan, syncBackPlan, tokenState,
} from './accounts-contract.js';
import {bindUsage, coded} from './accounts-usage.js';
import {accountHealth, accountNotices} from './notices.js';
import {accountsDir, claudeConfigPath, credentialsPath} from './paths.js';
import {readJSON, writePrivate} from './private-fs.js';

export {
  OAUTH_BETA_HEADER, OAUTH_CLIENT_ID, OAUTH_TOKEN_ENDPOINT, USAGE_CACHE_MAX_AGE_MS, USAGE_ENDPOINT,
} from './accounts-usage.js';

const LAST_SWITCH_FILE = '.last-switch.json';
// A switch in progress: {at, from, to}, written before the live login is
// touched and removed once both halves are installed. While it is there no
// port snapshots the live login (see syncBackPlan).
const SWITCH_PENDING_FILE = '.switch-pending.json';

const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The credentials blob as the store keeps it: `{claudeAiOauth: {accessToken,
 * …}}`. The one place that knows the shapes Claude Code has written: the
 * current nested form, and the older flat `access_token` / `token` forms,
 * which are lifted into the nested one so every consumer sees one shape.
 */
function parseCredentials(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const oauth = json.claudeAiOauth && typeof json.claudeAiOauth === 'object' ? json.claudeAiOauth : json;
  const token = oauth.accessToken ?? oauth.access_token ?? oauth.token;
  if (typeof token !== 'string' || !token) return null;
  if (json.claudeAiOauth && oauth.accessToken === token) return json;
  const {access_token: _a, token: _t, ...rest} = oauth;
  return {claudeAiOauth: {...rest, accessToken: token}};
}

// ── The store ───────────────────────────────────────────────────────────────────

/**
 * Bind the account store to one environment. `io` overrides, all optional:
 * homedir, platform, env, tmpdir, nowMs, exec (execFileSync), fetchImpl
 * (fetch), dir, credentialsPath, configPath. Defaults are the real process.
 */
export function openStore(io = {}) {
  const platform = io.platform ?? process.platform;
  // Read at call time, not bind time: a caller may swap the fake fetch, exec
  // or clock on the same io between operations (the tests do).
  const exec = (...a) => (io.exec ?? execFileSync)(...a);
  const fetchImpl = (...a) => (io.fetchImpl ?? globalThis.fetch)(...a);
  const now = () => io.nowMs ?? Date.now();
  const env = io.env ?? process.env;
  // Claude Code's Keychain item for THIS config dir (CLAUDE_CONFIG_DIR moves it).
  const services = keychainServices(env, sha256Hex);
  const dir = io.dir ?? accountsDir(io);
  const credsPath = io.credentialsPath ?? credentialsPath(io);
  const configPath = io.configPath ?? claudeConfigPath(io);

  const profilePath = (name) => path.join(dir, `${name}.json`);
  const stamp = () => new Date(now()).toISOString();
  const security = (args, opts = {}) =>
    exec('/usr/bin/security', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts});

  /** Every valid profile, by name in code-point order (like every port). */
  function listProfiles() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out = [];
    for (const file of names) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      const profile = parseProfile(readJSON(path.join(dir, file)));
      if (profile && `${profile.name}.json` === file) out.push(profile);
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function readProfile(name) {
    if (!isValidName(name)) return null;
    const profile = parseProfile(readJSON(profilePath(name)));
    return profile?.name === name ? profile : null;
  }

  function writeProfile(profile) {
    const clean = parseProfile(profile);
    if (!clean) throw new Error('not a valid profile');
    writePrivate(profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
    return clean;
  }

  function removeProfile(name) {
    if (!readProfile(name)) throw new Error(`no saved account named ${name}`);
    fs.rmSync(profilePath(name), {force: true});
  }

  // ── The live login ──────────────────────────────────────────────────────────

  /** The credentials Claude Code holds now (file, else the macOS Keychain). */
  function readLiveCredentials() {
    try {
      const creds = parseCredentials(fs.readFileSync(credsPath, 'utf8'));
      if (creds) return creds;
    } catch {
      // fall through
    }
    if (platform !== 'darwin') return null;
    for (const service of services) {
      try {
        const creds = parseCredentials(security(['find-generic-password', '-s', service, '-w']).trim());
        if (creds) return creds;
      } catch {
        // try the next item name
      }
    }
    return null;
  }

  /** The live access token, or null. */
  function liveAccessToken() {
    return readLiveCredentials()?.claudeAiOauth.accessToken ?? null;
  }

  // macOS keeps the item under the login user's account name; reuse whatever
  // Claude Code wrote so the item we update is the one it reads.
  function keychainAccount() {
    try {
      const m = /"acct"<blob>="([^"]*)"/.exec(security(['find-generic-password', '-s', services[0]]));
      if (m) return m[1];
    } catch {
      // no item yet
    }
    return os.userInfo().username;
  }

  /**
   * Everything the credentials write needs, resolved and checked BEFORE the
   * first live write, so a write that cannot happen throws while the login is
   * still whole. Returns the write itself.
   */
  function prepareLiveCredentials(credentials) {
    const text = JSON.stringify(credentials);
    if (platform !== 'darwin' || fs.existsSync(credsPath)) return () => writePrivate(credsPath, text);
    // -U updates the existing item in place, so Claude Code's ACL on it
    // stays. The tokens go on stdin, never in argv (keychainWriteLine).
    const line = keychainWriteLine(keychainAccount(), services[0], text);
    if (!line) {
      throw new Error(`cannot write the Keychain item ${services[0]} through \`security -i\`: `
        + 'its account name cannot be quoted, or the credentials are too large for one command line');
    }
    return () => {
      security(['-i'], {input: line, stdio: ['pipe', 'ignore', 'ignore']});
      // `security -i` exits 0 whatever its command did: read the item back.
      let back = null;
      try {
        back = security(['find-generic-password', '-s', services[0], '-w']).trim();
      } catch {
        // no item: the write failed
      }
      if (back !== text) throw new Error(`could not write the Keychain item ${services[0]}`);
    };
  }

  /** ~/.claude.json as an object; throws when the file is not one. */
  function readConfig() {
    const cfg = readJSON(configPath);
    if (cfg === null) return {};
    if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${configPath} is not a JSON object`);
    return cfg;
  }

  /** The `oauthAccount` block of ~/.claude.json, or null. */
  function readLiveAccount() {
    const acct = readJSON(configPath)?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
  }

  // Patch ONLY oauthAccount into an already-validated config; every other key survives.
  function writeLiveAccount(cfg, account) {
    writePrivate(configPath, `${JSON.stringify({...cfg, oauthAccount: account}, null, 2)}\n`);
  }

  /** Which saved profile the live login is (token first; liveProfileName). */
  function liveAccountName() {
    return liveProfileName(listProfiles(), liveAccessToken(), readLiveAccount());
  }

  const pendingPath = () => path.join(dir, SWITCH_PENDING_FILE);

  /** The unfinished switch ({at, from, to}), or null. */
  function readPendingSwitch() {
    const p = readJSON(pendingPath());
    return p && typeof p === 'object' && isValidName(p.to) ? p : null;
  }

  function snapshotLive(name) {
    return writeProfile({
      version: PROFILE_VERSION, name, savedAt: stamp(),
      account: readLiveAccount() ?? {}, credentials: readLiveCredentials(),
    });
  }

  /**
   * Write the live login back into its own profile, so the tokens Claude Code
   * rotated since the last switch are the ones we keep. Returns the profile
   * name, or null when the live login is not a saved one. A torn login, one
   * without an account block, or one an unfinished switch left behind is
   * named but never written (syncBackPlan).
   */
  function syncBack() {
    const creds = readLiveCredentials();
    if (!creds) return null;
    const account = readLiveAccount();
    const profiles = listProfiles();
    const plan = syncBackPlan(profiles, {token: creds.claudeAiOauth.accessToken, account},
      readPendingSwitch());
    if (plan.pendingDone) fs.rmSync(pendingPath(), {force: true});
    if (!plan.name || !plan.snapshot) return plan.name;
    const stored = profiles.find((p) => p.name === plan.name);
    const same = stored && sameJSON(stored.credentials, creds) && sameJSON(stored.account, account);
    if (!same) snapshotLive(plan.name);
    return plan.name;
  }

  /** Save the live login as `name`. `force` overrules a name that already
   *  holds a different account, never a case variant or a twin (saveRefusal). */
  function saveCurrent(name, {force = false} = {}) {
    if (!isValidName(name)) {
      throw new Error(`invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    if (!readLiveCredentials()) throw new Error('no Claude Code login to save - run `claude auth login` first');
    const account = readLiveAccount() ?? {};
    const refusal = saveRefusal(listProfiles(), name, account, force);
    if (refusal?.kind === 'variant') {
      throw new Error(`${refusal.profile} already exists - names ignore case, use ${refusal.profile}`);
    }
    if (refusal?.kind === 'taken') {
      throw new Error(`${name} is already ${refusal.email ?? 'another account'} - pick another name or --force`);
    }
    if (refusal) {
      throw new Error(`this login (${account.emailAddress ?? 'no email'}) is already saved as ` +
        `${refusal.profile} - \`claudectl account remove ${refusal.profile}\` first if you meant to rename it`);
    }
    return snapshotLive(name);
  }

  // A live login that was never saved must not be lost by a switch: park it
  // under a name derived from its email ("admin", then "admin-2" …).
  function parkUnsavedLogin() {
    const account = readLiveAccount();
    if (!readLiveCredentials() || !account) return null;
    return snapshotLive(parkName(account.emailAddress, listProfiles().map((p) => p.name))).name;
  }

  /** Claude Code processes alive right now - they keep the old token. */
  function runningClaudeCount() {
    try {
      const out = exec('ps', ['-eo', 'args='], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      return out.split('\n').filter((l) => /(^|\/)claude(\s|$)/.test(l.trim())).length;
    } catch {
      return 0;
    }
  }

  // The last switch is store state, so a switch made by the CLI, the MCP tool
  // or the other panel counts toward every caller's auto-switch cooldown.
  function writeLastSwitch({from, to}) {
    writePrivate(path.join(dir, LAST_SWITCH_FILE), JSON.stringify({at: now(), from, to}));
  }

  /** When the last switch happened (epoch ms), or null. */
  function readLastSwitchMs() {
    const at = readJSON(path.join(dir, LAST_SWITCH_FILE))?.at;
    return Number.isFinite(at) ? at : null;
  }

  const usage = bindUsage({
    dir, now, fetchImpl, stamp, readProfile, writeProfile, listProfiles, liveAccountName, liveAccessToken,
  });

  // ── Switch ──────────────────────────────────────────────────────────────────

  // Make `profile` the live login: validate the config and resolve the
  // credentials write (prepareLiveCredentials) BEFORE the first write,
  // mark the switch pending, then the account block, then the credentials,
  // then clear the mark. Whatever fails in between leaves the mark, and no
  // port snapshots the live login while it stands - even once Claude Code has
  // rotated the old token past any match - until a switch finishes the job.
  function installLogin(profile, from) {
    const cfg = readConfig();
    const writeCredentials = prepareLiveCredentials(profile.credentials);
    writePrivate(pendingPath(), JSON.stringify({at: now(), from: from ?? null, to: profile.name}));
    writeLiveAccount(cfg, profile.account);
    writeCredentials();
    fs.rmSync(pendingPath(), {force: true});
  }

  /**
   * Make `name` the live login. Order matters: the live login is synced back
   * (or parked under a new name if it was never saved) BEFORE anything is
   * overwritten, and the target is refreshed BEFORE it is installed, so a
   * refresh failure leaves the current login untouched. Re-running after an
   * interrupted switch finishes it.
   */
  async function switchTo(name) {
    let target = readProfile(name);
    if (!target) throw new Error(`no saved account named ${name}`);
    // The live login by its account block, with credentials we cannot read:
    // refreshing or reinstalling the stored copy would spend or overwrite the
    // refresh token Claude Code is running on. Wait for it to be readable.
    if (!readLiveCredentials() && liveAccountName() === name) {
      throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
    }
    const synced = syncBack();
    const plan = switchPlan({
      name, synced, pending: readPendingSwitch(),
      torn: isTorn(listProfiles(), name, readLiveAccount()), state: tokenState(target, now()),
    });
    const from = plan.park ? parkUnsavedLogin() : plan.from;
    const email = target.account.emailAddress ?? null;
    if (plan.action === 'stay' || plan.action === 'repair') {
      if (plan.action === 'repair') installLogin(target, from); // finish an interrupted switch
      return {from, to: name, changed: false, running: runningClaudeCount(), email};
    }
    if (plan.action === 'expired') {
      throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
    if (plan.action === 'refresh') target = await usage.refreshProfile(target);
    installLogin(target, from);
    writeLastSwitch({from, to: name});
    return {from, to: name, changed: true, running: runningClaudeCount(), email};
  }

  /**
   * What every "list" shows: the saved accounts with the active one marked,
   * optionally each one's usage (which also refreshes the status line's cache).
   * Shared by the CLI and the MCP list_accounts tool.
   */
  async function listAccounts({usage: withUsage = false} = {}) {
    syncBack();
    const profiles = listProfiles();
    const active = liveAccountName();
    const results = withUsage ? await usage.usageForAll() : {};
    if (withUsage) usage.writeUsageCache(results);
    const accounts = profiles.map((p) => {
      const r = results[p.name];
      const summary = accountSummary(p, now());
      return {
        ...summary, active: p.name === active,
        cards: r?.ok ? r.cards : null,
        error: r && !r.ok ? r.message : null,
        // The stored dates alone call a refused token "valid"; health folds in
        // what the fetch actually said, so every client reports the same thing.
        // A live token's refusal is Claude Code's to refresh, not the
        // profile's: it reads unreachable, like the panels' active row.
        health: accountHealth({
          tokenState: summary.tokenState, errorCode: r && !r.ok ? r.code : null, live: r?.source === 'live',
        }),
      };
    });
    const live = readLiveAccount();
    const pendingSwitch = readPendingSwitch();
    return {
      active, accounts, live, pendingSwitch,
      notices: accountNotices({
        rows: accounts.map((a) => ({name: a.name, health: a.health})),
        liveEmail: typeof live?.emailAddress === 'string' ? live.emailAddress : null,
        activeName: active, pending: pendingSwitch,
        torn: active !== null && isTorn(profiles, active, live),
      }),
    };
  }

  return {
    dir, credentialsPath: credsPath, configPath, now,
    listProfiles, readProfile, writeProfile, removeProfile,
    readLiveCredentials, liveAccessToken, readLiveAccount, liveAccountName, readPendingSwitch,
    syncBack, saveCurrent, runningClaudeCount,
    writeLastSwitch, readLastSwitchMs, switchTo, listAccounts,
    ...usage,
  };
}
