// The GNOME pause store read (lib/pause.js) and its dropdown section
// (lib/pauseSection.js) over the GJS stubs, on an in-memory registry and
// pause store: every read is async (each sync Gio / GLib call throws), the
// row states are lib/pure/pause.js's, a click runs the installed claudectl
// naming one session by pid, and with the setting off nothing is read.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TextEncoder} from 'node:util';

import {stub} from './gjs-stub.js';

const HOME = '/home/tester';
const SESSIONS = `${HOME}/.claude/sessions`;
const PAUSE = `${HOME}/.local/state/claude-usage-panel/pause`;
const CLI = `${HOME}/.local/bin/claudectl`;
const encode = new TextEncoder();
const ON = {get_boolean: key => key === 'pause-enabled'};
const OFF = {get_boolean: () => false};

const stat = start => `4242 (claude (dev)) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start} 0\n`;
const registry = (pid, sessionId, start, extra = {}) => JSON.stringify({
    kind: 'interactive', pid, sessionId, cwd: `/work/${sessionId}`, procStart: String(start), ...extra,
});
const request = (at, targets, extra = {}) => JSON.stringify({
    version: 1, id: 'req-2', kind: 'pause', at, targets, from: 'gnome', sessions: [], ...extra,
});
const json = v => JSON.stringify(v);

/** GLib + Gio over `files` (path -> text); only the async reads work.
 *  Returns the recorder of timers and spawned argv. */
function install(files, {cliResult = {ok: true, stdout: '', stderr: ''}} = {}) {
    const rec = {timers: [], removed: [], spawned: []};
    const sync = name => () => {
        throw new Error(`synchronous ${name} on the Shell main loop`);
    };
    stub.overrides['gi://GLib'] = {
        PRIORITY_LOW: 300,
        PRIORITY_DEFAULT: 0,
        SOURCE_REMOVE: false,
        FileTest: {IS_EXECUTABLE: 1},
        getenv: () => null,
        get_home_dir: () => HOME,
        build_filenamev: parts => parts.join('/'),
        file_get_contents: sync('file_get_contents'),
        file_test: path => path === CLI,
        find_program_in_path: () => null,
        timeout_add_seconds: (_p, seconds, fn) => rec.timers.push({seconds, fn}),
        Source: {remove: id => rec.removed.push(id)},
    };
    stub.overrides['gi://Gio'] = {
        _promisify: () => {},
        FileQueryInfoFlags: {NONE: 0},
        SubprocessFlags: {STDOUT_PIPE: 1, STDERR_PIPE: 2},
        Cancellable: class {
            cancel() {}
        },
        Subprocess: {
            new: argv => {
                rec.spawned.push(argv);
                return {
                    communicate_utf8_async(_in, _c, cb) {
                        Promise.resolve().then(() => cb(this, null));
                    },
                    communicate_utf8_finish: () => [true, cliResult.stdout, cliResult.stderr],
                    get_successful: () => cliResult.ok,
                    force_exit: () => {},
                };
            },
        },
        File: {
            new_for_path: path => ({
                enumerate_children: sync('enumerate_children'),
                load_contents: sync('load_contents'),
                async enumerate_children_async() {
                    const names = Object.keys(files).filter(f => f.startsWith(`${path}/`))
                        .map(f => f.slice(path.length + 1)).filter(n => !n.includes('/'));
                    if (!names.length)
                        throw new Error('not found');
                    let batch = names.map(name => ({get_name: () => name}));
                    return {
                        next_files_async: async () => {
                            const out = batch;
                            batch = [];
                            return out;
                        },
                        close_async: async () => true,
                    };
                },
                async load_contents_async() {
                    if (!(path in files))
                        throw new Error(`no such file: ${path}`);
                    return [encode.encode(files[path]), ''];
                },
            }),
        },
    };
    return rec;
}

