// scripts/check-private-names.sh: the public-repo guard. Its list lives outside
// the repo, so every test brings its own throwaway one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {run, sandboxHome} from './helpers.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-private-names.sh');

function setup(t, patterns = ['acme-?corp', '\\bzork\\b']) {
    const {home} = sandboxHome(t, {prefix: 'cup-pn-'});
    const list = path.join(home, 'names.txt');
    fs.writeFileSync(list, `# private\n\n${patterns.join('\n')}\n`);
    const file = (name, text) => {
        const p = path.join(home, name);
        fs.writeFileSync(p, text);
        return p;
    };
    const check = (args, extra = {}) => run('bash', [SCRIPT, ...args],
        {env: {...process.env, CUP_PRIVATE_NAMES_FILE: list, ...extra}});
    return {home, list, file, check};
}

test('a file with a private name fails, and the log says where, never what', (t) => {
    const {file, check} = setup(t);
    const bad = file('a.md', 'fine\nsent by ACME-Corp today\nfine\n');
    const good = file('b.md', 'zorkish is a different word\n');
    const r = check([bad, good]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /a\.md:2 contains a private name/);
    assert.doesNotMatch(r.stdout + r.stderr, /acme/i);
    assert.doesNotMatch(r.stdout, /b\.md/);
    assert.equal(check([good]).status, 0);
});

test('commit messages are checked, git comment lines are not', (t) => {
    const {file, check} = setup(t);
    assert.equal(check(['--message-file', file('m1', 'fix: zork broke\n')]).status, 1);
    assert.equal(check(['--message-file', file('m2', 'fix: it\n# zork in the template\n')]).status, 0);
});

test('no list: skipped for contributors, a failure where it is required', (t) => {
    const {home, file, check} = setup(t);
    const f = file('c.md', 'acme corp\n');
    const missing = {CUP_PRIVATE_NAMES_FILE: path.join(home, 'nope.txt')};
    const skipped = check([f], missing);
    assert.equal(skipped.status, 0);
    assert.match(skipped.stdout, /skipped/);
    const required = check([f], {...missing, CUP_PRIVATE_NAMES_REQUIRED: '1'});
    assert.equal(required.status, 1);
    assert.match(required.stderr, /required here/);
});
