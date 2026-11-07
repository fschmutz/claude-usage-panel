// claude-code/is-main.js: the one "run when executed directly" test, and the
// guard that every Node entry point uses it (five hand-written shapes before,
// one of them a suffix match any other *awake-worker.js script tripped).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {isMain} from '../claude-code/is-main.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('isMain: the script itself, or a symlink to it; never another file', (t) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-ismain-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    const real = path.join(d, 'awake-worker.js');
    fs.writeFileSync(real, '');
    const url = pathToFileURL(fs.realpathSync(real)).href;
    assert.equal(isMain(url, real), true);
    fs.symlinkSync(real, path.join(d, 'bin-shim'));
    assert.equal(isMain(url, path.join(d, 'bin-shim')), true, 'npm/npx bin shims are symlinks');
    fs.writeFileSync(path.join(d, 'my-awake-worker.js'), '');
    assert.equal(isMain(url, path.join(d, 'my-awake-worker.js')), false, 'a name ending the same is not this file');
    assert.equal(isMain(url, path.join(d, 'missing.js')), false);
    assert.equal(isMain(url, undefined), false);
});

test('every Node entry point runs only through isMain(import.meta.url)', () => {
    const entries = [
        'claude-code/statusline.js', 'claude-code/waiting-hook.js', 'claude-code/pause-hook.js',
        'claude-code/claudectl.js', 'claude-code/awake-worker.js', 'mcp/server.js',
    ];
    for (const rel of entries) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        assert.match(text, /^if \(isMain\(import\.meta\.url\)\) \{$/m, rel);
        assert.doesNotMatch(text, /process\.argv\[1\] ===|argv\[1\]\.endsWith|invokedAs/, rel);
    }
});
