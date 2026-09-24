// scripts/json-edit.mjs - the one JSON editor install.sh uses on
// ~/.claude/settings.json and ~/.cursor/mcp.json. Runs the real script on
// throwaway files; no HOME is touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const EDIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'json-edit.mjs');

const edit = (...args) => execFileSync(process.execPath, [EDIT, ...args], {encoding: 'utf8'});
const modeOf = (p) => fs.statSync(p).mode & 0o777;

function withTmp(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-json-edit-'));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, {recursive: true, force: true});
    }
}

test('set, get and delete round-trip, other keys untouched', () => {
    withTmp((d) => {
        const f = path.join(d, 'settings.json');
        fs.writeFileSync(f, '{"keep":1}\n');
        edit('set', f, 'mcpServers.x.args', '["a"]');
        assert.equal(edit('get', f, 'mcpServers.x.args'), '["a"]\n');
        edit('delete', f, 'mcpServers.x');
        assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), {keep: 1, mcpServers: {}});
    });
});

// A stow/chezmoi-managed settings.json is a symlink. Renaming over the link
// replaced it with a detached regular file and left the dotfile unchanged.
test('a symlinked file is edited through the link, which stays a link', () => {
    withTmp((d) => {
        const real = path.join(d, 'dotfiles', 'settings.json');
        fs.mkdirSync(path.dirname(real));
        fs.writeFileSync(real, '{"a":1}\n', {mode: 0o600});
        fs.chmodSync(real, 0o600);
        const link = path.join(d, 'settings.json');
        fs.symlinkSync(path.join('dotfiles', 'settings.json'), link);

        edit('set-string', link, 'statusLine.command', 'x');

        assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link must survive');
        assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), {a: 1, statusLine: {command: 'x'}});
        assert.equal(modeOf(real), 0o600);
        assert.deepEqual(fs.readdirSync(d).sort(), ['dotfiles', 'settings.json'], 'no stray tmp file');
    });
});

test('a dangling symlink creates its target, not a file over the link', () => {
    withTmp((d) => {
        const link = path.join(d, 'mcp.json');
        fs.symlinkSync(path.join(d, 'store', 'mcp.json'), link);
        edit('set', link, 'k', '1');
        assert.ok(fs.lstatSync(link).isSymbolicLink());
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'store', 'mcp.json'), 'utf8')), {k: 1});
    });
});

test('the existing mode is kept, and a new file is private', () => {
    withTmp((d) => {
        const f = path.join(d, 'private.json');
        fs.writeFileSync(f, '{}\n');
        fs.chmodSync(f, 0o600);
        edit('set', f, 'a', '1');
        assert.equal(modeOf(f), 0o600, 'a 0600 file must not widen to the umask mode');

        const g = path.join(d, 'shared.json');
        fs.writeFileSync(g, '{}\n');
        fs.chmodSync(g, 0o644);
        edit('set', g, 'a', '1');
        assert.equal(modeOf(g), 0o644);

        const n = path.join(d, 'new', 'fresh.json');
        edit('set', n, 'a', '1');
        assert.equal(modeOf(n), 0o600);
    });
});

test('a file that is not a JSON object is refused, not replaced', () => {
    withTmp((d) => {
        const f = path.join(d, 'list.json');
        fs.writeFileSync(f, '[1]\n');
        assert.throws(() => execFileSync(process.execPath, [EDIT, 'set', f, 'a', '1'], {stdio: 'pipe'}));
        assert.equal(fs.readFileSync(f, 'utf8'), '[1]\n');
    });
});
