#!/usr/bin/env node
// Named Claude Code accounts: save the login Claude Code holds right now under a
// name ("PRO", "PERSO"), and switch between the saved ones without a browser.
//
// A login is two things: the credentials blob (~/.claude/.credentials.json on
// Linux, the "Claude Code-credentials" login-Keychain item on macOS) and the
// `oauthAccount` block of ~/.claude.json (who the account is). Switching swaps
// exactly those two and touches nothing else - settings, hooks, plugins, MCP
// servers and history stay. Claude Code sessions already running keep the old
// token until they restart; `use` says how many there are.
//
// Saved logins live one file per account under the panel's state dir (0600).
// Claude Code rotates its tokens as it runs, so before every switch the live
// login is written back into its own profile (the stored copy would otherwise
// die with the old refresh token). An idle profile's access token expires
// within hours; it is refreshed with its refresh token when it is needed - for
// the switch, or to read that account's usage - and the rotated tokens are
// written to OUR store only. The live login is Claude Code's to refresh.
//
// This file is the one shared implementation for the Node clients (the MCP
// server, the status line, and the `claude-account` CLI - `main` below). The
// GNOME extension (lib/accounts.js) and the macOS app (Accounts.swift) mirror
// it; tests/fixtures/accounts.json pins the decisions all three must agree on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

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

/** The fullest limit of a set of cards (any port's normalized cards). */
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

/** 100 minus the worst limit; null without cards. */
export function headroom(cards) {
  const worst = worstPercent(cards);
  return worst === null ? null : 100 - worst;
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

// ── Paths ───────────────────────────────────────────────────────────────────────

function ctx(io = {}) {
  const homedir = io.homedir ?? os.homedir();
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homedir, '.claude');
  return {
    homedir,
    env,
    platform,
    nowMs: io.nowMs ?? Date.now(),
    exec: io.exec ?? execFileSync,
    fetchImpl: io.fetchImpl ?? globalThis.fetch,
    dir: io.dir ?? accountsDir({homedir, platform, env}),
    credentialsPath: io.credentialsPath ?? path.join(configDir, '.credentials.json'),
    // ~/.claude.json follows CLAUDE_CONFIG_DIR when that is set.
    configPath: io.configPath ??
      (env.CLAUDE_CONFIG_DIR ? path.join(configDir, '.claude.json') : path.join(homedir, '.claude.json')),
  };
}

/** Same root as the usage warehouse, so every client reads one store. */
export function accountsDir({homedir = os.homedir(), platform = process.platform, env = process.env} = {}) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'claude-usage-panel', 'accounts');
  }
  const state = env.XDG_STATE_HOME || path.join(homedir, '.local', 'state');
  return path.join(state, 'claude-usage-panel', 'accounts');
}

function profilePath(name, c) {
  return path.join(c.dir, `${name}.json`);
}

// Atomic, private write: tmp file in the same dir, then rename over.
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

// ── Store ───────────────────────────────────────────────────────────────────────

