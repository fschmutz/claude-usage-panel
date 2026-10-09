// The throwaway world the claudectl session tests run in: a HOME with Claude
// Code's session registry, transcripts and a fake /proc (tabs.test.js,
// close.test.js).
import fs from 'node:fs';
import path from 'node:path';

import {transcriptPath} from '../claude-code/tabs.js';
import {sandboxHome} from './helpers.js';

// A HOME holding Claude Code's session registry, the matching transcripts and
// a fake /proc, plus an io bound to all of it. `sessions`: {pid, name, cwd,
// id, start, alive = true, transcript = true, kind = 'interactive'}.
export function world(t, sessions = [], {selfParent} = {}) {
    const io = sandboxHome(t, {prefix: 'cup-tabs-'});
    const {home} = io;
    const reg = path.join(home, '.claude', 'sessions');
    const proc = path.join(home, 'proc');
    fs.mkdirSync(reg, {recursive: true});
    let clock = Date.UTC(2026, 8, 23, 17, 0, 0);
    for (const s of sessions) {
        const cwd = s.cwd ?? path.join(home, 'repos', s.name);
        fs.mkdirSync(cwd, {recursive: true});
        fs.writeFileSync(path.join(reg, `${s.pid}.json`), JSON.stringify({
            pid: s.pid, sessionId: s.id, cwd, name: s.name, kind: s.kind ?? 'interactive',
            procStart: String(s.start), startedAt: s.pid, status: 'idle',
        }));
        if (s.transcript !== false) {
            const tp = transcriptPath(path.join(home, '.claude', 'projects'), cwd, s.id);
            fs.mkdirSync(path.dirname(tp), {recursive: true});
            fs.writeFileSync(tp, '{}\n');
        }
        if (s.alive !== false) {
            fs.mkdirSync(path.join(proc, String(s.pid)), {recursive: true});
            // comm with a space and a paren, as the kernel allows; after it,
            // field 3 (state) onward - starttime is field 22
            const fields = Array.from({length: 50}, (_, i) => (i === 19 ? String(s.start) : '0'));
            fields[0] = 'S';
            fs.writeFileSync(path.join(proc, String(s.pid), 'stat'), `${s.pid} (cl (x) y) ${fields.join(' ')}`);
            fs.writeFileSync(path.join(proc, String(s.pid), 'status'), 'Name:\tclaude\nPPid:\t1\n');
        }
    }
    if (selfParent) {
        fs.mkdirSync(path.join(proc, '9999'), {recursive: true});
        fs.writeFileSync(path.join(proc, '9999', 'status'), `Name:\tnode\nPPid:\t${selfParent}\n`);
    }
    // toolDirs: []: only the test's PATH counts, never the host's own tmux
    Object.assign(io, {procDir: proc, pid: 9999, nowMs: () => (clock += 60_000), toolDirs: []});
    return io;
}
