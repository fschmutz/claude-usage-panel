// Cursor team-spend contract: tests/fixtures/cursor.json, asserted here for the
// GNOME port and by CursorParityTests.swift for ClaudeUsageCore.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {summarizeCursorSpend, summarizeCursorToday} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'cursor.json'), 'utf8'));
const EPS = 1e-9;

function near(got, want, what) {
    assert.ok(Math.abs(got - want) < EPS, `${what}: got ${got}, want ${want}`);
}

for (const c of fixture.spend) {
    test(`summarizeCursorSpend: ${c.name}`, () => {
        const s = summarizeCursorSpend(c.rows);
        const e = c.expected;
        near(s.cycleUSD, e.cycleUSD, 'cycleUSD');
        near(s.limitUSD, e.limitUSD, 'limitUSD');
        assert.equal(s.percent, e.percent);
        assert.equal(s.members, e.members);
        if (e.top === null) {
            assert.equal(s.topSpender, null);
        } else {
            assert.equal(s.topSpender.email, e.top.email);
            near(s.topSpender.usd, e.top.usd, 'top.usd');
        }
    });
}

for (const c of fixture.today) {
    test(`summarizeCursorToday: ${c.name}`, () => {
        near(summarizeCursorToday(c.events), c.expectedUSD, 'todayUSD');
    });
}

test('the fixture carries fractional cents, the case that splits a truncating port', () => {
    const cents = [
        ...fixture.spend.flatMap(c => c.rows.map(r => r.overallSpendCents ?? r.spendCents ?? 0)),
        ...fixture.today.flatMap(c => c.events.map(e => e.chargedCents ?? 0)),
    ];
    assert.ok(cents.some(v => !Number.isInteger(v)));
});