/** Every valid profile in the store, by name. Unreadable files are skipped. */
export function listProfiles(io) {
  const c = ctx(io);
  let names;
  try {
    names = fs.readdirSync(c.dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const profile = parseProfile(readJSON(path.join(c.dir, file)));
    if (profile && `${profile.name}.json` === file) out.push(profile);
  }
  // Code-point order, like the auto-switch tie-break - identical in every port.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readProfile(name, io) {
  if (!isValidName(name)) return null;
  const profile = parseProfile(readJSON(profilePath(name, ctx(io))));
  return profile?.name === name ? profile : null;
}

export function writeProfile(profile, io) {
  const c = ctx(io);
  const clean = parseProfile(profile);
  if (!clean) throw new Error('not a valid profile');
  writePrivate(profilePath(clean.name, c), `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

export function removeProfile(name, io) {
  const c = ctx(io);
  if (!readProfile(name, io)) throw new Error(`no saved account named ${name}`);
  fs.rmSync(profilePath(name, c), {force: true});
}

// ── The live login ──────────────────────────────────────────────────────────────

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

// macOS keeps the item under the login user's account name; reuse whatever
// Claude Code wrote so the item we update is the one it reads.
function keychainAccount(c) {
  try {
    const out = c.exec('/usr/bin/security',
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
export function readLiveCredentials(io) {
  const c = ctx(io);
  try {
    const creds = parseCredentials(fs.readFileSync(c.credentialsPath, 'utf8'));
    if (creds) return creds;
  } catch {
    // fall through
  }
  if (c.platform === 'darwin') {
    try {
      const raw = c.exec('/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
      return parseCredentials(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function writeLiveCredentials(credentials, io) {
  const c = ctx(io);
  const text = JSON.stringify(credentials);
  if (c.platform === 'darwin' && !fs.existsSync(c.credentialsPath)) {
    // -U updates the existing item in place, so Claude Code's ACL on it stays.
    c.exec('/usr/bin/security',
      ['add-generic-password', '-U', '-a', keychainAccount(c), '-s', KEYCHAIN_SERVICE, '-w', text],
      {stdio: ['ignore', 'ignore', 'ignore']});
    return;
  }
  writePrivate(c.credentialsPath, text);
}

/** The `oauthAccount` block of ~/.claude.json, or null. */
export function readLiveAccount(io) {
  const c = ctx(io);
  const cfg = readJSON(c.configPath);
  const acct = cfg?.oauthAccount;
  return acct && typeof acct === 'object' ? acct : null;
}

function writeLiveAccount(account, io) {
  const c = ctx(io);
  const cfg = readJSON(c.configPath) ?? {};
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${c.configPath} is not a JSON object`);
  cfg.oauthAccount = account;
  writePrivate(c.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** The saved name of the live login, or null when it was never saved. */
export function liveAccountName(io) {
  return activeAccountName(listProfiles(io), readLiveAccount(io));
}

/**
 * Write the live login back into its own profile, so the tokens Claude Code
 * rotated since the last switch are the ones we keep. Returns the profile
 * name, or null when the live login is not a saved one.
 */
export function syncBack(io) {
  const c = ctx(io);
  const creds = readLiveCredentials(io);
  const account = readLiveAccount(io);
  if (!creds || !account) return null;
  const name = activeAccountName(listProfiles(io), account);
  if (!name) return null;
  const stored = readProfile(name, io);
  const same = stored && JSON.stringify(stored.credentials) === JSON.stringify(creds) &&
    JSON.stringify(stored.account) === JSON.stringify(account);
  if (!same) {
    writeProfile({
      version: PROFILE_VERSION, name, savedAt: new Date(c.nowMs).toISOString(),
      account, credentials: creds,
    }, io);
  }
  return name;
}

/** Save the live login as `name`. Refuses to shadow another account's name
 *  or to save one account twice, unless `force`. */
export function saveCurrent(name, io, {force = false} = {}) {
  const c = ctx(io);
  if (!isValidName(name)) {
    throw new Error(`invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
  }
  const creds = readLiveCredentials(io);
  if (!creds) throw new Error('no Claude Code login to save - run `claude auth login` first');
  const account = readLiveAccount(io) ?? {};
  const profiles = listProfiles(io);
  const existing = profiles.find((p) => p.name === name);
  if (existing && !force && account.accountUuid &&
      existing.account?.accountUuid && existing.account.accountUuid !== account.accountUuid) {
    throw new Error(`${name} is already ${existing.account.emailAddress ?? 'another account'} - pick another name or --force`);
  }
  const twin = activeAccountName(profiles.filter((p) => p.name !== name), account);
  if (twin && !force) {
    throw new Error(`this login is already saved as ${twin} - remove it first or --force`);
  }
  return writeProfile({
    version: PROFILE_VERSION, name, savedAt: new Date(c.nowMs).toISOString(),
    account, credentials: creds,
  }, io);
}

// A live login that was never saved must not be lost by a switch: park it
// under a name derived from its email ("admin", then "admin-2" …).
function parkUnsavedLogin(io) {
  const creds = readLiveCredentials(io);
  const account = readLiveAccount(io);
  if (!creds || !account) return null;
  const taken = new Set(listProfiles(io).map((p) => p.name));
  const base = String(account.emailAddress ?? 'account').split('@')[0]
    .replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 28) || 'account';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return writeProfile({
    version: PROFILE_VERSION, name, savedAt: new Date(ctx(io).nowMs).toISOString(),
    account, credentials: creds,
  }, io).name;
}

/** Claude Code processes alive right now - they keep the old token. */
export function runningClaudeCount(io) {
  const c = ctx(io);
  try {
    const out = c.exec('ps', ['-eo', 'args='], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return out.split('\n').filter((l) => /(^|\/)claude(\s|$)/.test(l.trim())).length;
  } catch {
    return 0;
  }
}

// ── Token refresh (our store only) ──────────────────────────────────────────────

/**
 * Exchange the profile's refresh token for a new access token and store the
 * result. Throws with the HTTP status on failure. Never touches the live login.
 */
export async function refreshProfile(profile, io) {
  const c = ctx(io);
  const oauth = profile.credentials.claudeAiOauth;
  if (!oauth.refreshToken) throw new Error(`${profile.name}: no refresh token - log in again and save it`);
  let response;
  try {
    response = await c.fetchImpl(OAUTH_TOKEN_ENDPOINT, {
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
  if (Number.isFinite(Number(body.expires_in))) next.expiresAt = c.nowMs + Number(body.expires_in) * 1000;
  if (typeof body.refresh_token === 'string' && body.refresh_token) next.refreshToken = body.refresh_token;
  if (typeof body.scope === 'string') next.scopes = body.scope.split(/\s+/).filter(Boolean);
  return writeProfile({
    ...profile, savedAt: new Date(c.nowMs).toISOString(),
    credentials: {...profile.credentials, claudeAiOauth: next},
  }, io);
}

/**
 * A usable access token for a saved account: the live one when that account
 * is the active login (Claude Code keeps it fresh), else the stored one,
 * refreshed first when stale.
 */
export async function accessTokenFor(name, io) {
  const profile = readProfile(name, io);
  if (!profile) throw new Error(`no saved account named ${name}`);
  if (liveAccountName(io) === name) {
    const live = readLiveCredentials(io);
    if (live) return {token: live.claudeAiOauth.accessToken, source: 'live'};
  }
  const c = ctx(io);
  switch (tokenState(profile, c.nowMs)) {
    case 'valid':
      return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
    case 'stale': {
      const fresh = await refreshProfile(profile, io);
      return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
    }
    default:
      throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
  }
}

// ── Switch ──────────────────────────────────────────────────────────────────────

/**
 * Make `name` the live login. Order matters: the live login is synced back
 * (or parked under a new name if it was never saved) BEFORE anything is
 * overwritten, and the target is refreshed BEFORE it is installed, so a
 * refresh failure leaves the current login untouched.
 */
export async function switchTo(name, io) {
  const c = ctx(io);
  let target = readProfile(name, io);
  if (!target) throw new Error(`no saved account named ${name}`);
  const from = syncBack(io) ?? parkUnsavedLogin(io);
  if (from === name) {
    return {from, to: name, changed: false, running: runningClaudeCount(io), email: target.account.emailAddress ?? null};
  }
  const state = tokenState(target, c.nowMs);
  if (state === 'expired') {
    throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
  }
  if (state === 'stale') target = await refreshProfile(target, io);
  writeLiveCredentials(target.credentials, io);
  writeLiveAccount(target.account, io);
  return {
    from, to: name, changed: true, running: runningClaudeCount(io),
    email: target.account.emailAddress ?? null,
  };
}

// ── Per-account usage ───────────────────────────────────────────────────────────

/** Percent per limit kind from a raw usage payload - enough to rank accounts
 *  without a full normalizer. Modern limits[] first, legacy fields after. */
export function limitPercents(raw) {
  const out = {};
  const limits = Array.isArray(raw?.limits) ? raw.limits : [];
  for (const l of limits) {
    if (!l || typeof l !== 'object' || !l.kind) continue;
    const p = Number(l.percent ?? l.utilization);
    if (!Number.isFinite(p)) continue;
    const key = l.scope?.model?.display_name ? `${l.kind}:${l.scope.model.display_name}` : String(l.kind);
    out[key] = Math.max(0, Math.min(100, Math.round(p)));
  }
  if (!limits.length) {
    for (const [legacy, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']]) {
      const p = Number(raw?.[legacy]?.utilization);
      if (Number.isFinite(p)) out[kind] = Math.max(0, Math.min(100, Math.round(p)));
    }
  }
  return out;
}

/** Raw usage for one saved account (any port normalizes it), or an error. */
export async function usageFor(name, io) {
  const c = ctx(io);
  let token;
  try {
    ({token} = await accessTokenFor(name, io));
  } catch (e) {
    return {name, ok: false, code: 'no_token', message: e.message};
  }
  let response;
  try {
    response = await c.fetchImpl(USAGE_ENDPOINT, {
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
    return {name, ok: true, raw, percents: limitPercents(raw)};
  } catch (e) {
    return {name, ok: false, code: 'parse_error', message: e.message};
  }
}

/** Usage of every saved account, in parallel. */
export async function usageForAll(io) {
  const profiles = listProfiles(io);
  const results = await Promise.all(profiles.map((p) => usageFor(p.name, io)));
  const map = {};
  for (const r of results) map[r.name] = r;
  return map;
}

// The panels and the MCP server drop the latest per-account worst-limit here
// so the status line (no network, no credentials) can hint at a freer account.
export function usageCachePath(io) {
  return path.join(ctx(io).dir, USAGE_CACHE_FILE);
}

export function writeUsageCache(results, io) {
  const c = ctx(io);
  const accounts = {};
  for (const [name, r] of Object.entries(results)) {
    if (r?.ok) {
      accounts[name] = {
        worst: worstPercent(Object.entries(r.percents).map(([, percent]) => ({percent}))),
        session: r.percents.session ?? null,
        weekly: r.percents.weekly_all ?? null,
      };
    }
  }
  try {
    writePrivate(usageCachePath(io), JSON.stringify({at: c.nowMs, accounts}));
  } catch {
    // read-only state dir just means no hint in the status line
  }
}

/** The cached snapshot when fresh enough, else null. */
export function readUsageCache(io, maxAgeMs = USAGE_CACHE_MAX_AGE_MS) {
  const c = ctx(io);
  const cache = readJSON(usageCachePath(io));
  if (!cache || !Number.isFinite(cache.at) || c.nowMs - cache.at > maxAgeMs) return null;
  return cache.accounts && typeof cache.accounts === 'object' ? cache : null;
}

/** Worst limit per saved account from the cache, for autoSwitchTarget. */
export function worstFromCache(cache) {
  const out = {};
  for (const [name, v] of Object.entries(cache?.accounts ?? {})) {
    out[name] = Number.isFinite(v?.worst) ? v.worst : null;
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────

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

function fmtPercents(p) {
  const s = p.session ?? null;
  const w = p.weekly_all ?? null;
  return `${s === null ? '-' : `S ${s}%`}  ${w === null ? '-' : `W ${w}%`}`;
}

export async function main(argv, io = {}) {
  const c = ctx(io);
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
      syncBack(io);
      const profiles = listProfiles(io);
      const active = liveAccountName(io);
      const usage = flags.has('--usage') ? await usageForAll(io) : {};
      if (flags.has('--usage')) writeUsageCache(usage, io);
      const rows = profiles.map((p) => ({
        ...accountSummary(p, c.nowMs), active: p.name === active,
        ...(usage[p.name] ? {usage: usage[p.name].ok ? usage[p.name].percents : null,
          error: usage[p.name].ok ? null : usage[p.name].message} : {}),
      }));
      if (json) {
        out(`${JSON.stringify({active, accounts: rows}, null, 2)}\n`);
        return 0;
      }
      if (!rows.length) {
        out('no saved accounts - `claude-account save NAME` saves the current login\n');
        return 0;
      }
      for (const r of rows) {
        const mark = r.active ? '*' : ' ';
        const tail = r.usage ? `  ${fmtPercents(r.usage)}` : (r.error ? `  ${r.error}` : '');
        out(`${mark} ${r.name.padEnd(12)} ${(r.email ?? '').padEnd(32)} ${(r.plan ?? '?').padEnd(5)} ${r.tokenState}${tail}\n`);
      }
      const live = readLiveAccount(io);
      if (!active && live?.emailAddress) out(`  (current login ${live.emailAddress} is not saved yet)\n`);
      return 0;
    }
    case 'current': {
      const active = liveAccountName(io);
      const live = readLiveAccount(io);
      if (json) {
        out(`${JSON.stringify({name: active, email: live?.emailAddress ?? null})}\n`);
      } else {
        out(`${active ?? `(not saved: ${live?.emailAddress ?? 'no login'})`}\n`);
      }
      return active ? 0 : 1;
    }
    case 'save': {
      if (!name) throw new Error('save needs a NAME');
      const p = saveCurrent(name, io, {force: flags.has('--force')});
      out(json ? `${JSON.stringify(accountSummary(p, c.nowMs))}\n`
        : `saved ${p.name} (${p.account.emailAddress ?? 'unknown email'})\n`);
      return 0;
    }
    case 'use': {
      if (!name) throw new Error('use needs a NAME');
      const r = await switchTo(name, io);
      if (json) {
        out(`${JSON.stringify(r)}\n`);
      } else if (!r.changed) {
        out(`${name} is already the current login\n`);
      } else {
        out(`switched ${r.from ?? '?'} -> ${r.to} (${r.email ?? ''})\n`);
        if (r.running > 0) {
          out(`${r.running} Claude Code session${r.running > 1 ? 's' : ''} still running on the old login - restart to use ${r.to}\n`);
        }
      }
      return 0;
    }
    case 'remove': {
      if (!name) throw new Error('remove needs a NAME');
      removeProfile(name, io);
      out(`removed ${name}\n`);
      return 0;
    }
    case 'refresh': {
      const targets = name ? [readProfile(name, io)].filter(Boolean) : listProfiles(io);
      if (name && !targets.length) throw new Error(`no saved account named ${name}`);
      const active = liveAccountName(io);
      for (const p of targets) {
        if (p.name === active) {
          out(`${p.name}: active login, Claude Code refreshes it itself\n`);
          continue;
        }
        const fresh = await refreshProfile(p, io);
        out(`${p.name}: refreshed, valid until ${new Date(fresh.credentials.claudeAiOauth.expiresAt).toISOString()}\n`);
      }
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}\n${HELP}`);
  }
}

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
