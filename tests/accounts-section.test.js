// The GNOME accounts section over the GJS stubs, on the REAL store: that the
// inline notices reach the dropdown, that a row whose login broke stops
// showing figures, that the rotation target is what the shared contract says,
// and that pressing a repair answers beside the control rather than only in a
// notification. The rules themselves are pinned by tests/fixtures/notices.json
// (parity.test.js); this is the wiring.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TextDecoder, TextEncoder} from 'node:util';

import {load, stub} from './gjs-stub.js';

const HOME = '/home/tester';
const ACCOUNTS = `${HOME}/.local/state/claude-usage-panel/accounts`;

const oauth = name => ({
    accessToken: `at-${name}`, refreshToken: `rt-${name}`, expiresAt: 4_000_000_000_000,
});

const profile = (name, uuid) => JSON.stringify({
    version: 1, name, savedAt: null,
    account: {accountUuid: uuid, emailAddress: `${name.toLowerCase()}@example.com`},
    credentials: {claudeAiOauth: oauth(name)},
});

/** The two files Claude Code holds for a login, as the store reads them. */
const liveLogin = (name, uuid) => ({
    [`${HOME}/.claude/.credentials.json`]: JSON.stringify({claudeAiOauth: oauth(name)}),
    [`${HOME}/.claude.json`]: JSON.stringify({
        oauthAccount: {accountUuid: uuid, emailAddress: `${name.toLowerCase()}@example.com`},
    }),
});

/**
 * An AccountsController over stubs, with a fake filesystem under `files` - the
 * real lib/accounts.js reads it, so the store's own decisions (which profile
 * is live, whether a login is torn) are the ones under test.
 */
async function controller(t, {enabled = true, files = {}, usage = null} = {}) {
    const encode = new TextEncoder();
    const decode = new TextDecoder();
    const notes = [];
    const clipboard = [];
    const writes = [];
    stub.overrides['gi://GLib'] = {
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        getenv: () => null,
        get_home_dir: () => HOME,
        build_filenamev: parts => parts.join('/'),
        path_get_dirname: p => p.slice(0, p.lastIndexOf('/')),
        mkdir_with_parents: () => 0,
        get_real_time: () => 1,
        FileSetContentsFlags: {CONSISTENT: 0},
        timeout_add_seconds: () => 1,
        Source: {remove: () => {}},
        file_get_contents: path => {
            if (!(path in files)) throw new Error(`no such file: ${path}`);
            return [true, encode.encode(files[path])];
        },
        file_set_contents: (path, bytes) => {
            files[path] = decode.decode(bytes);
            return true;
        },
        file_set_contents_full: (path, bytes) => {
            files[path] = decode.decode(bytes);
            return true;
        },
    };
    // A file tree in a plain object: enumerate lists one level, move renames,
    // delete drops. Enough for the real store's atomic write and its listing.
    // Subprocess answers `ps` with no Claude running, so a switch does not
    // wait forever on a callback the generic stub never makes.
    stub.overrides['gi://Gio'] = {
        FileQueryInfoFlags: {NONE: 0},
        FileCopyFlags: {OVERWRITE: 0},
        SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
        Cancellable: class {
            cancel() {}
        },
        Subprocess: {
            new: () => ({
                communicate_utf8_async: (_in, _c, cb) => cb({
                    communicate_utf8_finish: () => [true, '', ''],
                    get_successful: () => true,
                }, null),
                force_exit() {},
            }),
        },
        File: {
            new_for_path: path => ({
                path,
                enumerate_children() {
                    const names = Object.keys(files)
                        .filter(f => f.startsWith(`${path}/`))
                        .map(f => f.slice(path.length + 1))
                        .filter(f => !f.includes('/'));
                    let i = 0;
                    return {next_file: () => (i < names.length
                        ? {get_name: () => names[i++]} : null)};
                },
                move(target) {
                    files[target.path] = files[path];
                    delete files[path];
                    writes.push(target.path);
                },
                delete: () => { delete files[path]; },
            }),
        },
    };
    stub.overrides['gi://St'] = {
        Clipboard: {get_default: () => ({set_text: (_type, text) => clipboard.push(text)})},
        ClipboardType: {CLIPBOARD: 0},
    };
    globalThis.logError = () => {};
    t.after(() => {
        stub.overrides = {};
        delete globalThis.logError;
    });

    // The network half: the store builds a Soup.Message and hands it to the
    // session, so a fake session plus a message that remembers its headers is
    // all it takes to answer per token. `usage(token)` returns the status and
    // the body the endpoint would have given that account.
    stub.overrides['gi://Soup'] = {
        Message: {
            new: () => {
                const headers = {};
                return {
                    headers,
                    request_headers: {append: (k, v) => { headers[k] = v; }},
                    get_status() { return this._status ?? 200; },
                };
            },
        },
    };
    const answer = usage ?? (() => ({status: 200, body: {limits: []}}));
    const session = {
        send_and_read_async(message, _priority, _cancellable, cb) {
            const token = (message.headers.authorization ?? '').replace('Bearer ', '');
            const {status, body} = answer(token);
            message._status = status;
            cb({send_and_read_finish: () => ({get_data: () => encode.encode(JSON.stringify(body))})},
                null);
        },
    };

    const {AccountsController} = await load('lib/accountsSection.js');
    const settings = {
        get_boolean: k => (k === 'accounts-enabled' ? enabled : false),
        get_int: () => 90,
    };
    const c = new AccountsController({
        settings, session, menu: {addMenuItem: () => {}},
        notify: (...a) => notes.push(a),
        refreshSoon: () => notes.push(['refreshSoon']),
        onActiveChanged: () => {},
        syncAutoSwitch: () => {},
        isDestroyed: () => false,
    });
    return {c, notes, clipboard, files, writes};
}

