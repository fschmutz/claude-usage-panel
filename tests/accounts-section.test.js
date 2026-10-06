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
async function controller(t, {enabled = true, files = {}, usage = null, token = null, tokenDelayMs = 0,
    mtimes = {}, onQueryInfo = null, onRead = null} = {}) {
    const encode = new TextEncoder();
    const decode = new TextDecoder();
    const notes = [];
    const clipboard = [];
    const writes = [];
    const timers = new Map();
    const removed = [];
    let nextTimer = 1;
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
        // Timers are kept, not run: a test fires one with fire(id). The
        // refresh lock's poll sleep is the exception - it really waits.
        timeout_add: (_prio, ms, fn) => {
            const id = nextTimer++;
            timers.set(id, fn);
            if (ms < 1000)
                setTimeout(() => timers.get(id)?.(), ms);
            return id;
        },
        Source: {remove: id => { removed.push(id); timers.delete(id); }},
        uuid_string_random: () => `id-${nextTimer++}`,
        Bytes: class {
            constructor(data) { this.data = data; }
        },
        file_get_contents: path => {
            const early = onRead?.(path);
            if (typeof early === 'string')
                return [true, encode.encode(early)];
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
    const exists = {matches: (_domain, code) => code === 'EXISTS'};
    const notFound = {matches: (_domain, code) => code === 'NOT_FOUND'};
    stub.overrides['gi://Gio'] = {
        FileQueryInfoFlags: {NONE: 0},
        FileCreateFlags: {PRIVATE: 1},
        IOErrorEnum: {EXISTS: 'EXISTS', NOT_FOUND: 'NOT_FOUND'},
        FileCopyFlags: {NONE: 0, OVERWRITE: 1},
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
                get_path: () => path,
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
                    if (!(path in files))
                        throw notFound;
                    files[target.path] = files[path];
                    mtimes[target.path] = mtimes[path];
                    delete files[path];
                    delete mtimes[path];
                    writes.push(target.path);
                },
                delete: () => {
                    delete files[path];
                    delete mtimes[path];
                },
                // O_EXCL: the refresh lock.
                create() {
                    if (path in files)
                        throw exists;
                    files[path] = '';
                    mtimes[path] = Date.now();
                    return {
                        write_all: bytes => { files[path] = decode.decode(bytes); },
                        close() {},
                    };
                },
                // mtimes[path] in ms (default: now); onQueryInfo(path) may
                // stand in for the answer, as a waiter's earlier look would.
                query_info: () => {
                    const early = onQueryInfo?.(path);
                    if (early)
                        return early;
                    if (!(path in files))
                        throw notFound;
                    const ms = mtimes[path] ?? Date.now();
                    return {get_modification_date_time: () => ({to_unix: () => Math.floor(ms / 1000)})};
                },
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
            new: method => {
                const headers = {};
                return {
                    method,
                    headers,
                    request_headers: {append: (k, v) => { headers[k] = v; }},
                    set_request_body_from_bytes(_type, bytes) { this.body = decode.decode(bytes.data); },
                    get_status() { return this._status ?? 200; },
                };
            },
        },
    };
    // `usage(token)` answers the usage GET per bearer token; `token(rt)` the
    // refresh POST per refresh token (after `tokenDelayMs`, so two refreshes
    // can overlap). Every refresh token sent is recorded in `exchanges`.
    const answer = usage ?? (() => ({status: 200, body: {limits: []}}));
    const exchanges = [];
    const session = {
        send_and_read_async(message, _priority, _cancellable, cb) {
            const reply = ({status, body}) => {
                message._status = status;
                cb({send_and_read_finish: () => ({get_data: () => encode.encode(JSON.stringify(body))})},
                    null);
            };
            if (message.method === 'POST') {
                const rt = JSON.parse(message.body).refresh_token;
                exchanges.push(rt);
                const r = (token ?? (() => ({status: 500, body: {}})))(rt);
                setTimeout(() => reply(r), tokenDelayMs);
                return;
            }
            reply(answer((message.headers.authorization ?? '').replace('Bearer ', '')));
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
    const fire = id => {
        const fn = timers.get(id);
        timers.delete(id);
        return fn?.();
    };
    return {c, notes, clipboard, files, writes, exchanges, session, timers, removed, fire};
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

test('a login that stops answering keeps the weekly reset it last reported', async t => {
    const reset = new Date(Date.now() + 3 * 86_400_000).toISOString();
    let refuse = false;
    const {c, files} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PRO.json`]: profile('PRO', 'u-pro'),
            [`${ACCOUNTS}/OLD.json`]: profile('OLD', 'u-old'),
            ...liveLogin('PRO', 'u-pro'),
        },
        usage: token => (token === 'at-OLD' && refuse
            ? {status: 401, body: {}}
            : {status: 200, body: {limits: [{kind: 'weekly_all', percent: 20, resets_at: reset}]}}),
    });
    await c.refresh([{key: 'session', percent: 3}]);
    const kept = Date.parse(reset);
    assert.deepEqual(JSON.parse(files[`${ACCOUNTS}/.weekly-resets.json`]), {OLD: kept});
    assert.match(c._section._metaText(c._state.rows.find(r => r.name === 'OLD')), /^W 20% ↻[23]d\d+h$/);

    refuse = true;
    await c.refresh([{key: 'session', percent: 3}]);
    const row = c._state.rows.find(r => r.name === 'OLD');
    assert.equal(row.cards, null);
    assert.equal(row.weeklyResetMs, kept);
    assert.match(c._section._metaText(row), /^\(refresh failed\) · W ↻[23]d\d+h$/);
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

test('the outcome timer repaints with the real save-as name, and destroy() removes it', async t => {
    const {c, timers, removed, fire} = await controller(t, {
        files: {
            [`${HOME}/.claude/.credentials.json`]:
                JSON.stringify({claudeAiOauth: {accessToken: 'at-live'}}),
            [`${HOME}/.claude.json`]:
                JSON.stringify({oauthAccount: {emailAddress: 'admin@example.com'}}),
        },
    });
    await c.refresh([]);
    const painted = [];
    c._section.update = state => painted.push(state);
    c._setOutcome('rotate', true, 'done');
    const [timer] = [...timers.keys()];
    fire(timer);
    // The repaint after the TTL is the same state the notice was drawn from:
    // "Save as admin", never "Save as " with an empty name.
    assert.deepEqual(painted.map(p => p.saveAs('admin@example.com')), ['admin', 'admin']);

    c._setOutcome('rotate', true, 'again');
    const [pending] = [...timers.keys()];
    c.destroy();
    assert.ok(removed.includes(pending), 'no timer may fire into a destroyed dropdown');
    assert.equal(timers.size, 0);
});

test('the store never refreshes the live login, even when its credentials cannot be read', async t => {
    const stale = JSON.stringify({
        version: 1, name: 'PRO', savedAt: null,
        account: {accountUuid: 'u-pro', emailAddress: 'pro@example.com'},
        credentials: {claudeAiOauth: {accessToken: 'at-PRO', refreshToken: 'rt-PRO', expiresAt: 1}},
    });
    const {exchanges, session, files} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PRO.json`]: stale,
            [`${HOME}/.claude.json`]: JSON.stringify({oauthAccount: {accountUuid: 'u-pro'}}),
        },
        token: () => ({status: 200, body: {access_token: 'x', refresh_token: 'y', expires_in: 60}}),
    });
    const store = await load('lib/accounts.js');
    assert.equal(store.liveAccountName(), 'PRO');
    await assert.rejects(store.accessTokenFor(session, 'PRO'), {code: 'no_token'});
    await assert.rejects(store.switchTo(session, 'PRO'), {code: 'no_token'});
    assert.deepEqual(exchanges, [], 'the refresh token Claude Code holds was not spent');
    assert.match(files[`${ACCOUNTS}/PRO.json`], /rt-PRO/);
});

