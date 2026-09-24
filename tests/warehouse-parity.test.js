// Warehouse read-side parity: the MCP server keeps its own copy of
// parseWarehouse / warehouseAccount / weekOverWeek (mcp/warehouse.js), so the
// shared fixture that pins the GNOME port (and Warehouse.swift) runs through
// both JS ports here. A drifting copy goes red instead of shipping a wrong
// week-over-week trend from the MCP tool only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import * as mcp from '../mcp/warehouse.js';

const fixture = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'warehouse.json'), 'utf8'));

const ports = {gnome: pure, mcp};

for (const [portName, port] of Object.entries(ports)) {
    for (const c of fixture.cases) {
        test(`${portName} weekOverWeek - ${c.name}`, () => {
            assert.deepEqual(
                port.weekOverWeek(fixture.entries, c.key, fixture.now, c.account ?? null), c.expected);
        });
    }

    for (const c of fixture.accounts) {
        test(`${portName} warehouseAccount - ${c.name}`, () => {
            assert.equal(port.warehouseAccount(c.live), c.expected);
        });
    }

    test(`${portName} parseWarehouse - reads back the fixture rows, skips torn and foreign lines`, () => {
        const text = [
            ...fixture.entries.map((e) => JSON.stringify(e)),
            '{"t":1,"a":"","limits":{}}',
            '{"t":"x","limits":{}}',
            '{"t":2}',
            'torn line, still writing',
            '',
        ].join('\n');
        assert.deepEqual(port.parseWarehouse(text), [...fixture.entries, {t: 1, limits: {}}]);
    });
}

test('both ports read the same text to the same entries', () => {
    const text = `${fixture.entries.map((e) => JSON.stringify(e)).join('\n')}\n{ not json\n`;
    assert.deepEqual(mcp.parseWarehouse(text), pure.parseWarehouse(text));
    assert.deepEqual(mcp.parseWarehouse(null), pure.parseWarehouse(null));
});
