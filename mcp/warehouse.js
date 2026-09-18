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
        const e = {t: o.t};
        if (typeof o.a === 'string' && o.a) e.a = o.a;
        e.limits = o.limits;
        out.push(e);
      }
    } catch {
      continue;
    }
  }
  return out;
}

// The identity an entry is filed under: the oauthAccount uuid, else its email.
// The file is shared by every login on the machine; a peak read without it
// would show one login's 100% week on the card of the login that replaced it.
export function warehouseAccount(live) {
  if (!live || typeof live !== 'object') return null;
  if (typeof live.accountUuid === 'string' && live.accountUuid) return live.accountUuid;
  if (typeof live.emailAddress === 'string' && live.emailAddress) return live.emailAddress;
  return null;
}

/** Peak of one limit over the last 7 days against the 7 before that, for one
 *  account: only entries filed under `account` count, and with no account
 *  known only the entries that carry none. */
export function weekOverWeek(entries, key, nowMs = Date.now(), account = null) {
  const week = 7 * 86_400_000;
  const owner = account ? String(account) : null;
  let thisWeek = null;
  let lastWeek = null;
  for (const e of entries ?? []) {
    if ((e?.a ?? null) !== owner) continue;
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

/** Attach `trend` to every card the warehouse has samples for, for `account`
 *  (the live login's identity, from warehouseAccount). */
export function withTrend(
  cards, {nowMs = Date.now(), warehouse = defaultWarehousePath(), account = null} = {},
) {
  let entries = [];
  try {
    entries = parseWarehouse(fs.readFileSync(warehouse, 'utf8'));
  } catch {
    return cards; // no warehouse yet - the panels write it, this only reads
  }
  return cards.map((c) => {
    const trend = weekOverWeek(entries, c.key, nowMs, account);
    return trend ? {...c, trend} : c;
  });
}
