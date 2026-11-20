// `claudectl session autosave pause | resume | status`: a paused schedule
// writes and prunes nothing until the next boot, a forced save still writes,
// and the boot time comes from /proc/stat btime (Linux) or kern.boottime
// (macOS), the values both panels read too.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {openTabs} from '../claude-code/tabs.js';
import {main} from '../claude-code/session-cli.js';
import {autosavePausePath} from '../claude-code/paths.js';
import {AUTO_SNAPSHOT_PREFIX} from '../claude-usage-panel@fschmutz.github.io/lib/pure/snapshots.js';
import {world} from './session-world.js';

const A = {pid: 101, name: 'API', id: 'aaaa1111-0000-0000-0000-000000000000', start: 500};
const B = {pid: 202, name: 'WEB', id: 'bbbb2222-0000-0000-0000-000000000000', start: 600};
const BOOT = Date.UTC(2026, 8, 23, 8, 0, 0);

const autos = (tabs) => tabs.snapshots().filter((s) => s.label.startsWith(AUTO_SNAPSHOT_PREFIX)).map((s) => s.label);

test('a paused schedule writes nothing and prunes nothing; --force still saves', (t) => {
    const io = {...world(t, [A, B]), bootAtMs: BOOT};
    const tabs = openTabs(io);
    tabs.autosave({keep: 1});
    const kept = autos(tabs);
    tabs.pauseAutosave();
    fs.rmSync(path.join(io.procDir, String(B.pid)), {recursive: true});
    const r = tabs.autosave({keep: 1});
    assert.equal(r.saved, null);
    assert.equal(r.reason, 'paused until the next boot');
    assert.deepEqual(r.pruned, []);
    assert.deepEqual(autos(tabs), kept, 'the newest snapshot is still the one paused on');
    const forced = tabs.autosave({keep: 5, force: true});
    assert.ok(forced.saved, 'the Save button is an explicit save');
    assert.equal(tabs.autosavePause().paused, true, 'and leaves the pause on');
});

test('a pause from an earlier boot is over: removed, and the run saves', (t) => {
    const io = {...world(t, [A]), bootAtMs: BOOT};
    openTabs(io).pauseAutosave();
    const later = openTabs({...io, bootAtMs: BOOT + 3_600_000});
    assert.deepEqual(later.autosavePause(), {paused: false, since: null, expired: true});
    assert.ok(later.autosave().saved);
    assert.ok(!fs.existsSync(autosavePausePath(io)), 'the stale file is gone');
});

test('resume starts the schedule again; pausing twice keeps the first time', (t) => {
    const io = {...world(t, [A]), bootAtMs: BOOT};
    const tabs = openTabs(io);
    const first = tabs.pauseAutosave();
    assert.equal(tabs.pauseAutosave().since, first.since);
    assert.equal(tabs.resumeAutosave(), true);
    assert.equal(tabs.resumeAutosave(), false);
    assert.ok(tabs.autosave().saved);
});

test('pause is refused when the boot time cannot be read', (t) => {
    const io = {...world(t, [A]), bootAtMs: null};
    assert.throws(() => openTabs(io).pauseAutosave(), /cannot read the boot time/);
    assert.ok(!fs.existsSync(autosavePausePath(io)));
});

test('boot time: /proc/stat btime on Linux, kern.boottime on macOS', (t) => {
    const io = world(t, [A]);
    fs.writeFileSync(path.join(io.procDir, 'stat'), 'cpu  1 2 3\nbtime 1790150400\nprocesses 9\n');
    const linux = openTabs({...io, platform: 'linux'});
    linux.pauseAutosave();
    const linuxFile = autosavePausePath({...io, platform: 'linux'});
    assert.equal(JSON.parse(fs.readFileSync(linuxFile, 'utf8')).bootAt, 1790150400000);
    linux.resumeAutosave();
    const calls = [];
    const mac = openTabs({...io, platform: 'darwin', exec: (cmd, args) => {
        calls.push([cmd, ...args]);
        return '{ sec = 1790150400, usec = 516644 } Wed Sep 23 08:00:00 2026\n';
    }});
    mac.pauseAutosave();
    assert.deepEqual(calls, [['/usr/sbin/sysctl', '-n', 'kern.boottime']]);
    const macFile = autosavePausePath({...io, platform: 'darwin'});
    assert.equal(JSON.parse(fs.readFileSync(macFile, 'utf8')).bootAt, 1790150400516);
});

test('claudectl session autosave pause | status | resume', async (t) => {
    const io = {...world(t, [A]), bootAtMs: BOOT};
    const run = async (...argv) => {
        let text = '';
        const code = await main(argv, {...io, stdout: (x) => { text += x; }});
        return {code, text};
    };
    assert.deepEqual(await run('autosave', 'status'), {code: 0, text: 'autosave running\n'});
    assert.match((await run('autosave', 'pause')).text, /^autosave paused since .+, until the next boot - /);
    const status = await run('autosave', 'status');
    assert.equal(status.code, 3);
    assert.match(status.text, /^autosave paused since/);
    assert.match((await run('autosave')).text, /no new snapshot \(paused until the next boot\)/);
    assert.equal((await run('autosave', 'resume')).text, 'autosave resumed\n');
    await assert.rejects(run('autosave', 'stop'), /autosave takes pause, resume or status/);
});