/** A store where one request names five sessions in every state. */
function world(now) {
    return {
        // live, answered SAFE for this request
        [`${SESSIONS}/11.json`]: registry(11, 'aaaa-safe', 100, {name: 'api'}),
        '/proc/11/stat': stat(100),
        [`${PAUSE}/aaaa-safe.delivered.json`]: json({requestId: 'req-2', at: now - 5000, via: 'rewake'}),
        [`${PAUSE}/aaaa-safe.verdict.json`]: json({requestId: 'req-2', at: now - 1000, verdict: 'SAFE'}),
        // live, delivered by the backstop, its verdict answers an OLDER request
        [`${SESSIONS}/22.json`]: registry(22, 'bbbb-busy', 200, {name: 'web'}),
        '/proc/22/stat': stat(200),
        [`${PAUSE}/bbbb-busy.delivered.json`]: json({requestId: 'req-2', at: now - 4000, via: 'pretooluse'}),
        [`${PAUSE}/bbbb-busy.verdict.json`]: json({requestId: 'req-1', at: now - 9e5, verdict: 'NOT_SAFE'}),
        // live, not delivered, its waiter is alive
        [`${SESSIONS}/33.json`]: registry(33, 'cccc-armed', 300),
        '/proc/33/stat': stat(300),
        [`${PAUSE}/cccc-armed.waiter`]: json({pid: 900, at: now - 6e4, procStart: '9000'}),
        '/proc/900/stat': stat(9000),
        // live, not delivered, the waiter's pid was reused by another process
        [`${SESSIONS}/44.json`]: registry(44, 'dddd-stale', 400, {name: 'docs'}),
        '/proc/44/stat': stat(400),
        [`${PAUSE}/dddd-stale.waiter`]: json({pid: 901, at: now - 6e4, procStart: '1'}),
        '/proc/901/stat': stat(2),
        // a live session the request does not name: offered a Pause button
        [`${SESSIONS}/55.json`]: registry(55, 'ffff-other', 500, {name: 'blog'}),
        '/proc/55/stat': stat(500),
        [`${PAUSE}/request.json`]: request(now - 10_000,
            ['aaaa-safe', 'bbbb-busy', 'cccc-armed', 'dddd-stale', 'eeee-closed'],
            {sessions: [{sessionId: 'eeee-closed', name: 'infra', cwd: '/work/infra'}]}),
    };
}

test('readPauseStatus: async reads only; one row per target in request order, then the other live sessions', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.parse('2026-10-08T12:00:00Z');
    install(world(now));
    const {readPauseStatus} = await import('../claude-usage-panel@fschmutz.github.io/lib/pause.js');
    const {request, rows, summary} = await readPauseStatus({nowMs: now});
    assert.equal(request.id, 'req-2');
    assert.deepEqual(rows.map(r => [r.name, r.pid, r.state, r.via, r.verdict]), [
        ['api', 11, 'safe', 'rewake', 'SAFE'],
        ['web', 22, 'delivered', 'pretooluse', null],
        ['cccc-armed', 33, 'pending', null, null],
        ['docs', 44, 'unarmed', null, null],
        ['infra', null, 'gone', null, null],
        ['blog', 55, null, undefined, undefined],
    ]);
    assert.equal(summary.label, '1/5 safe');
    assert.equal(summary.pending, 3);
    assert.equal(summary.done, false);
});

test('readPauseStatus: past the TTL the request still shows, every unanswered row final (the CLI and macOS rule)', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.parse('2026-10-08T12:00:00Z');
    const files = world(now);
    files[`${PAUSE}/request.json`] = request(now - 3_600_001, ['aaaa-safe', 'bbbb-busy', 'cccc-armed']);
    install(files);
    const {readPauseStatus} = await import('../claude-usage-panel@fschmutz.github.io/lib/pause.js');
    const {request: r, rows, summary} = await readPauseStatus({nowMs: now});
    assert.equal(r.id, 'req-2');
    assert.deepEqual(rows.slice(0, 3).map(x => [x.name, x.state, x.via]),
        [['api', 'safe', 'rewake'], ['web', 'expired', 'pretooluse'], ['cccc-armed', 'expired', null]]);
    assert.deepEqual(rows.slice(3).map(x => x.state), [null, null]);
    assert.deepEqual([summary.label, summary.done], ['1/3 safe', true], 'nothing left to follow');
});

test('readPauseStatus: an "all" request never turns an invalid registry id into a path', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.parse('2026-10-08T12:00:00Z');
    const files = world(now);
    files[`${SESSIONS}/66.json`] = registry(66, '../evil', 600, {name: 'evil'});
    files['/proc/66/stat'] = stat(600);
    files[`${PAUSE}/request.json`] = request(now - 10_000, 'all');
    install(files);
    const {readPauseStatus} = await import('../claude-usage-panel@fschmutz.github.io/lib/pause.js');
    const {rows} = await readPauseStatus({nowMs: now});
    assert.ok(rows.length >= 5);
    assert.ok(rows.every(r => r.sessionId !== '../evil'), 'dropped, never read');
});

test('readPauseStatus: no store and no registry is empty; a junk request is no request', async t => {
    t.after(() => { stub.overrides = {}; });
    install({[`${PAUSE}/request.json`]: '{"version": 1, "id": "../x", "kind": "pause"}'});
    const {readPauseStatus} = await import('../claude-usage-panel@fschmutz.github.io/lib/pause.js');
    const st = await readPauseStatus({nowMs: 1});
    assert.deepEqual([st.request, st.rows], [null, []]);
});

test('pauseCommand: --no-wait, --from=gnome, one session by pid', async () => {
    const {pauseCommand} = await import('../claude-usage-panel@fschmutz.github.io/lib/pauseSection.js');
    assert.deepEqual(pauseCommand('/c', 'pause-all'), ['/c', 'session', 'pause', '--all', '--no-wait', '--from=gnome']);
    assert.deepEqual(pauseCommand('/c', 'pause-one', 22), ['/c', 'session', 'pause', '22', '--no-wait', '--from=gnome']);
    assert.deepEqual(pauseCommand('/c', 'resume-all'), ['/c', 'session', 'resume', '--all', '--no-wait', '--from=gnome']);
});

