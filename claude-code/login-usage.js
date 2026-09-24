// Usage for one login, with the auth-failure label decided by where the token
// came from. One rule for every Node caller: the MCP get_usage path uses
// liveLoginUsage, and a store's usageFor can bind usageForLogin to its own
// accessTokenFor + fetchUsageWith (this module imports nothing, so
// accounts.js can import it without a cycle).
//
// The rule: a token accessTokenFor took from the live login (source 'live')
// is Claude Code's to keep fresh, so its refusal is reported as the live
// login's - fetchUsageWith without a label, which carries the "run any Claude
// Code command" refresh hint. A stored or refreshed token is the profile's, so
// its failure names the profile.

/** The `label` fetchUsageWith gets for a token of `source` (accessTokenFor). */
export function usageLabel(name, source) {
  return source === 'live' ? null : name;
}

/**
 * Normalized usage for one saved account, or {name, ok: false, code, message}.
 * `store` needs accessTokenFor and fetchUsageWith (openStore's).
 */
export async function usageForLogin({accessTokenFor, fetchUsageWith}, name) {
  let access;
  try {
    access = await accessTokenFor(name);
  } catch (e) {
    return {name, ok: false, code: 'no_token', message: e.message};
  }
  return {name, ...(await fetchUsageWith(access.token, {label: usageLabel(name, access.source)}))};
}

/**
 * Usage for whatever login Claude Code holds now: through its saved profile
 * when it is one (so a stale live token is not the only way in), else the
 * live token alone.
 */
export function liveLoginUsage(store) {
  const name = store.liveAccountName();
  return name ? usageForLogin(store, name) : store.fetchLiveUsage();
}
