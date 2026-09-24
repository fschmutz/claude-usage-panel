// Session-ping day arithmetic across DST, and where the Node clients look for
// the ping stamp and keep their scratch files.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
    formatLastPing, nextPing, shiftLocalDay,
} from '../claude-usage-panel@fschmutz.github.io/lib/pure.js';
import {
    historyPath, lastPingPath, scratchDir, tokensCachePath,
} from '../claude-code/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A zone with DST, so a fixed 24 h step lands on the wrong date. Node re-reads
// TZ on assignment; restored after each test so no other assertion inherits it.
function inZone(t, tz) {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    t.after(() => {
        if (prev === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = prev;
    });
}

test('nextPing does not skip Sunday across spring-forward (23 h Sunday)', (t) => {
    inZone(t, 'Europe/Zurich');
    const satLate = new Date(2026, 2, 28, 23, 30).getTime(); // Sat 2026-03-28 23:30 CET
    assert.equal(nextPing(['05:30'], [7, 1], satLate), 'Sun 05:30');
    assert.equal(nextPing(['09:00'], [1, 2, 3, 4, 5, 6, 7], satLate), 'Sun 09:00');
});

test('nextPing does not repeat Sunday across fall-back (25 h Sunday)', (t) => {
    inZone(t, 'Europe/Zurich');
    const sunEarly = new Date(2026, 9, 25, 0, 30).getTime(); // Sun 2026-10-25 00:30 CEST
    assert.equal(nextPing(['00:10'], [], sunEarly), 'Mon 00:10');
});

test('nextPing across New York spring-forward', (t) => {
    inZone(t, 'America/New_York');
    const satLate = new Date(2026, 2, 7, 23, 30).getTime(); // Sat 2026-03-07 23:30 EST
    assert.equal(nextPing(['09:00'], [], satLate), 'Sun 09:00');
});

test('formatLastPing says "yesterday" the morning after a 23 h day', (t) => {
    inZone(t, 'Europe/Zurich');
    const monEarly = new Date(2026, 2, 30, 0, 30).getTime(); // Mon 2026-03-30 00:30 CEST
    assert.equal(formatLastPing('2026-03-29T10:00:00+0200', monEarly), 'yesterday 10:00');
    assert.equal(formatLastPing('2026-03-30T00:10:00+0200', monEarly), '00:10');
});

test('shiftLocalDay steps calendar days whatever the day length', (t) => {
    inZone(t, 'Europe/Zurich');
    const satLate = new Date(2026, 2, 28, 23, 30).getTime();
    const sun = shiftLocalDay(satLate, 1);
    assert.deepEqual([sun.getFullYear(), sun.getMonth(), sun.getDate()], [2026, 2, 29]);
    const fri = shiftLocalDay(satLate, -1);
    assert.deepEqual([fri.getFullYear(), fri.getMonth(), fri.getDate()], [2026, 2, 27]);
});

// scripts/session-ping.sh is the only writer of last-ping. Read its STATE_DIR
// line and expand it the way bash would, so the reader cannot drift from it.
function scriptPingPath(env, home) {
    const text = fs.readFileSync(path.join(ROOT, 'scripts', 'session-ping.sh'), 'utf8');
    const m = /^STATE_DIR="\$\{XDG_STATE_HOME:-\$HOME\/([^}]+)\}\/([^"]+)"$/m.exec(text);
    assert.ok(m, 'session-ping.sh STATE_DIR line changed shape');
    const base = env.XDG_STATE_HOME || path.join(home, m[1]);
    return path.join(base, m[2], 'last-ping');
}

for (const platform of ['linux', 'darwin']) {
    for (const env of [{}, {XDG_STATE_HOME: '/x/state'}]) {
        test(`lastPingPath (${platform}, ${JSON.stringify(env)}) is where session-ping.sh writes`, () => {
            const home = platform === 'darwin' ? '/Users/me' : '/home/me';
            assert.equal(lastPingPath({platform, homedir: home, env}), scriptPingPath(env, home));
        });
    }
}

test('scratch files never sit under a shared tmp dir on Linux', () => {
    const io = {platform: 'linux', homedir: '/home/me', env: {}};
    assert.equal(historyPath(io), '/home/me/.claude/claude-usage-history.json');
    assert.equal(tokensCachePath(io), '/home/me/.claude/claude-usage-statusline-tokens.json');
    const cfg = {platform: 'linux', homedir: '/home/me', env: {CLAUDE_CONFIG_DIR: '/c'}};
    assert.equal(scratchDir(cfg), '/c');
    const rt = {platform: 'linux', homedir: '/home/me', env: {XDG_RUNTIME_DIR: '/run/user/1000'}};
    assert.equal(historyPath(rt), '/run/user/1000/claude-usage-history.json');
    for (const p of [historyPath(io), tokensCachePath(io), historyPath(rt)])
        assert.ok(!p.startsWith(`${os.tmpdir()}${path.sep}`) && !p.startsWith('/tmp/'), p);
});

test('scratch files use the per-user $TMPDIR on macOS, and an injected tmpdir wins', () => {
    assert.equal(scratchDir({platform: 'darwin', homedir: '/Users/me', env: {}}), os.tmpdir());
    assert.equal(historyPath({tmpdir: '/sandbox', platform: 'linux', env: {XDG_RUNTIME_DIR: '/r'}}),
        '/sandbox/claude-usage-history.json');
});
