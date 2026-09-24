// metadata.json: the GNOME Shell versions the extension claims, and the
// extension.js header comment that states the same range.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'claude-usage-panel@fschmutz.github.io');
const read = rel => fs.readFileSync(path.join(EXT, rel), 'utf8');

// ── Shell versions ───────────────────────────────────────────────────────────
test('metadata claims GNOME Shell 51 and the header comment states the same range', () => {
    const versions = JSON.parse(read('metadata.json'))['shell-version'];
    assert.ok(versions.includes('51'), versions.join(','));
    const nums = versions.map(Number);
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), 'ascending');
    for (let i = 1; i < nums.length; i++)
        assert.equal(nums[i], nums[i - 1] + 1, 'no gap in the supported range');
    const header = read('extension.js').split('\n')[0];
    assert.equal(header, `// Claude Usage Panel - GNOME Shell ${nums[0]}-${nums.at(-1)}`);
});
