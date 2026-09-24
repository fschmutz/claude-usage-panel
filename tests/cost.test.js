// The optional cost layer runs only an installed ccusage: both desktop ports
// once fell back to `npx -y ccusage@latest`, which fetched and ran the newest
// unpinned npm release on every poll inside the session holding the Claude
// OAuth token. Pinned on the sources: lib/cost.js imports Gio, and the Swift
// file is macOS-only, so neither runs under node.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('no cost port runs a package fetched by npx', () => {
    for (const p of ['claude-usage-panel@fschmutz.github.io/lib/cost.js', 'macos/Sources/ClaudeUsagePanel/Cost.swift']) {
        const code = read(p).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
        assert.doesNotMatch(code, /npx|@latest/, p);
        assert.match(code, /ccusage/, p);
    }
});
