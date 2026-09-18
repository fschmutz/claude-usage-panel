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
// claude-account CLI, the MCP tools, the status line, the tests - gets the
// same operations without threading paths through every call. It is also the
// ONE reader of the live login: the usage fetch for the MCP server and the
// Linux status bar goes through it too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {
  PROFILE_VERSION, accountSummary, activeAccountName, isValidName, parseProfile, tokenState,
  worstPercent,
} from './accounts-contract.js';
import {httpFailure, normalizeExtraUsage, normalizeUsage} from './normalize.js';
import {accountsDir, claudeConfigPath, credentialsPath} from './paths.js';

export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client - the same id the CLI itself refreshes with.
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;

/** macOS Keychain item names Claude Code has used, current first. Reads try
 *  each; writes update the first. */
export const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code', 'claude'];
const USAGE_CACHE_FILE = '.usage-cache.json';
const LAST_SWITCH_FILE = '.last-switch.json';
/** The status line trusts a cached usage snapshot this long. */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60_000;

// Atomic, private write: tmp file in the same dir, created 0600, renamed over.
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, {mode: 0o600});
  fs.renameSync(tmp, file);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

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
    for (const service of KEYCHAIN_SERVICES) {
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
      const m = /"acct"<blob>="([^"]*)"/.exec(security(['find-generic-password', '-s', KEYCHAIN_SERVICES[0]]));
      if (m) return m[1];
    } catch {
      // no item yet
    }
    return os.userInfo().username;
  }

  function writeLiveCredentials(credentials) {
    const text = JSON.stringify(credentials);
    if (platform === 'darwin' && !fs.existsSync(credsPath)) {
      // -U updates the existing item in place, so Claude Code's ACL on it stays.
      security(['add-generic-password', '-U', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICES[0], '-w', text],
        {stdio: ['ignore', 'ignore', 'ignore']});
      return;
    }
    writePrivate(credsPath, text);
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

  /**
   * Which saved profile the live login is. The credentials decide first: when
   * the live token is exactly one we installed, that profile is live whatever
   * the account block says (a switch that failed between its two writes leaves
   * them disagreeing). Otherwise Claude Code has rotated the token, and the
   * account block is the identity.
   */
  function liveAccountName() {
    const profiles = listProfiles();
    const token = liveAccessToken();
    const byToken = token && profiles.find((p) => p.credentials.claudeAiOauth.accessToken === token);
    return byToken?.name ?? activeAccountName(profiles, readLiveAccount());
  }

  // True when the live account block names a saved profile other than `name`:
  // the two halves of the login disagree, so nothing may be snapshotted.
  function liveIsTorn(name) {
    const byAccount = activeAccountName(listProfiles(), readLiveAccount());
    return byAccount !== null && byAccount !== name;
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
   * name, or null when the live login is not a saved one. A torn login (see
   * liveAccountName) is named but never written.
   */
  function syncBack() {
    if (!readLiveCredentials()) return null;
    const name = liveAccountName();
    if (!name) return null;
    if (liveIsTorn(name)) return name;
    const stored = readProfile(name);
    const same = stored &&
      JSON.stringify(stored.credentials) === JSON.stringify(readLiveCredentials()) &&
      JSON.stringify(stored.account) === JSON.stringify(readLiveAccount());
    if (!same) snapshotLive(name);
    return name;
  }

  /** Save the live login as `name`. `force` overrules a name that already
   *  holds a different account. Saving one account under a second name is
   *  refused outright: the store would then hold two profiles with one
   *  identity, `activeAccountName` would pick whichever came first, and an
   *  auto-switch between them would move nothing. */
  function saveCurrent(name, {force = false} = {}) {
    if (!isValidName(name)) {
      throw new Error(`invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
    }
    if (!readLiveCredentials()) throw new Error('no Claude Code login to save - run `claude auth login` first');
    const account = readLiveAccount() ?? {};
    const profiles = listProfiles();
    const existing = profiles.find((p) => p.name === name);
    if (existing && !force && account.accountUuid &&
        existing.account?.accountUuid && existing.account.accountUuid !== account.accountUuid) {
      throw new Error(`${name} is already ${existing.account.emailAddress ?? 'another account'} - pick another name or --force`);
    }
    // Not force-able: see above.
    const twin = activeAccountName(profiles.filter((p) => p.name !== name), account);
    if (twin) {
      throw new Error(`this login (${account.emailAddress ?? 'no email'}) is already saved as ` +
        `${twin} - \`claude-account remove ${twin}\` first if you meant to rename it`);
    }
    return snapshotLive(name);
  }

  // A live login that was never saved must not be lost by a switch: park it
  // under a name derived from its email ("admin", then "admin-2" …).
  function parkUnsavedLogin() {
    const account = readLiveAccount();
    if (!readLiveCredentials() || !account) return null;
    const taken = new Set(listProfiles().map((p) => p.name));
    const base = String(account.emailAddress ?? 'account').split('@')[0]
      .replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 28) || 'account';
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    return snapshotLive(name).name;
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

  // ── Tokens and usage ────────────────────────────────────────────────────────

  /**
   * Exchange the profile's refresh token for a new access token and store the
   * result. Throws with the HTTP status on failure. Never touches the live login.
   */
  async function refreshProfile(profile) {
    const oauth = profile.credentials.claudeAiOauth;
    if (!oauth.refreshToken) throw new Error(`${profile.name}: no refresh token - log in again and save it`);
    let response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`${profile.name}: token refresh failed - ${e.message}`);
    }
    if (!response.ok) {
      throw new Error(`${profile.name}: token refresh rejected (HTTP ${response.status})` +
        (response.status === 400 || response.status === 401 ? ' - log in again and save it' : ''));
    }
    const body = await response.json();
    if (typeof body?.access_token !== 'string' || !body.access_token) {
      throw new Error(`${profile.name}: token refresh returned no access token`);
    }
    const next = {...oauth, accessToken: body.access_token};
    if (Number.isFinite(Number(body.expires_in))) next.expiresAt = now() + Number(body.expires_in) * 1000;
    if (typeof body.refresh_token === 'string' && body.refresh_token) next.refreshToken = body.refresh_token;
    if (typeof body.scope === 'string') next.scopes = body.scope.split(/\s+/).filter(Boolean);
    return writeProfile({
      ...profile, savedAt: stamp(),
      credentials: {...profile.credentials, claudeAiOauth: next},
    });
  }

  /**
   * A usable access token for a saved account: the live one when that account
   * is the active login (Claude Code keeps it fresh), else the stored one,
   * refreshed first when stale.
   */
  async function accessTokenFor(name) {
    const profile = readProfile(name);
    if (!profile) throw new Error(`no saved account named ${name}`);
    if (liveAccountName() === name) {
      const token = liveAccessToken();
      if (token) return {token, source: 'live'};
    }
    switch (tokenState(profile, now())) {
      case 'valid':
        return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
      case 'stale': {
        const fresh = await refreshProfile(profile);
        return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
      }
      default:
        throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
  }

  /**
   * Fetch and normalize usage with one token. `label` names the account in
   * the auth-expired message; without it the message is the live-login one.
   * @returns {Promise<{ok: true, cards, extraUsage, raw}
   *                   | {ok: false, code: string, message: string}>}
   */
  async function fetchUsageWith(token, {label = null} = {}) {
    if (!token) {
      return {ok: false, code: 'no_token', message: 'No Claude credentials found. Sign in with Claude Code first.'};
    }
    let response;
    try {
      response = await fetchImpl(USAGE_ENDPOINT, {
        headers: {authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA_HEADER},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return {ok: false, code: 'network_error', message: e.message};
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false, code: 'auth_expired',
        message: label
          ? `${label}: usage endpoint refused the token`
          : 'Claude session expired. Run any Claude Code command to refresh it.',
      };
    }
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // no JSON body - the status alone is the message
      }
      const failure = httpFailure(response.status, body);
      return label ? {...failure, message: `${label}: ${failure.message}`} : failure;
    }
    try {
      const raw = await response.json();
      return {ok: true, raw, cards: normalizeUsage(raw), extraUsage: normalizeExtraUsage(raw)};
    } catch (e) {
      return {ok: false, code: 'parse_error', message: e.message};
    }
  }

  /** Usage for whatever login Claude Code holds now. */
  function fetchLiveUsage() {
    return fetchUsageWith(liveAccessToken());
  }

  /** Normalized usage for one saved account, or {ok: false, code, message}. */
  async function usageFor(name) {
    let token;
    try {
      ({token} = await accessTokenFor(name));
    } catch (e) {
      return {name, ok: false, code: 'no_token', message: e.message};
    }
    return {name, ...(await fetchUsageWith(token, {label: name}))};
  }

  /** Usage of every saved account, in parallel, keyed by name. */
  async function usageForAll() {
    const results = await Promise.all(listProfiles().map((p) => usageFor(p.name)));
    return Object.fromEntries(results.map((r) => [r.name, r]));
  }

  // The panels and the MCP server drop the latest per-account worst limit here
  // so the status line (no network, no credentials) can hint at a freer account.
  // `results` is usageForAll()'s shape: {name: {ok, cards}}.
  function writeUsageCache(results) {
    const accounts = {};
    for (const [name, r] of Object.entries(results)) {
      if (!r?.ok) continue;
      const pct = (key) => r.cards.find((c) => c.key === key)?.percent ?? null;
      accounts[name] = {worst: worstPercent(r.cards), session: pct('session'), weekly: pct('weekly_all')};
    }
    try {
      writePrivate(path.join(dir, USAGE_CACHE_FILE), JSON.stringify({at: now(), accounts}));
    } catch {
      // read-only state dir just means no hint in the status line
    }
  }

  /** The cached snapshot when fresh enough, else null. */
  function readUsageCache(maxAgeMs = USAGE_CACHE_MAX_AGE_MS) {
    const cache = readJSON(path.join(dir, USAGE_CACHE_FILE));
    if (!cache || !Number.isFinite(cache.at) || now() - cache.at > maxAgeMs) return null;
    return cache.accounts && typeof cache.accounts === 'object' ? cache : null;
  }

  // ── Switch ──────────────────────────────────────────────────────────────────

  // Make `profile` the live login: validate the config BEFORE the first write,
  // then the account block, then the credentials. Whatever fails in between,
  // liveAccountName() still recognizes the installed token, so no snapshot
  // ever carries one account's tokens into another's profile.
  function installLogin(profile) {
    const cfg = readConfig();
    writeLiveAccount(cfg, profile.account);
    writeLiveCredentials(profile.credentials);
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
    const from = syncBack() ?? parkUnsavedLogin();
    const email = target.account.emailAddress ?? null;
    if (from === name) {
      if (liveIsTorn(name)) installLogin(target); // finish an interrupted switch
      return {from, to: name, changed: false, running: runningClaudeCount(), email};
    }
    const state = tokenState(target, now());
    if (state === 'expired') {
      throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
    if (state === 'stale') target = await refreshProfile(target);
    installLogin(target);
    writeLastSwitch({from, to: name});
    return {from, to: name, changed: true, running: runningClaudeCount(), email};
  }

  /**
   * What every "list" shows: the saved accounts with the active one marked,
   * optionally each one's usage (which also refreshes the status line's cache).
   * Shared by the CLI and the MCP list_accounts tool.
   */
  async function listAccounts({usage = false} = {}) {
    syncBack();
    const profiles = listProfiles();
    const active = liveAccountName();
    const results = usage ? await usageForAll() : {};
    if (usage) writeUsageCache(results);
    const accounts = profiles.map((p) => {
      const r = results[p.name];
      return {
        ...accountSummary(p, now()), active: p.name === active,
        cards: r?.ok ? r.cards : null,
        error: r && !r.ok ? r.message : null,
      };
    });
    return {active, accounts, live: readLiveAccount()};
  }

  return {
    dir, credentialsPath: credsPath, configPath,
    listProfiles, readProfile, writeProfile, removeProfile,
    readLiveCredentials, liveAccessToken, readLiveAccount, liveAccountName,
    syncBack, saveCurrent, runningClaudeCount,
    writeLastSwitch, readLastSwitchMs,
    refreshProfile, accessTokenFor, switchTo,
    fetchUsageWith, fetchLiveUsage, usageFor, usageForAll, writeUsageCache, readUsageCache,
    listAccounts,
  };
}
