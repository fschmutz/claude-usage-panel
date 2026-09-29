// Warehouse read side, pinned by the shared fixture: parseWarehouse /
// warehouseAccount / weekOverWeek are lib/pure/warehouse.js, the one
// JavaScript copy (the GNOME panel and mcp/warehouse.js both import it);
// Warehouse.swift asserts the same fixture in ClaudeUsageCoreTests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    parseWarehouse, warehouseAccount, weekOverWeek,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure/warehouse.js';

const fixture = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'warehouse.json'), 'utf8'));

for (const c of fixture.cases) {
    test(`weekOverWeek - ${c.name}`, () => {
        assert.deepEqual(weekOverWeek(fixture.entries, c.key, fixture.now, c.account ?? null), c.expected);
    });
}

for (const c of fixture.accounts) {
    test(`warehouseAccount - ${c.name}`, () => {
        assert.equal(warehouseAccount(c.live), c.expected);
    });
}

test('parseWarehouse - reads back the fixture rows, skips torn and foreign lines', () => {
    const text = [
        ...fixture.entries.map((e) => JSON.stringify(e)),
        '{"t":1,"a":"","limits":{}}',
        '{"t":"x","limits":{}}',
        '{"t":2}',
        'torn line, still writing',
        '',
    ].join('\n');
    assert.deepEqual(parseWarehouse(text), [...fixture.entries, {t: 1, limits: {}}]);
    assert.deepEqual(parseWarehouse(null), []);
});
