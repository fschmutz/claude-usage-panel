// Named accounts, the token and usage half of the store: exchange a stored
// login's refresh token, pick the token a saved account's usage is read with,
// fetch and normalize that usage, and keep the status line's usage cache.
// accounts.js binds it to the same io as the rest of the store (openStore);
// nothing here is a second store.
//
// Two rules decide everything below:
//   - A saved name that resolves to the live login is NEVER refreshed. Its
//     refresh token is the one Claude Code holds; spending it here would
//     rotate Claude Code's login, and the next syncBack would write the spent
//     token back over the live one. When the live token cannot be read (a
//     locked Keychain, a credentials file caught mid-rewrite) the answer is
//     `no_token`, never a refresh of the stored copy.
//   - A refresh token is single-use, and several processes poll one store. The
//     exchange runs under a per-profile lock file (REFRESH_LOCK), re-reads the
//     profile once it holds it, and never spends a token another process has
//     already spent (refreshRaced).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  REFRESH_LOCK, refreshFailureCode, refreshLockFile, refreshRaced, refreshedOauth, tokenState,
  usageCacheEntry,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {normalizeExtraUsage, normalizeUsage, usageFailure} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';
import {usageForLogin} from './login-usage.js';
import {readJSON, writePrivate} from './private-fs.js';

export const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
// Claude Code's public OAuth client - the same id the CLI itself refreshes with.
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
/** The status line trusts a cached usage snapshot this long. */
export const USAGE_CACHE_MAX_AGE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const USAGE_CACHE_FILE = '.usage-cache.json';

/**
 * An error the UI has to classify rather than just print. `code` is the string
 * accountHealth() reads ('refresh_failed', 'login_expired', 'no_account',
 * 'no_token', 'transient', 'http_error', 'network_error'), so a broken saved
 * login is reported identically by the CLI, the MCP tools and both panels.
 */
