// The GNOME session index (lib/sessionIndex.js) run for real under node, over
// the GLib / Gio stand-in in tests/session-index-gi.js, against the Node
// writer of the SAME shared index (mcp/sessions.js). The index file is shared
// by design, so the two ports must read the same transcripts and accept each
// other's entries - a port that disagrees deletes or re-folds the other's
// work on every refresh.
process.env.TZ = 'UTC';

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {URL, fileURLToPath, pathToFileURL} from 'node:url';

import * as mcp from '../mcp/sessions.js';
import * as paths from '../claude-code/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'sessions.json'), 'utf8'));
const NOW = fix.nowMs;

// gi://GLib and gi://Gio resolve to the stand-in's named exports, as the
// default export GJS gives them.
const STUB = pathToFileURL(path.join(here, 'session-index-gi.js')).href;
const GI = {'gi://GLib': 'GLib', 'gi://Gio': 'Gio'};
registerHooks({
    resolve(specifier, context, next) {
        if (GI[specifier]) return {url: `${STUB}?gi=${GI[specifier]}`, shortCircuit: true};
        return next(specifier, context);
    },
    load(url, context, next) {
        const name = new URL(url).searchParams.get('gi');
        if (url.startsWith(`${STUB}?gi=`) && name) {
            return {format: 'module', source: `export {${name} as default} from '${STUB}';`, shortCircuit: true};
        }
        return next(url, context);
    },
});
const gnome = await import('../claude-usage-panel@fschmutz.github.io/lib/sessionIndex.js');

// A throwaway HOME with a Claude config dir holding one transcript, and the
// GLib environment pointed at it.
function world(t, {env = {}} = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-sindex-'));
    t.after(() => fs.rmSync(home, {recursive: true, force: true}));
    const cache = path.join(home, '.cache');
    globalThis.giStub = {home, cache, env};
    return {home, cache, indexPath: path.join(cache, 'claude-usage-panel', 'sessions.json')};
}

function transcript(dir, id, tokens) {
    const file = path.join(dir, '-home-u-p', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, `${JSON.stringify({
        type: 'assistant', sessionId: id, cwd: '/home/u/p', timestamp: new Date(NOW).toISOString(),
        message: {id: `${id}-m1`, usage: {input_tokens: tokens}},
    })}\n`);
    // a sub-second mtime, as every real file system has
    fs.utimesSync(file, NOW / 1000, NOW / 1000 + 0.4219);
    return file;
}

for (const c of fix.projectsDir.cases) {
    test(`GNOME and node read the same projects dir - ${JSON.stringify(c.env)}`, (t) => {
        world(t, {env: c.env});
        globalThis.giStub.home = c.home;
        assert.equal(gnome.projectsDir(), c.expected);
        assert.equal(paths.projectsDir({env: c.env, homedir: c.home}), c.expected);
    });
}

test('with CLAUDE_CONFIG_DIR, the GNOME index reads the tree the node port reads', async (t) => {
    const w = world(t);
    const config = path.join(w.home, 'claude-work');
    globalThis.giStub.env = {CLAUDE_CONFIG_DIR: config};
    transcript(path.join(config, 'projects'), 'WORK', 70);
    transcript(path.join(w.home, '.claude', 'projects'), 'DEFAULT', 5);
    const {sessions} = await gnome.refreshSessions({nowMs: NOW});
    assert.deepEqual(sessions.map((s) => s.sessionId), ['WORK']);
});

test('GNOME and node accept each other\'s entries: no re-fold, no rewrite', async (t) => {
    const w = world(t);
    const projects = path.join(w.home, '.claude', 'projects');
    transcript(projects, 'S1', 70);
    const io = {nowMs: NOW, homedir: w.home, env: {}, indexPath: w.indexPath};

    // GNOME writes the index; the node port must take it as up to date
    assert.equal((await gnome.refreshSessions({nowMs: NOW})).sessions[0].tokens, 70);
    let ino = fs.statSync(w.indexPath).ino;
    assert.equal(mcp.refreshSessions(io)[0].tokens, 70);
    assert.equal(fs.statSync(w.indexPath).ino, ino, 'node rewrote the GNOME index');

    // and the other way round, from a fresh index node wrote
    fs.rmSync(w.indexPath);
    mcp.refreshSessions(io);
    ino = fs.statSync(w.indexPath).ino;
    const {sessions, pending} = await gnome.refreshSessions({nowMs: NOW});
    assert.equal(sessions[0].tokens, 70);
    assert.equal(pending, false);
    assert.equal(fs.statSync(w.indexPath).ino, ino, 'GNOME rewrote the node index');
});

test('both ports move past a line longer than a line can be', async (t) => {
    const w = world(t);
    const projects = path.join(w.home, '.claude', 'projects');
    const file = transcript(projects, 'S2', 42);
    const turn = fs.readFileSync(file, 'utf8');
    const huge = JSON.stringify({type: 'user', sessionId: 'S2', cwd: '/home/u/p', text: 'x'.repeat(5 << 19)});
    fs.writeFileSync(file, `${huge}\n${turn}`);
    const {sessions} = await gnome.refreshSessions({nowMs: NOW});
    assert.equal(sessions[0]?.tokens, 42);
    fs.rmSync(w.indexPath);
    let got = [];
    for (let i = 0; i < 8 && !got.length; i++) {
        got = mcp.refreshSessions({nowMs: NOW, homedir: w.home, env: {}, indexPath: w.indexPath, budgetBytes: 1 << 20});
    }
    assert.equal(got[0]?.tokens, 42);
});
