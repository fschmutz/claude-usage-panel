// Named accounts, the token and usage half of the store: pick the token a
// saved account's usage is read with, fetch and normalize that usage, and keep
// the accounts' usage cache. accounts.js binds it to the same io as the
// rest of the store (openStore); nothing here is a second store.
//
// Two rules decide everything below, and both live in the shared sequences
// (lib/pure/accountStore.js accessTokenFor / refreshProfile), the same code
// the GNOME extension runs:
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

import path from 'node:path';

import {usageCacheEntry} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accounts.js';
import {STORE_FILES} from '../claude-usage-panel@fschmutz.github.io/lib/pure/accountStore.js';
import {normalizeExtraUsage, normalizeUsage, usageFailure} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';
import {usageForLogin} from './login-usage.js';
import {readJSON, writePrivate} from './private-fs.js';

const OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
/** A cached usage snapshot is trusted this long. */
const USAGE_CACHE_MAX_AGE_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The token endpoint POST the shared refresh sequence asks the port for:
 * {status, ok, json}, json null when the answer is not JSON. A transport
 * failure throws (the sequence files it as network_error).
 */
export async function postToken(fetchImpl, body) {
  const response = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let json = null;
  if (response.ok) {
    try {
      json = await response.json();
    } catch {
      // a 200 without a JSON body carries no access token either
    }
  }
  return {status: response.status, ok: response.ok, json};
}

/**
 * The token and usage operations over one store. `ctx` is what openStore
 * already holds: dir, now(), fetchImpl(), the shared sequences `core` with
 * its two drivers (`sync`, `run`), listProfiles and liveAccessToken.
 */
export function bindUsage(ctx) {
  const {dir, now, fetchImpl, core, sync, run, listProfiles, liveAccessToken} = ctx;
  const cachePath = path.join(dir, STORE_FILES.usageCache);

  /** Exchange the profile's refresh token, under its lock, into OUR store only. */
  const refreshProfile = (profile) => run(core.refreshProfile(profile));

  /** A usable access token for a saved account (the live one when it is the
   *  live login, else the stored one, refreshed first when stale). */
  const accessTokenFor = (name) => run(core.accessTokenFor(name));

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
  // so a reader with no network and no credentials can tell a freer account.
  // `results` is usageForAll()'s shape: {name: {ok, cards}}.
  function writeUsageCache(results) {
    const accounts = {};
    for (const [name, r] of Object.entries(results)) {
      if (r?.ok) accounts[name] = usageCacheEntry(r.cards, now());
    }
    try {
      writePrivate(cachePath, JSON.stringify({at: now(), accounts}));
    } catch {
      // read-only state dir just means no cached snapshot
    }
  }

  /** The cached snapshot when fresh enough, else null. */
  function readUsageCache(maxAgeMs = USAGE_CACHE_MAX_AGE_MS) {
    const cache = readJSON(cachePath);
    if (!cache || !Number.isFinite(cache.at) || now() - cache.at > maxAgeMs) return null;
    return cache.accounts && typeof cache.accounts === 'object' ? cache : null;
  }

  /** A renamed account keeps its cached usage and its kept weekly reset. */
  const renameCacheEntries = (from, to) => sync(core.renameCacheEntries(from, to));

  return {
    refreshProfile, accessTokenFor, fetchUsageWith, fetchLiveUsage, usageFor, usageForAll,
    writeUsageCache, readUsageCache, renameCacheEntries,
  };
}
