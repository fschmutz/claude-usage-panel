// lib/pure/usage.js planLabel: the header plan label, read from the
// credentials because the usage endpoint names no plan. Same fixture the
// Swift PlanLabelTests asserts, so the two ports cannot drift apart.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {URL} from 'node:url';

import {planLabel} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/plan-label.json', import.meta.url), 'utf8'));

test('the plan label fixture is not empty', () => {
    assert.ok(fixture.cases.length > 0);
});

for (const c of fixture.cases) {
    test(`planLabel - ${c.name}`, () => {
        assert.equal(planLabel(c.oauth), c.expected);
    });
}