test('concurrent refreshes of one profile spend its refresh token once', async t => {
    const spent = new Set();
    const {exchanges, session, files} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PERSO.json`]: JSON.stringify({
                version: 1, name: 'PERSO', savedAt: null, account: {accountUuid: 'u-perso'},
                credentials: {claudeAiOauth: {accessToken: 'at-PERSO', refreshToken: 'rt-PERSO', expiresAt: 1}},
            }),
        },
        tokenDelayMs: 20,
        token: rt => {
            if (spent.has(rt))
                return {status: 400, body: {error: 'invalid_grant'}};
            spent.add(rt);
            return {status: 200, body: {access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600}};
        },
    });
    const store = await load('lib/accounts.js');
    const got = await Promise.all([1, 2, 3].map(() => store.accessTokenFor(session, 'PERSO')));
    assert.deepEqual(got.map(g => g.token), ['at-new', 'at-new', 'at-new']);
    assert.deepEqual(exchanges, ['rt-PERSO']);
    assert.equal(files[`${ACCOUNTS}/.refresh-PERSO.lock`], undefined, 'the lock is released');
});

test('two waiters that judged one lock stale: only one takes it over, the token is spent once', async t => {
    const lock = `${ACCOUNTS}/.refresh-PERSO.lock`;
    const spent = new Set();
    // B's one look at the lock, taken before A replaced it: the crashed
    // holder's mtime and id, answered once each.
    const early = {query: false, read: false};
    const crashedAt = Date.now() - 31_000;
    const {exchanges, session, files} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PERSO.json`]: JSON.stringify({
                version: 1, name: 'PERSO', savedAt: null, account: {accountUuid: 'u-perso'},
                credentials: {claudeAiOauth: {accessToken: 'at-PERSO', refreshToken: 'rt-PERSO', expiresAt: 1}},
            }),
            [lock]: 'crashed',
        },
        mtimes: {[lock]: crashedAt},
        onQueryInfo: p => {
            if (p !== lock || !early.query)
                return null;
            early.query = false;
            return {get_modification_date_time: () => ({to_unix: () => Math.floor(crashedAt / 1000)})};
        },
        onRead: p => {
            if (p !== lock || !early.read)
                return null;
            early.read = false;
            return 'crashed';
        },
        tokenDelayMs: 20,
        token: rt => {
            if (spent.has(rt))
                return {status: 400, body: {error: 'invalid_grant'}};
            spent.add(rt);
            return {status: 200, body: {access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600}};
        },
    });
    const store = await load('lib/accounts.js');
    // A takes the stale lock over and holds it through its exchange.
    const first = store.accessTokenFor(session, 'PERSO');
    while (exchanges.length === 0)
        await new Promise(resolve => setTimeout(resolve, 0));
    assert.notEqual(files[lock], 'crashed', 'A holds its own lock');
    early.query = true;
    early.read = true;
    const second = store.accessTokenFor(session, 'PERSO');
    const got = await Promise.all([first, second]);
    assert.deepEqual(early, {query: false, read: false}, 'B judged the stale lock');
    assert.deepEqual(got.map(g => g.token), ['at-new', 'at-new']);
    assert.deepEqual(exchanges, ['rt-PERSO'], 'one exchange: B never removed the lock A holds');
    assert.deepEqual(Object.keys(files).filter(f => f.includes('.lock')), [], 'no lock, no moved-aside copy left');
});

test('a refresh the token endpoint answers 503 leaves the row unreachable, not refresh-failed', async t => {
    const {c} = await controller(t, {
        files: {
            [`${ACCOUNTS}/PRO.json`]: profile('PRO', 'u-pro'),
            [`${ACCOUNTS}/OLD.json`]: JSON.stringify({
                version: 1, name: 'OLD', savedAt: null, account: {accountUuid: 'u-old'},
                credentials: {claudeAiOauth: {accessToken: 'at-OLD', refreshToken: 'rt-OLD', expiresAt: 1}},
            }),
            ...liveLogin('PRO', 'u-pro'),
        },
        token: () => ({status: 503, body: {}}),
    });
    await c.refresh([]);
    const row = c._state.rows.find(r => r.name === 'OLD');
    assert.equal(row.health, 'unreachable');
    assert.deepEqual(c._state.notices.map(n => [n.kind, n.action]), [['unreachable', 'retry']]);
});
