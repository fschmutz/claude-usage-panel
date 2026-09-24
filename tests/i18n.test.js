// Every string a user reads goes through the extension's gettext catalog:
// the usage and Cursor API errors (lib/claudeUsage.js, lib/cursorUsage.js,
// loaded through the GJS stubs in tests/gjs-stub.js, where a translated
// string comes back wrapped in «») and the dropdown strings checked on the
// sources.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {URL} from 'node:url';

import {EXT, load, stub} from './gjs-stub.js';

const read = rel => fs.readFileSync(new URL(rel, EXT), 'utf8');

// ── Errors from the GJS I/O ─────────────────────────────────────────────────

test('the usage errors a user reads go through the extension catalog', async t => {
    stub.gettext = s => `«${s}»`;
    stub.overrides['gi://GLib'] = {
        getenv: () => null,
        get_home_dir: () => '/nonexistent',
        build_filenamev: parts => parts.join('/'),
        file_get_contents: () => { throw new Error('no such file'); },
    };
    t.after(() => {
        stub.gettext = s => s;
        stub.overrides = {};
    });
    const {fetchUsage} = await load('lib/claudeUsage.js');
    const r = await fetchUsage({}, null);
    assert.equal(r.code, 'no_token');
    assert.equal(r.message, '«No Claude credentials found. Sign in with Claude Code.»');
    const metadata = JSON.parse(fs.readFileSync(new URL('metadata.json', EXT), 'utf8'));
    assert.equal(stub.domain, metadata['gettext-domain'], 'the catalog the prefs process binds');
});

test('the Cursor API errors go through the catalog too', async t => {
    stub.gettext = s => `«${s}»`;
    t.after(() => {
        stub.gettext = s => s;
        stub.overrides = {};
    });
    stub.overrides['gi://GLib'] = {PRIORITY_DEFAULT: 0, base64_encode: () => 'eA==', Bytes: class {}};
    const status = {code: 401};
    stub.overrides['gi://Soup'] = {
        Message: {
            new: () => ({
                request_headers: {append: () => {}},
                set_request_body_from_bytes: () => {},
                get_status: () => status.code,
            }),
        },
    };
    const session = {
        send_and_read_async: (_m, _p, _c, cb) => cb(session, null),
        send_and_read_finish: () => ({get_data: () => new Uint8Array(0)}),
    };
    const {fetchCursor} = await load('lib/cursorUsage.js');
    await assert.rejects(fetchCursor(session, 'k'), {message: '«Cursor API key rejected»'});
    status.code = 500;
    await assert.rejects(fetchCursor(session, 'k'), {message: '«Cursor HTTP 500»'});
});

// ── Other strings the dropdown shows ─────────────────────────────────────────
// Every string passed to _() / ngettext() in a GNOME source is extracted by
// scripts/update-po.sh; a bare literal never reaches a translator.
test('the header title goes through gettext', () => {
    const src = read('lib/headerBar.js');
    assert.match(src, /text: _\('Claude usage'\)/);
    assert.doesNotMatch(src, /text: '[A-Za-z]/, 'a bare literal label in the header');
});

test('the running-session count after a switch uses plural forms', () => {
    const src = read('lib/accountsSection.js');
    assert.match(src, /import \{gettext as _, ngettext\} from/);
    assert.match(src, /ngettext\(\s*' - %d running session keeps the old login until restarted',\s*' - %d running sessions keep the old login until restarted',\s*r\.running\)/);
    assert.doesNotMatch(src, /session\(s\)/, 'a "(s)" plural instead of ngettext');
});