test('the words: every row state has its own, through the catalog; the summary counts', async t => {
    stub.gettext = s => `«${s}»`;
    t.after(() => { stub.gettext = s => s; });
    const {pauseStateText, pauseSummaryText} =
        await import('../claude-usage-panel@fschmutz.github.io/lib/pauseSection.js');
    const states = ['safe', 'not-safe', 'resumed', 'superseded', 'delivered', 'pending', 'unarmed', 'lost', 'expired', 'gone'];
    const texts = states.map(state => pauseStateText({state}));
    assert.equal(new Set(texts).size, states.length);
    assert.ok(texts.every(x => x.startsWith('«')), 'every state goes through gettext');
    assert.equal(pauseStateText({state: null}), '');
    assert.equal(pauseStateText({state: 'not-safe', reason: 'deploy running'}), '«NOT SAFE: %s»'.replace('%s', 'deploy running'));
    assert.equal(pauseStateText({state: 'delivered', via: 'rewake'}), '«delivered (%s), pausing»'.replace('%s', '«woken»'));
    assert.equal(pauseStateText({state: 'expired', via: 'rewake'}), '«no verdict within the hour»');
    stub.gettext = s => s;
    const summary = {total: 7, safe: 5, notSafe: 1, resumed: 0, pending: 1};
    assert.match(pauseSummaryText({kind: 'pause', at: 0}, summary), /^Pause \S+ · 5\/7 safe · 1 not safe · 1 in progress$/);
    assert.match(pauseSummaryText({kind: 'resume', at: 0}, {...summary, resumed: 3, total: 3, notSafe: 0, pending: 0}),
        /^Resume \S+ · 3\/3 resumed$/);
    assert.equal(pauseSummaryText(null, summary), '');
});

function section(settings, notes = []) {
    return import('../claude-usage-panel@fschmutz.github.io/lib/pauseSection.js').then(({PauseController}) =>
        new PauseController({
            settings,
            menu: {addMenuItem: () => {}, close: () => {}},
            notify: (title, body) => notes.push(body),
            isDestroyed: () => false,
        }));
}

test('off (the default): nothing read, no section, no follow-up timer', async t => {
    t.after(() => { stub.overrides = {}; });
    const rec = install({});
    stub.overrides['gi://Gio'].File.new_for_path = path => {
        throw new Error(`read ${path} with the section off`);
    };
    const s = await section(OFF);
    await s.refresh();
    assert.equal(s._item.visible, false);
    assert.equal(rec.timers.length, 0);
});

test('on: the summary shows, and an unanswered fresh request is followed until it settles', async t => {
    t.after(() => { stub.overrides = {}; });
    const now = Date.now();
    const files = world(now);
    const rec = install(files);
    const s = await section(ON);
    await s.refresh();
    assert.equal(s._item.visible, true);
    assert.match(s._summary.text, /1\/5 safe · 3 in progress$/);
    assert.equal(rec.timers.length, 1, 'a follow-up is armed');
    assert.equal(rec.timers[0].seconds, 3);
    // every target answers or ends: the request is done, no further follow-up
    for (const sid of ['bbbb-busy', 'cccc-armed', 'dddd-stale'])
        files[`${PAUSE}/${sid}.verdict.json`] = json({requestId: 'req-2', at: now, verdict: 'SAFE'});
    rec.timers[0].fn();
    await new Promise(r => setTimeout(r, 20));
    assert.match(s._summary.text, /4\/5 safe$/);
    assert.equal(rec.timers.length, 1, 'done: nothing left to follow');
});

test('a click runs the installed claudectl by pid; a refusal is notified with its own words', async t => {
    t.after(() => { stub.overrides = {}; });
    const rec = install({}, {cliResult: {ok: false, stdout: '', stderr: 'boom\nno running Claude Code session to pause\n'}});
    const notes = [];
    const s = await section(ON, notes);
    await s._act('pause-one', {pid: 22, name: 'repo'});
    assert.deepEqual(rec.spawned, [[CLI, 'session', 'pause', '22', '--no-wait', '--from=gnome']]);
    assert.deepEqual(notes, ['no running Claude Code session to pause']);
    assert.equal(s._busy, false, 'the buttons come back');
});

test('no claudectl: the click says how to install it and spawns nothing', async t => {
    t.after(() => { stub.overrides = {}; });
    const rec = install({});
    stub.overrides['gi://GLib'].file_test = () => false;
    const notes = [];
    const s = await section(ON, notes);
    await s._act('pause-all');
    assert.deepEqual(rec.spawned, []);
    assert.match(notes[0], /\.\/install\.sh pause/);
});
