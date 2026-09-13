// Named Claude Code accounts: save the login Claude Code holds right now under a
// name ("PRO", "PERSO"), and switch between the saved ones without a browser.
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
// Two halves: the pure contract at the top (what a profile is, which saved
// login is live, token state, the auto-switch rule - pinned by
// tests/fixtures/accounts.json across this file, lib/pure.js and
// Accounts.swift), and `openStore(io)`, which binds the I/O to one home dir,
// platform, clock and fetch so every consumer (the claude-account CLI, the MCP
// tools, the status line, the tests) gets the same operations without
// threading paths through every call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {normalizeUsage} from './normalize.js';

export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client - the same id the CLI itself refreshes with.
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const FETCH_TIMEOUT_MS = 10_000;

/** Refresh an access token this close to its expiry rather than use it. */
export const REFRESH_LEAD_MS = 5 * 60_000;
/** Auto-switch contract - mirrored by the panels, pinned by the fixture. */
export const AUTO_SWITCH = {threshold: 90, margin: 15, cooldownMs: 5 * 60_000};
/** Profile names are file names: one path segment, no leading dot or dash. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const PROFILE_VERSION = 1;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USAGE_CACHE_FILE = '.usage-cache.json';
const LAST_SWITCH_FILE = '.last-switch.json';
/** The status line trusts a cached usage snapshot this long. */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60_000;

// ── Pure contract (tests/fixtures/accounts.json) ────────────────────────────────

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** A stored profile, validated; null for anything that is not one. */
export function parseProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isValidName(raw.name)) return null;
  const oauth = raw.credentials?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return null;
  if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) return null;
  const account = raw.account && typeof raw.account === 'object' ? raw.account : {};
  return {
    version: PROFILE_VERSION,
    name: raw.name,
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null,
    account,
    credentials: {...raw.credentials, claudeAiOauth: {...oauth}},
  };
}

/**
 * valid   - the access token is good for at least REFRESH_LEAD_MS
 * stale   - the access token is (about to be) expired; the refresh token can
 *           mint a new one. Also the answer when the dates are unknown.
 * expired - the refresh token is gone too; only a new login helps.
 */
export function tokenState(profile, nowMs = Date.now(), leadMs = REFRESH_LEAD_MS) {
  const oauth = profile?.credentials?.claudeAiOauth ?? {};
  const refreshUntil = Number(oauth.refreshTokenExpiresAt);
  if (!oauth.refreshToken) return 'expired';
  if (Number.isFinite(refreshUntil) && refreshUntil <= nowMs) return 'expired';
  const until = Number(oauth.expiresAt);
  if (Number.isFinite(until) && until - nowMs > leadMs) return 'valid';
  return 'stale';
}

export function accountSummary(profile, nowMs = Date.now()) {
  const oauth = profile.credentials.claudeAiOauth;
  const acct = profile.account ?? {};
  return {
    name: profile.name,
    email: typeof acct.emailAddress === 'string' ? acct.emailAddress : null,
    accountUuid: typeof acct.accountUuid === 'string' ? acct.accountUuid : null,
    plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    tier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier
      : (typeof acct.organizationRateLimitTier === 'string' ? acct.organizationRateLimitTier : null),
    tokenState: tokenState(profile, nowMs),
  };
}

/** Which saved profile the live login is - by account id, else by email. */
export function activeAccountName(profiles, live) {
  if (!live || typeof live !== 'object') return null;
  const uuid = typeof live.accountUuid === 'string' ? live.accountUuid : null;
  if (uuid) {
    const hit = profiles.find((p) => p.account?.accountUuid === uuid);
    if (hit) return hit.name;
  }
  const email = typeof live.emailAddress === 'string' ? live.emailAddress.toLowerCase() : null;
  if (email) {
    const hit = profiles.find((p) => String(p.account?.emailAddress ?? '').toLowerCase() === email);
    if (hit) return hit.name;
  }
  return null;
}

/** The fullest limit of a set of normalized cards; null without cards. */
export function worstPercent(cards) {
  let worst = null;
  for (const c of cards ?? []) {
    const p = Number(c?.percent);
    if (!Number.isFinite(p)) continue;
    const clamped = Math.max(0, Math.min(100, Math.round(p)));
    worst = worst === null ? clamped : Math.max(worst, clamped);
  }
  return worst;
}

