// claude-code/private-fs.js writeAtomic: the one atomic write behind every
// store, scratch file and settings edit of the Node port.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {readJSON, writeAtomic, writePrivate} from '../claude-code/private-fs.js';

function tmpDir(t) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-pfs-'));
    t.after(() => fs.rmSync(d, {recursive: true, force: true}));
    return d;
}
const modeOf = (p) => fs.statSync(p).mode & 0o777;

test('writePrivate: a 0600 file in a 0700 directory, replaced by rename', (t) => {
    const f = path.join(tmpDir(t), 'new', 'a.json');
    writePrivate(f, '{"a":1}');
    assert.equal(modeOf(f), 0o600);
    assert.equal(modeOf(path.dirname(f)), 0o700);
    const ino = fs.statSync(f).ino;
    writePrivate(f, '{"a":2}');
    assert.notEqual(fs.statSync(f).ino, ino);
    assert.deepEqual(readJSON(f), {a: 2});
});

test('keepMode keeps the mode a file had, even a wider one under a narrow umask', (t) => {
    const f = path.join(tmpDir(t), 'settings.json');
    fs.writeFileSync(f, '{}');
    fs.chmodSync(f, 0o644);
    const old = process.umask(0o077);
    try {
        writeAtomic(f, '{"b":1}', {keepMode: true});
    } finally {
        process.umask(old);
    }
    assert.equal(modeOf(f), 0o644);
    const g = path.join(path.dirname(f), 'fresh.json');
    writeAtomic(g, '{}', {keepMode: true});
    assert.equal(modeOf(g), 0o600, 'a new file is private');
});

test('a planted tmp symlink is never written through', (t) => {
    const d = tmpDir(t);
    const victim = path.join(d, 'victim');
    fs.writeFileSync(victim, 'untouched');
    const f = path.join(d, 'a.json');
    fs.symlinkSync(victim, `${f}.${process.pid}.tmp`);
    writeAtomic(f, 'data');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
    assert.equal(fs.readFileSync(f, 'utf8'), 'data');
});

test('a write that cannot land throws and leaves no tmp behind', (t) => {
    const d = tmpDir(t);
    const f = path.join(d, 'a.json');
    fs.mkdirSync(f); // the rename over a directory fails
    assert.throws(() => writeAtomic(f, 'data'));
    assert.deepEqual(fs.readdirSync(d), ['a.json']);
});
