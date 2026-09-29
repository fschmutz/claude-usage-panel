// The durable usage warehouse, read side. The desktop panels append one JSONL
// line per poll that moved and keep 90 days; reading it is how the MCP tool
// answers "is this week worse than last". The server never writes here, so it
// never prunes and carries no retention constant of its own. Parsing, the
// account an entry is filed under and the week-over-week peak are
// lib/pure/warehouse.js, the copy the GNOME panel uses too (Warehouse.swift
// is the Swift twin, tests/fixtures/warehouse.json pins both); this is the
// file read around it.

import fs from 'node:fs';

import {parseWarehouse, weekOverWeek} from '../claude-usage-panel@fschmutz.github.io/lib/pure/warehouse.js';
import {warehousePath as defaultWarehousePath} from '../claude-code/paths.js';

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
