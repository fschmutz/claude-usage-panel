// Account health, inline notices, button-local outcomes and the switch
// rotation against tests/fixtures/notices.json. Health and notices have two JS
// ports (lib/pure.js and claude-code/notices.js); outcomes and the rotation
// only the GNOME one, because no Node client draws a button. Sentences and
// button labels are per port (they are translated) and are NOT asserted. The
// Swift twin is macos/Tests/ClaudeUsageCoreTests/NoticesTests.swift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import * as pure from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import * as notices from '../claude-code/notices.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'notices.json'), 'utf8'));

for (const [portName, port] of [['pure.js', pure], ['notices.js', notices]]) {
    for (const c of FIX.health) {
        test(`${portName} accountHealth - ${c.name}`, () => {
            const live = c.live === true;
            assert.equal(port.accountHealth({tokenState: c.tokenState, errorCode: c.errorCode, live}), c.expected);
        });
    }
    for (const c of FIX.notices) {
        test(`${portName} accountNotices - ${c.name}`, () => {
            assert.deepEqual(port.accountNotices(c.state), c.expected);
        });
    }
}

test('pure.js needsAttention - exactly the health states that earn a notice', () => {
    for (const c of FIX.health) {
        const health = pure.accountHealth({tokenState: c.tokenState, errorCode: c.errorCode, live: c.live === true});
        assert.equal(pure.needsAttention(health), c.needsAttention, c.name);
    }
});

test('pure.js outcomes - the TTL is the fixture\'s', () => {
    assert.equal(pure.OUTCOME_TTL_MS, FIX.outcomeTtlMs);
});

for (const c of FIX.outcomes) {
    test(`pure.js outcomeVisible - ${c.name}`, () => {
        assert.equal(pure.outcomeVisible(c.outcome, c.nowMs), c.expected);
    });
}

for (const c of FIX.rotation) {
    test(`pure.js nextInRotation - ${c.name}`, () => {
        assert.equal(pure.nextInRotation(c.names, c.active), c.expected);
    });
}

test('pure.js nextInRotation - no rotation below the fixture\'s minimum', () => {
    const names = Array.from({length: FIX.rotationMin}, (_, i) => `A${i}`);
    assert.equal(pure.nextInRotation(names.slice(0, -1), null), null);
    assert.equal(pure.nextInRotation(names, null), 'A0');
});
