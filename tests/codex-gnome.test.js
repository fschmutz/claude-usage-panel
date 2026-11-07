// The GNOME Codex store (lib/codex.js) over the GJS stubs, on a fake file
// tree: the transcript scan is async end to end (a synchronous walk of
// ~/.codex/sessions on the shell's main thread is what this pins against),
// it follows the contract's newest-day-first walk, and a switch keeps a token
// the codex CLI rotated between the sync-back and the write.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {setImmediate} from 'node:timers';
import {URL} from 'node:url';

import {memoryFs} from './gio-memory.js';
import {stub} from './gjs-stub.js';

const HOME = '/home/tester';
const SESSIONS = `${HOME}/.codex/sessions`;
const AUTH = `${HOME}/.codex/auth.json`;
const PROFILES = `${HOME}/.local/state/claude-usage-panel/codex-accounts`;

/**
 * GLib + Gio over `files` (path -> text) and `mtimes` (path -> epoch s),
 * async only (tests/gio-memory.js): a synchronous read, write or walk of the
 * Codex home throws. `onRead(path)` runs on every read. Every sessions/
 * listing is recorded in `listed`.
 */
function install({files, mtimes = {}, onRead = () => {}}) {
    const listed = [];
    const mem = memoryFs({
        files,
        mtimes: Object.fromEntries(Object.entries(mtimes).map(([p, s]) => [p, s * 1000])),
        onRead: path => { onRead(path); },
        onList: path => {
            if (path.startsWith(SESSIONS))
                listed.push(path.slice(SESSIONS.length + 1));
        },
    });
    stub.overrides['gi://GLib'] = {
        ...mem.GLib, SeekType: {SET: 0}, getenv: () => null, get_home_dir: () => HOME, get_real_time: () => 1,
    };
    stub.overrides['gi://Gio'] = mem.Gio;
    return listed;
}

const line = (at, used) => `${JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: {type: 'token_count', rate_limits: {primary: {used_percent: used, window_minutes: 300}}},
})}\n`;

test('the Codex transcript scan is async, newest day first, and reads 4 levels deep', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.parse('2026-09-13T12:00:00Z');
    const files = {
        [`${SESSIONS}/2026/09/13/rollout-new.jsonl`]: line(now - 60_000, 40),
        [`${SESSIONS}/2026/09/12/rollout-old.jsonl`]: line(now - 3_600_000, 10),
        [`${SESSIONS}/x/y/z/w/deep4.jsonl`]: '',
        [`${SESSIONS}/x/y/z/w/v/deep5.jsonl`]: '',
    };
    const mtimes = {
        [`${SESSIONS}/2026/09/13/rollout-new.jsonl`]: now / 1000,
        [`${SESSIONS}/2026/09/12/rollout-old.jsonl`]: now / 1000 - 3600,
        [`${SESSIONS}/x/y/z/w/deep4.jsonl`]: 1,
    };
    const listed = install({files, mtimes});
    const {recordedCodexUsage} = await import('../claude-usage-panel@fschmutz.github.io/lib/codex.js');
    const pending = recordedCodexUsage(now);
    assert.ok(pending instanceof Promise, 'the scan hands back a promise, the shell never waits on it');
    const got = await pending;
    assert.equal(got.reason, null);
    assert.deepEqual(got.cards.map(c => c.percent), [40]);
    // x/ sorts after 2026/, so it is walked first; the 5th level never is.
    assert.deepEqual(listed, ['', 'x', 'x/y', 'x/y/z', 'x/y/z/w', '2026', '2026/09', '2026/09/13', '2026/09/12']);
});

test('a GNOME switch keeps a token the codex CLI rotated between the sync-back and the write', async t => {
    t.after(() => { stub.overrides = {}; });
    const fix = JSON.parse(fs.readFileSync(new URL('./fixtures/codex.json', import.meta.url), 'utf8'));
    const [ana, ben] = fix.team.profiles;
    const files = {
        [`${PROFILES}/${ana.name}.json`]: JSON.stringify(ana),
        [`${PROFILES}/${ben.name}.json`]: JSON.stringify(ben),
        [AUTH]: JSON.stringify(ana.auth),
    };
    const rotated = {...ana.auth, tokens: {...ana.auth.tokens, refresh_token: 'rt-rotated'}};
    let authReads = 0;
    install({files, onRead: path => {
        // The CLI refreshes the live login after the sync-back read it (read
        // 1), before the switch looks again (read 2).
        if (path === AUTH && ++authReads === 2)
            files[AUTH] = JSON.stringify(rotated);
    }});
    const {switchCodexTo} = await import('../claude-usage-panel@fschmutz.github.io/lib/codex.js');
    const r = await switchCodexTo(ben.name);
    assert.deepEqual({from: r.from, changed: r.changed}, {from: ana.name, changed: true});
    const saved = JSON.parse(files[`${PROFILES}/${ana.name}.json`]);
    assert.equal(saved.auth.tokens.refresh_token, 'rt-rotated');
    assert.deepEqual(JSON.parse(files[AUTH]), ben.auth);
});

test('the Codex section draws its accounts at once and the usage when the scan lands', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.now();
    const files = {[`${SESSIONS}/2026/09/13/rollout.jsonl`]: line(now - 60_000, 40)};
    install({files, mtimes: {[`${SESSIONS}/2026/09/13/rollout.jsonl`]: now / 1000}});
    const {CodexController} = await import('../claude-usage-panel@fschmutz.github.io/lib/codexSection.js');
    const section = new CodexController({
        settings: {get_boolean: () => true},
        menu: {addMenuItem() {}},
        isDestroyed: () => false,
    });
    const drawn = section.refresh();
    assert.ok(drawn instanceof Promise, 'the store is read without blocking');
    await drawn;
    assert.equal(section._scanning, true, 'the accounts are drawn before any transcript is read');
    section._scanUsage(); // what the next refresh does once its store read lands
    assert.equal(section._rescan, true, 'a refresh during a scan queues one more, never a second walk');
    while (section._scanning)
        await new Promise(resolve => setImmediate(resolve));
    assert.match(section._note.text, /^Recorded by the codex CLI at /);
});

test('one Codex read lists the store and reads auth.json once, and syncs the rotated login', async t => {
    t.after(() => { stub.overrides = {}; });
    const fix = JSON.parse(fs.readFileSync(new URL('./fixtures/codex.json', import.meta.url), 'utf8'));
    const [ana, ben] = fix.team.profiles;
    const rotated = {...ana.auth, tokens: {...ana.auth.tokens, refresh_token: 'rt-rotated'}};
    const files = {
        [`${PROFILES}/${ana.name}.json`]: JSON.stringify(ana),
        [`${PROFILES}/${ben.name}.json`]: JSON.stringify(ben),
        [AUTH]: JSON.stringify(rotated),
    };
    const reads = [];
    install({files, onRead: path => reads.push(path)});
    const {readCodexAccounts} = await import('../claude-usage-panel@fschmutz.github.io/lib/codex.js');
    const state = await readCodexAccounts();
    assert.equal(state.active, ana.name);
    assert.deepEqual(state.accounts.map(a => [a.name, a.active]), [[ana.name, true], [ben.name, false]]);
    assert.equal(reads.filter(p => p === AUTH).length, 1, 'auth.json is read once');
    for (const p of [ana, ben])
        assert.equal(reads.filter(r => r === `${PROFILES}/${p.name}.json`).length, 1, `${p.name} is read once`);
    assert.equal(JSON.parse(files[`${PROFILES}/${ana.name}.json`]).auth.tokens.refresh_token, 'rt-rotated');
});
