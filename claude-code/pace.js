// Usage against time, the Node port: the clock pace (how much of the window
// has gone vs how much of the quota) and the burn-rate forecast (when a limit
// hits 100% at the current pace), plus the shared sample history both the
// status line and the MCP server append to. Mirrors lib/pure.js (GNOME) and
// Model.swift (macOS); tests/fixtures/pace.json and forecast.json pin all of
// them through tests/parity.test.js.

import fs from 'node:fs';

import {clampPercent} from './normalize.js';
import {historyPath as defaultHistoryPath} from './paths.js';

// ── Clock pace ──────────────────────────────────────────────────────────────────
// The payload dates the reset but never the window's start, so the length comes
// from the group: 5 h session, 7 d weekly. A card ahead of the clock is burning
// faster than the window it lives in - which a flat burn rate cannot show.

export const WINDOW_MS = {session: 5 * 3600_000, weekly: 7 * 86400_000};
export const PACE_TOLERANCE = 5;

export function elapsedPercent(card, nowMs = Date.now()) {
  const span = WINDOW_MS[card?.group];
  if (!span || !card?.resetsAt) return null;
  const reset = Date.parse(card.resetsAt);
  if (!Number.isFinite(reset)) return null;
  return clampPercent((1 - (reset - nowMs) / span) * 100);
}

export function clockPace(card, nowMs = Date.now()) {
  const elapsed = elapsedPercent(card, nowMs);
  if (elapsed === null) return null;
  const delta = clampPercent(card.percent) - elapsed;
  const state = delta > PACE_TOLERANCE ? 'ahead' : delta < -PACE_TOLERANCE ? 'behind' : 'even';
  return {elapsedPercent: elapsed, deltaPoints: delta, state};
}

// ── Burn-rate forecast ──────────────────────────────────────────────────────────

const FORECAST_WINDOW_MS = 6 * 3600_000; // regress over the last 6 h only
const FORECAST_MIN_SAMPLES = 3;
const FORECAST_MIN_SPAN_MS = 30 * 60_000;
const FORECAST_MIN_PACE = 0.2; // %/h - below this the projection is noise

/**
 * Project when a limit hits 100%. `samples` are [epochMs, percent] pairs;
 * the regression is weighted toward recent samples, restarts after a window
 * reset (a drop of more than one point), and stays silent unless at least
 * three samples span thirty minutes at a pace worth reporting.
 */
export function forecast(samples, resetsAt, nowMs) {
  if (!Array.isArray(samples) || !samples.length) return null;
  let start = 0;
  for (let i = samples.length - 1; i > 0; i--) {
    if (samples[i - 1][1] > samples[i][1] + 1) {
      start = i;
      break;
    }
  }
  const win = samples
    .slice(start)
    .filter(([t]) => Number.isFinite(t) && t > nowMs - FORECAST_WINDOW_MS && t <= nowMs);
  if (win.length < FORECAST_MIN_SAMPLES) return null;
  const [t0] = win[0];
  const [tLast, pLast] = win[win.length - 1];
  if (tLast - t0 < FORECAST_MIN_SPAN_MS || pLast >= 100) return null;
  let sw = 0, swt = 0, swp = 0, swtt = 0, swtp = 0;
  win.forEach(([t, p], i) => {
    const w = i + 1;
    const th = (t - t0) / 3600_000;
    sw += w;
    swt += w * th;
    swp += w * p;
    swtt += w * th * th;
    swtp += w * th * p;
  });
  const denom = sw * swtt - swt * swt;
  if (denom === 0) return null;
  const slope = (sw * swtp - swt * swp) / denom;
  if (!Number.isFinite(slope) || slope < FORECAST_MIN_PACE) return null;
  const fullMs = tLast + ((100 - pLast) / slope) * 3600_000;
  const projected = Math.round(fullMs / 60_000) * 60_000;
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  const margin = Number.isFinite(resetMs)
    ? Math.round(((projected - resetMs) / 3600_000) * 10) / 10
    : null;
  return {
    pctPerHour: Math.round(slope * 100) / 100,
    projectedFullAt: new Date(projected).toISOString(),
    exhaustsBeforeReset: margin !== null && margin < 0,
    marginHours: margin,
  };
}

// ── Shared sample history ───────────────────────────────────────────────────────
// One tmp file, keyed by card key ("session", "weekly_all", "weekly_scoped:Fable"),
// appended by whichever client runs so each densifies the other's history.
// Best-effort: a concurrent write may win a race - one sample lost, never an
// error - and a read-only tmp dir just means no forecast.

const HISTORY_MAX_SAMPLES = 200;

/** Append this call's samples and return the updated {key: [[t, p], …]} map. */
export function recordHistory(cards, {nowMs = Date.now(), historyPath = defaultHistoryPath()} = {}) {
  let hist = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (parsed && typeof parsed === 'object') hist = parsed;
  } catch {
    // no history yet
  }
  if (!cards.length) return hist; // nothing to add - do not rewrite the file
  for (const c of cards) {
    const list = Array.isArray(hist[c.key]) ? hist[c.key] : [];
    list.push([nowMs, c.percent]);
    hist[c.key] = list.slice(-HISTORY_MAX_SAMPLES);
  }
  try {
    fs.writeFileSync(historyPath, JSON.stringify(hist), {mode: 0o600});
  } catch {
    // read-only tmp dir just means no forecast; not fatal
  }
  return hist;
}

/** Record the cards, then project each one: Map of card key to forecast|null. */
export function forecastMap(cards, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const hist = recordHistory(cards, {...opts, nowMs});
  return new Map(cards.map((c) => [c.key, forecast(hist[c.key] ?? [], c.resetsAt, nowMs)]));
}

/**
 * Attach `pace` (when history supports an honest projection) and `vsClock`
 * (always, when the card has a reset) to every card.
 */
export function withPace(cards, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const forecasts = forecastMap(cards, {...opts, nowMs});
  return cards.map((c) => {
    const fc = forecasts.get(c.key);
    const vsClock = clockPace(c, nowMs);
    return {...c, ...(fc ? {pace: fc} : {}), ...(vsClock ? {vsClock} : {})};
  });
}