export function coded(code, message) {
  return Object.assign(new Error(message), {code});
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The token and usage operations over one store. `ctx` is what openStore
 * already holds: dir, now(), fetchImpl(), stamp(), readProfile, writeProfile,
 * listProfiles, liveAccountName, liveAccessToken.
 */
export function bindUsage(ctx) {
  const {dir, now, fetchImpl, stamp, readProfile, writeProfile, listProfiles, liveAccountName, liveAccessToken} = ctx;

  // ── The refresh lock ────────────────────────────────────────────────────────
  // O_EXCL create, 0600. The lock carries a random id so a holder only ever
  // removes its own lock, never one a waiter took over after it went stale.
  // Wall-clock time, not the store's clock: io.nowMs may be pinned (tests).

  // The lock as a waiter judged it: its id and mtime, or null once it is gone.
  function lockSnapshot(file) {
    try {
      const {mtimeMs} = fs.statSync(file);
      return {text: fs.readFileSync(file, 'utf8'), mtimeMs};
    } catch {
      return null;
    }
  }

  // A stale lock is moved aside, never removed in place: a rename is atomic,
  // so of two waiters that judged one lock stale only one moves it (the other
  // gets ENOENT and waits again). The mover checks it moved the lock it
  // judged; one a faster waiter had already replaced is put back with O_EXCL,
  // so it never lands over a newer holder's.
  function takeOverStale(file, judged) {
    const aside = `${file}.stale-${crypto.randomUUID()}`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    const moved = lockSnapshot(aside);
    if (moved && (moved.text !== judged.text || moved.mtimeMs !== judged.mtimeMs)) {
      try {
        fs.writeFileSync(file, moved.text, {flag: 'wx', mode: 0o600});
      } catch {
        // a newer holder is already in
      }
    }
    fs.rmSync(aside, {force: true});
  }

  async function acquireLock(name) {
    const file = path.join(dir, refreshLockFile(name));
    const id = crypto.randomUUID();
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(file, 'wx', 0o600);
        try {
          fs.writeSync(fd, id);
        } finally {
          fs.closeSync(fd);
        }
        return {file, id};
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const judged = lockSnapshot(file);
      if (!judged) continue; // released between the two calls: try again at once
      if (Date.now() - judged.mtimeMs > REFRESH_LOCK.staleMs) {
        takeOverStale(file, judged); // a crashed holder
        continue;
      }
      if (Date.now() - start > REFRESH_LOCK.waitMs) {
        throw coded('transient', `${name}: another refresh of this login is still running - try again`);
      }
      await sleep(REFRESH_LOCK.pollMs);
    }
  }

  function releaseLock({file, id}) {
    try {
      if (fs.readFileSync(file, 'utf8') === id) fs.rmSync(file, {force: true});
    } catch {
      // already gone
    }
  }

  // The token exchange itself: the new OAuth block, or a coded throw.
  async function exchange(name, oauth) {
    let response;
    try {
      response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID}),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw coded('network_error', `${name}: token refresh failed - ${e.message}`);
    }
    if (!response.ok) {
      const code = refreshFailureCode(response.status);
      throw coded(code, `${name}: token refresh rejected (HTTP ${response.status})` +
        (code === 'refresh_failed' ? ' - log in again and save it' : ''));
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // a 200 without a JSON body carries no access token either
    }
    const next = refreshedOauth(oauth, body, now());
    if (!next) throw coded('refresh_failed', `${name}: token refresh returned no access token`);
    return next;
  }

  /**
   * Exchange the profile's refresh token for a new access token and store the
   * result, under the profile's refresh lock. When another process refreshed
   * it first, the stored result is returned and no token is spent. Throws a
   * coded error on failure. Never touches the live login.
   */
  async function refreshProfile(profile) {
    const sent = profile.credentials.claudeAiOauth;
    if (!sent.refreshToken) {
      throw coded('login_expired', `${profile.name}: no refresh token - log in again and save it`);
    }
    const lock = await acquireLock(profile.name);
    try {
      const current = readProfile(profile.name);
      if (!current) throw coded('no_account', `no saved account named ${profile.name}`);
      if (refreshRaced(sent, current.credentials.claudeAiOauth)) return current;
      let next;
      try {
        next = await exchange(profile.name, sent);
      } catch (e) {
        // A process that took no lock (an older release, another tool) may
        // have spent it: a spent token whose replacement is on disk is fine.
        const again = e.code === 'refresh_failed' ? readProfile(profile.name) : null;
        if (again && refreshRaced(sent, again.credentials.claudeAiOauth)) return again;
        throw e;
      }
      // The rotated tokens go into OUR store and nowhere else: writing the
      // live credentials from here would rotate the token Claude Code is
      // running on.
      return writeProfile({
        ...current, savedAt: stamp(),
        credentials: {...current.credentials, claudeAiOauth: next},
      });
    } finally {
      releaseLock(lock);
    }
  }

  /**
   * A usable access token for a saved account: the live one when that account
   * is the active login (Claude Code keeps it fresh), else the stored one,
   * refreshed first when stale.
   *
   * THE RULE: a name that resolves to the live login returns the live token or
   * throws `no_token`; it never reaches the refresh below, whatever its stored
   * copy says. So reading usage never rotates the credentials Claude Code is
   * running on.
   */
  async function accessTokenFor(name) {
    const profile = readProfile(name);
    if (!profile) throw coded('no_account', `no saved account named ${name}`);
    if (liveAccountName() === name) {
      const token = liveAccessToken();
      if (token) return {token, source: 'live'};
      throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
    }
    switch (tokenState(profile, now())) {
      case 'valid':
        return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
      case 'stale': {
        const fresh = await refreshProfile(profile);
        return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
      }
      default:
        throw coded('login_expired', `${name}: login expired - run \`claude auth login\` on it and save it again`);
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
    if (!response.ok) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        // no JSON body - the status alone is the message
      }
      const retryAfter = response.headers?.get?.('retry-after') ?? null;
      return usageFailure(response.status, body, {label, retryAfter, nowMs: now()});
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

  /** Usage for one saved account: the label rule is login-usage.js's, so a
   *  live token's refusal keeps the "run any Claude Code command" hint. */
  function usageFor(name) {
    return usageForLogin({accessTokenFor, fetchUsageWith}, name);
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
      if (r?.ok) accounts[name] = usageCacheEntry(r.cards, now());
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

  return {
    refreshProfile, accessTokenFor, fetchUsageWith, fetchLiveUsage, usageFor, usageForAll,
    writeUsageCache, readUsageCache,
  };
}