test('a live login nobody saved gets a notice naming what a switch would park it as', async t => {
    const {c} = await controller(t, {
        files: {
            [`${HOME}/.claude/.credentials.json`]:
                JSON.stringify({claudeAiOauth: {accessToken: 'at-live'}}),
            [`${HOME}/.claude.json`]:
                JSON.stringify({oauthAccount: {emailAddress: 'admin@example.com'}}),
        },
    });
    await c.refresh([]);
    assert.deepEqual(c._state.notices.map(n => [n.kind, n.action, n.arg]),
        [['unsaved-login', 'save', 'admin@example.com']]);
    // The section is visible with nothing saved - that is the point of the notice.
    assert.equal(c._item.visible, true);
});

test('an unfinished switch is the loudest row, and its button finishes it', async t => {
    // A switch marked in flight whose credentials never arrived: the live
    // login is still PRO's while the marker says the target was PERSO.
    const {c, files} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PRO.json`]: profile('PRO', 'u-pro'),
            [`${ACCOUNTS}/PERSO.json`]: profile('PERSO', 'u-perso'),
            [`${ACCOUNTS}/.switch-pending.json`]:
                JSON.stringify({at: 1, from: 'PRO', to: 'PERSO'}),
            ...liveLogin('PRO', 'u-pro'),
        },
    });
    await c.refresh([]);
    const notice = c._state.notices[0];
    assert.deepEqual([notice.kind, notice.action, notice.arg],
        ['pending-switch', 'finish-switch', 'PERSO']);

    await c.repair(notice.id);
    // Re-running the switch IS the repair: the target's credentials are
    // installed and the marker is gone.
    assert.equal(files[`${ACCOUNTS}/.switch-pending.json`], undefined);
    assert.match(files[`${HOME}/.claude/.credentials.json`], /at-PERSO/);
    // The answer sits beside the button that caused it, not only in a toast.
    assert.match(c._outcomeFor(`notice:${notice.id}`).text, /PERSO/);
});

test('a login the endpoint refuses reads refresh-failed, shows no figures, and offers the command',
    async t => {
        const {c, clipboard} = await controller(t, {
            files: {
                [`${ACCOUNTS}/PRO.json`]: profile('PRO', 'u-pro'),
                [`${ACCOUNTS}/OLD.json`]: profile('OLD', 'u-old'),
                ...liveLogin('PRO', 'u-pro'),
            },
            // The endpoint turns OLD's stored token down, though its dates are
            // fine - exactly the case a row must not paper over.
            usage: token => (token === 'at-OLD'
                ? {status: 401, body: {}}
                : {status: 200, body: {limits: [{kind: 'session', percent: 3}]}}),
        });
        await c.refresh([{key: 'session', percent: 3}]);
        const row = c._state.rows.find(r => r.name === 'OLD');
        assert.equal(row.health, 'refresh-failed');
        assert.equal(row.cards, null, 'a broken login shows no figures at all');

        const notice = c._state.notices.find(n => n.arg === 'OLD');
        assert.deepEqual([notice.kind, notice.action], ['refresh-failed', 'relogin']);
        await c.repair(notice.id);
        assert.deepEqual(clipboard, ['claude auth login']);
        assert.match(c._outcomeFor(`notice:${notice.id}`).text, /claude auth login/);
    });

test('the rotation target is the next saved name, wrapping; one login is no rotation', async t => {
    const both = {
        [`${ACCOUNTS}/PRO.json`]: profile('PRO', 'u-pro'),
        [`${ACCOUNTS}/PERSO.json`]: profile('PERSO', 'u-perso'),
        ...liveLogin('PRO', 'u-pro'),
    };
    const {c} = await controller(t, {files: both});
    await c.refresh([]);
    assert.equal(c._state.rotationTarget, 'PERSO');
    assert.deepEqual(c._state.notices, [], 'healthy rows raise nothing');

    const {[`${ACCOUNTS}/PERSO.json`]: _dropped, ...alone} = both;
    const single = await controller(t, {files: alone});
    await single.c.refresh([]);
    assert.equal(single.c._state.rotationTarget, null);
});

test('accounts off means nothing is read and nothing is drawn', async t => {
    const {c} = await controller(t, {
        enabled: false,
        files: {[`${HOME}/.claude.json`]: JSON.stringify({oauthAccount: {emailAddress: 'a@b.c'}})},
    });
    await c.refresh([]);
    assert.equal(c._item.visible, false);
    assert.deepEqual(c._state.notices, []);
});
