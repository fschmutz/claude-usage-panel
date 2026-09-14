// The durable usage warehouse, read side. The desktop panels append one JSONL
// line per poll that moved and keep 90 days; reading it is how the MCP tool
// answers "is this week worse than last". The server never writes here.
// Mirrors lib/pure.js (GNOME) and Warehouse.swift; tests/fixtures/warehouse.json.

import fs from 'node:fs';

import {warehousePath as defaultWarehousePath} from '../claude-code/paths.js';

export const WAREHOUSE_KEEP_DAYS = 90;

// Unreadable lines are skipped, never fatal: several processes append here, so
// a torn last line is normal.
export function parseWarehouse(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (Number.isFinite(o?.t) && o.limits && typeof o.limits === 'object') {
        out.push({t: o.t, limits: o.limits});
      }
    } catch {
      continue;
    }
  }
  return out;
}

/** Peak of one limit over the last 7 days against the 7 before that. */
export function weekOverWeek(entries, key, nowMs = Date.now()) {
  const week = 7 * 86_400_000;
  let thisWeek = null;
  let lastWeek = null;
  for (const e of entries ?? []) {
    const p = e?.limits?.[key];
    if (!Number.isFinite(p)) continue;
    const age = nowMs - e.t;
    if (age < 0 || age >= 2 * week) continue;
    if (age < week) thisWeek = thisWeek === null ? p : Math.max(thisWeek, p);
    else lastWeek = lastWeek === null ? p : Math.max(lastWeek, p);
  }
  if (thisWeek === null) return null;
  return {
    thisWeekPeak: thisWeek,
    lastWeekPeak: lastWeek,
    deltaPoints: lastWeek === null ? null : thisWeek - lastWeek,
  };
}

/** Attach `trend` to every card the warehouse has samples for. */
export function withTrend(cards, {nowMs = Date.now(), warehouse = defaultWarehousePath()} = {}) {
  let entries = [];
  try {
    entries = parseWarehouse(fs.readFileSync(warehouse, 'utf8'));
  } catch {
    return cards; // no warehouse yet - the panels write it, this only reads
  }
  return cards.map((c) => {
    const trend = weekOverWeek(entries, c.key, nowMs);
    return trend ? {...c, trend} : c;
  });
}
