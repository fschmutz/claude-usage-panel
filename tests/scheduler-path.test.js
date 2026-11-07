// One search for node and the claude CLI under a scheduler's minimal PATH.
// It used to be three that disagreed (session-ping.sh, auto-update.sh,
// claude-code/tools.js: fnm versions vs its default alias, asdf installs vs
// shims, nvm sorted versions vs `current`, a `sort -V` fallback that put v9
// above v10). scripts/lib.sh scheduler_bin_dirs and tools.js schedulerDirs
// now answer tests/fixtures/scheduler-path.json identically, layout by layout.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, sandboxHome} from './helpers.js';
import {schedulerDirs, toolEnv} from '../claude-code/tools.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB = path.join(ROOT, 'scripts', 'lib.sh');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/scheduler-path.json'), 'utf8'));

function layout(t, c) {
    const {home} = sandboxHome(t, {prefix: 'cup-sched-'});
    const abs = (p) => p.replace(/(^|:)~/g, `$1${home}`);
    for (const dir of c.nodes) {
        fs.mkdirSync(abs(dir), {recursive: true});
        fs.writeFileSync(path.join(abs(dir), 'node'), '#!/bin/sh\n', {mode: 0o755});
    }
    const env = {HOME: home, PATH: '/usr/bin:/bin', CUP_TEST_SYSTEM_BINS: abs(FIXTURE.system)};
    for (const [k, v] of Object.entries(c.env)) env[k] = abs(v);
    const expect = [...(c.fixed ?? FIXTURE.fixed), ...c.extra].map(abs);
    return {env, expect, node: c.node ? abs(c.node) : 'NONE'};
}

for (const c of FIXTURE.cases) {
    test(`scheduler search, ${c.name}: lib.sh and tools.js agree`, (t) => {
        const {env, expect, node} = layout(t, c);
        const r = run('bash', ['-c', '. "$1"; scheduler_bin_dirs; echo --; scheduler_bin_dir_for node || echo NONE', '_', LIB], {env});
        assert.equal(r.status, 0, r.stderr);
        const [dirs, found] = r.stdout.trim().split('\n--\n');
        assert.deepEqual(dirs.split('\n'), expect, 'lib.sh scheduler_bin_dirs');
        assert.equal(found, node, 'lib.sh scheduler_bin_dir_for node');
        assert.deepEqual(schedulerDirs({env}), expect, 'tools.js schedulerDirs');
    });
}

test('session-ping and auto-update search through lib.sh, not a list of their own', () => {
    const ping = fs.readFileSync(path.join(ROOT, 'scripts/session-ping.sh'), 'utf8');
    const update = fs.readFileSync(path.join(ROOT, 'scripts/auto-update.sh'), 'utf8');
    assert.match(ping, /\$\(scheduler_path\)/);
    assert.match(update, /scheduler_bin_dir_for node/);
    for (const src of [ping, update]) assert.doesNotMatch(src, /\.nvm|\.volta|fnm|\.asdf|sort -V/);
});

test('toolEnv widens PATH with the same search, PATH order first', (t) => {
    const c = FIXTURE.cases.find((x) => x.name.startsWith('nvm versions'));
    const {env, expect} = layout(t, c);
    const parts = toolEnv({env}).PATH.split(':');
    assert.deepEqual(parts.slice(0, 2), ['/usr/bin', '/bin']);
    assert.deepEqual(parts.slice(2), expect);
});
