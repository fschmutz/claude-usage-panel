// Usage against time, the Node side: the shared sample history the status
// line and the MCP server both append to, and withPace, which attaches the
// clock pace and the burn-rate forecast to each card. The contract itself
// (clockPace, forecast, WINDOW_MS, PACE_TOLERANCE) is lib/pure/pace.js, the
// one JavaScript copy the GNOME extension uses too; Model.swift is the Swift
// twin, and tests/fixtures/pace.json + forecast.json pin both.

import fs from 'node:fs';

import {clockPace, forecast} from '../claude-usage-panel@fschmutz.github.io/lib/pure/pace.js';
import {usageReading} from '../claude-usage-panel@fschmutz.github.io/lib/pure/usage.js';
import {historyPath as defaultHistoryPath} from './paths.js';

// ── Shared sample history ───────────────────────────────────────────────────────
// One tmp file, keyed by card key ("session", "weekly_all", "weekly_scoped:Fable"),
// appended by whichever client runs so each densifies the other's history.
// Best-effort: a concurrent write may win a race - one sample lost, never an
// error - and a read-only tmp dir just means no forecast.
//
// With an `account` (the live login's uuid or email) the key is
// "<account>|<card key>": two logins are two quota pools, and one series
// spanning a switch from a 10 % account to a 60 % one regresses as a burn and
// raises a false "full before reset". Without one the key is the bare card key.
//
// The file lives in a shared tmp dir, so anything may have written it: only a
// plain object survives the read, and in it only [finite t, finite p] pairs.
// A foreign entry must cost its own sample, never the forecast (which
// destructures every entry) or the whole status line.

const HISTORY_MAX_SAMPLES = 200;

const isPair = (e) =>
  Array.isArray(e) && e.length === 2 && Number.isFinite(e[0]) && Number.isFinite(e[1]);

/** A parsed history file reduced to what forecast() can read: {key: [[t, p], …]}. */
export function sanitizeHistory(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = Object.create(null); // a "__proto__" key stays a plain key
  for (const [key, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    const pairs = list.filter(isPair);
    if (pairs.length) out[key] = pairs;
  }
  return out;
}

/** The history key of one card for one login. */
export function historyKey(cardKey, account) {
  return account ? `${account}|${cardKey}` : cardKey;
}

/**
 * Append this call's samples and return the updated map, keyed by card key
 * for this `account` (the file holds every account's series).
 */
export function recordHistory(cards, {nowMs = Date.now(), historyPath = defaultHistoryPath(), account} = {}) {
  let hist = {};
  try {
    hist = sanitizeHistory(JSON.parse(fs.readFileSync(historyPath, 'utf8')));
  } catch {
    // no history yet
  }
  const mine = () =>
    Object.fromEntries(cards.map((c) => [c.key, hist[historyKey(c.key, account)] ?? []]));
  // A null placeholder carries no measurement: a 0 filed for it would later
  // read as a burn from 0 once the limit gets a real number.
  const measured = cards.filter((c) => c.percentKnown !== false);
  if (!measured.length) return mine(); // nothing to add - do not rewrite the file
  for (const c of measured) {
    const key = historyKey(c.key, account);
    const list = hist[key] ?? [];
    list.push([nowMs, c.percent]);
    hist[key] = list.slice(-HISTORY_MAX_SAMPLES);
  }
  try {
    fs.writeFileSync(historyPath, JSON.stringify(hist), {mode: 0o600});
  } catch {
    // read-only tmp dir just means no forecast; not fatal
  }
  return mine();
}

/** Record the cards, then project each one: Map of card key to forecast|null. */
export function forecastMap(cards, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const hist = recordHistory(cards, {...opts, nowMs});
  return new Map(cards.map((c) => [c.key, forecast(hist[c.key] ?? [], c.resetsAt, nowMs)]));
}

/**
 * Attach `pace` (when history supports an honest projection) and `vsClock`
 * (always, when the card has a reset) to every card whose percentage may be
 * shown. A card with no honest reading (usageReading: a null placeholder, or
 * a window already rolled over) gets neither: a burn rate or a clock delta
 * computed from a figure nobody can stand behind would contradict the dash.
 */
export function withPace(cards, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const forecasts = forecastMap(cards, {...opts, nowMs});
  return cards.map((c) => {
    if (!usageReading(c, nowMs).known) return c;
    const fc = forecasts.get(c.key);
    const vsClock = clockPace(c, nowMs);
    return {...c, ...(fc ? {pace: fc} : {}), ...(vsClock ? {vsClock} : {})};
  });
}
