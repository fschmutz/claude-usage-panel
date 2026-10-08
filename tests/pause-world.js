// Shared scaffolding for the pause-*.test.js files: a throwaway HOME holding
// Claude Code's live-session registry, a fake /proc and a state dir, with a
// clock the test moves. Nothing here touches the real ~/.claude, the real
// state dir or a running Claude process.
import fs from 'node:fs';
import path from 'node:path';

import {sandboxHome} from './helpers.js';

const NOW = 1788264000000;
export const A = 'aaaa1111-0000-4000-8000-000000000001';
export const B = 'bbbb2222-0000-4000-8000-000000000002';

/** A sandbox with live sessions in Claude Code's registry and a fake /proc. */
export function pauseWorld(t, sessions = [], {now = NOW} = {}) {
    const io = sandboxHome(t, {prefix: 'cup-pause-'});
    const reg = path.join(io.home, '.claude', 'sessions');
    fs.mkdirSync(reg, {recursive: true});
    for (const s of sessions) {
        const start = s.procStart ?? String(s.pid * 10);
        const cwd = s.cwd ?? path.join(io.home, 'repos', s.name);
        fs.mkdirSync(cwd, {recursive: true});
        fs.writeFileSync(path.join(reg, `${s.pid}.json`), JSON.stringify({
            pid: s.pid, sessionId: s.id, cwd, name: s.name, kind: 'interactive', procStart: start,
            startedAt: s.pid, status: 'idle',
        }));
        if (s.alive === false) continue;
        const proc = path.join(io.procDir, String(s.pid));
        fs.mkdirSync(proc, {recursive: true});
        const fields = Array.from({length: 50}, (_, i) => (i === 19 ? start : '0'));
        fs.writeFileSync(path.join(proc, 'stat'), `${s.pid} (claude) ${fields.join(' ')}`);
        fs.writeFileSync(path.join(proc, 'status'), 'Name:\tclaude\nPPid:\t1\n');
    }
    let clock = now;
    Object.assign(io, {
        env: {XDG_STATE_HOME: path.join(io.home, 'state')}, pid: 4242, nowMs: () => clock, toolDirs: [],
        tick: (ms) => {
            clock += ms;
        },
    });
    return io;
}

/** This process's real kernel start time (Linux), or null: a spawned hook
 *  reads the real /proc, so a session it must recognise as its claude is
 *  registered with the real value. */
export function realProcStart(pid = process.pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null;
    } catch {
        return null;
    }
}