/**
 * The account to switch to, or null to stay. `worst` maps each saved name to
 * its worst limit percent (null = usage unknown). Switch only when the active
 * account is at/over the threshold, to the candidate with the most headroom,
 * and only if that candidate sits at least `margin` points under the
 * threshold (so two busy accounts do not ping-pong); never within the
 * cooldown of the previous switch.
 */
export function autoSwitchTarget({
  active, worst, threshold = AUTO_SWITCH.threshold, margin = AUTO_SWITCH.margin,
  cooldownMs = AUTO_SWITCH.cooldownMs, lastSwitchMs = null, nowMs = Date.now(),
}) {
  if (!active || !worst || typeof worst !== 'object') return null;
  const activePercent = worst[active];
  if (!Number.isFinite(activePercent) || activePercent < threshold) return null;
  if (Number.isFinite(lastSwitchMs) && nowMs - lastSwitchMs < cooldownMs) return null;
  let best = null;
  for (const name of Object.keys(worst).sort()) {
    if (name === active) continue;
    const p = worst[name];
    if (!Number.isFinite(p) || p > threshold - margin) continue;
    if (!best || p < best.percent) best = {name, percent: p};
  }
  if (!best) return null;
  return {from: active, to: best.name, activePercent, targetPercent: best.percent};
}

/** Worst limit per saved account from a usage-cache snapshot, for autoSwitchTarget. */
export function worstFromCache(cache) {
  const out = {};
  for (const [name, v] of Object.entries(cache?.accounts ?? {})) {
    out[name] = Number.isFinite(v?.worst) ? v.worst : null;
  }
  return out;
}

// ── Paths ───────────────────────────────────────────────────────────────────────

/** Same root as the usage warehouse, so every client reads one store. */
export function accountsDir({homedir = os.homedir(), platform = process.platform, env = process.env} = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'claude-usage-panel', 'accounts');
  }
  const state = env.XDG_STATE_HOME || path.join(homedir, '.local', 'state');
  return path.join(state, 'claude-usage-panel', 'accounts');
}

/** Where Claude Code keeps the live credentials (follows CLAUDE_CONFIG_DIR). */
export function credentialsPath({homedir = os.homedir(), env = process.env} = {}) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude'), '.credentials.json');
}

/** ~/.claude.json, which moves into CLAUDE_CONFIG_DIR when that is set. */
export function claudeConfigPath({homedir = os.homedir(), env = process.env} = {}) {
  return env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(homedir, '.claude.json');
}

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

function parseCredentials(text) {
  try {
    const json = JSON.parse(text);
    const oauth = json?.claudeAiOauth;
    if (oauth && typeof oauth === 'object' && typeof oauth.accessToken === 'string') return json;
  } catch {
    // not credentials
  }
  return null;
}

// ── The store ───────────────────────────────────────────────────────────────────

/**
 * Bind the account store to one environment. `io` overrides, all optional:
 * homedir, platform, env, nowMs, exec (execFileSync), fetchImpl (fetch), dir,
 * credentialsPath, configPath. Defaults are the real process.
 */
export function openStore(io = {}) {
  const homedir = io.homedir ?? os.homedir();
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  // Read at call time, not bind time: a caller may swap the fake fetch, exec
  // or clock on the same io between operations (the tests do).
  const exec = (...a) => (io.exec ?? execFileSync)(...a);
  const fetchImpl = (...a) => (io.fetchImpl ?? globalThis.fetch)(...a);
  const now = () => io.nowMs ?? Date.now();
  const dir = io.dir ?? accountsDir({homedir, platform, env});
  const credsPath = io.credentialsPath ?? credentialsPath({homedir, env});
  const configPath = io.configPath ?? claudeConfigPath({homedir, env});

  const profilePath = (name) => path.join(dir, `${name}.json`);
  const stamp = () => new Date(now()).toISOString();

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

  // macOS keeps the item under the login user's account name; reuse whatever
  // Claude Code wrote so the item we update is the one it reads.
  function keychainAccount() {
    try {
      const out = exec('/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      const m = /"acct"<blob>="([^"]*)"/.exec(out);
      if (m) return m[1];
    } catch {
      // no item yet
    }
    return os.userInfo().username;
  }

  /** The credentials Claude Code holds now (file, else the macOS Keychain). */
  function readLiveCredentials() {
    try {
      const creds = parseCredentials(fs.readFileSync(credsPath, 'utf8'));
      if (creds) return creds;
    } catch {
      // fall through
    }
    if (platform !== 'darwin') return null;
    try {
      const raw = exec('/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
      return parseCredentials(raw);
    } catch {
      return null;
    }
  }

  function writeLiveCredentials(credentials) {
    const text = JSON.stringify(credentials);
    if (platform === 'darwin' && !fs.existsSync(credsPath)) {
      // -U updates the existing item in place, so Claude Code's ACL on it stays.
      exec('/usr/bin/security',
        ['add-generic-password', '-U', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE, '-w', text],
        {stdio: ['ignore', 'ignore', 'ignore']});
      return;
    }
    writePrivate(credsPath, text);
  }

  /** The `oauthAccount` block of ~/.claude.json, or null. */
  function readLiveAccount() {
    const acct = readJSON(configPath)?.oauthAccount;
    return acct && typeof acct === 'object' ? acct : null;
  }

  // Patch ONLY oauthAccount; every other key survives.
  function writeLiveAccount(account) {
    const cfg = readJSON(configPath) ?? {};
    if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${configPath} is not a JSON object`);
    cfg.oauthAccount = account;
    writePrivate(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }

  /** The saved name of the live login, or null when it was never saved. */
  function liveAccountName() {
    return activeAccountName(listProfiles(), readLiveAccount());
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
   * name, or null when the live login is not a saved one.
   */
  function syncBack() {
    const creds = readLiveCredentials();
    const account = readLiveAccount();
    if (!creds || !account) return null;
    const name = activeAccountName(listProfiles(), account);
    if (!name) return null;
    const stored = readProfile(name);
    const same = stored && JSON.stringify(stored.credentials) === JSON.stringify(creds) &&
      JSON.stringify(stored.account) === JSON.stringify(account);
    if (!same) snapshotLive(name);
    return name;
  }

  /** Save the live login as `name`. Refuses to shadow another account's name
   *  or to save one account twice, unless `force`. */
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
    const twin = activeAccountName(profiles.filter((p) => p.name !== name), account);
    if (twin && !force) {
      throw new Error(`this login is already saved as ${twin} - remove it first or --force`);
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
      const live = readLiveCredentials();
      if (live) return {token: live.claudeAiOauth.accessToken, source: 'live'};
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
   * Make `name` the live login. Order matters: the live login is synced back
   * (or parked under a new name if it was never saved) BEFORE anything is
   * overwritten, and the target is refreshed BEFORE it is installed, so a
   * refresh failure leaves the current login untouched.
   */
  async function switchTo(name) {
    let target = readProfile(name);
    if (!target) throw new Error(`no saved account named ${name}`);
    const from = syncBack() ?? parkUnsavedLogin();
    const email = target.account.emailAddress ?? null;
    if (from === name) return {from, to: name, changed: false, running: runningClaudeCount(), email};
    const state = tokenState(target, now());
    if (state === 'expired') {
      throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
    }
    if (state === 'stale') target = await refreshProfile(target);
    writeLiveCredentials(target.credentials);
    writeLiveAccount(target.account);
    writeLastSwitch({from, to: name});
    return {from, to: name, changed: true, running: runningClaudeCount(), email};
  }

  /** Normalized usage for one saved account, or {ok: false, code, message}. */
  async function usageFor(name) {
    let token;
    try {
      ({token} = await accessTokenFor(name));
    } catch (e) {
      return {name, ok: false, code: 'no_token', message: e.message};
    }
    let response;
    try {
      response = await fetchImpl(USAGE_ENDPOINT, {
        headers: {authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA_HEADER},
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      return {name, ok: false, code: 'network_error', message: e.message};
    }
    if (response.status === 401 || response.status === 403) {
      return {name, ok: false, code: 'auth_expired', message: `${name}: usage endpoint refused the token`};
    }
    if (!response.ok) return {name, ok: false, code: 'http_error', message: `HTTP ${response.status}`};
    try {
      const raw = await response.json();
      return {name, ok: true, raw, cards: normalizeUsage(raw)};
    } catch (e) {
      return {name, ok: false, code: 'parse_error', message: e.message};
    }
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
    readLiveCredentials, readLiveAccount, liveAccountName,
    syncBack, saveCurrent, runningClaudeCount,
    writeLastSwitch, readLastSwitchMs,
    refreshProfile, accessTokenFor, switchTo,
    usageFor, usageForAll, writeUsageCache, readUsageCache, listAccounts,
  };
}
