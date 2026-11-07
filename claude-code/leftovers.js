// What each Claude Code session left running, read from the OS: the process
// table with the CLAUDE_CODE_SESSION_ID every harness child carries. The
// classification (job, harness, orphan) is lib/pure/leftovers.js
// pauseLeftovers; this file only reads processes. Linux reads /proc; macOS
// runs `ps` twice (the environment for the id, the bare command for the
// text, so no environment value is ever printed).

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {pauseLeftovers} from '../claude-usage-panel@fschmutz.github.io/lib/pure/leftovers.js';

// `ps -E` appends the environment after the arguments; only that tail is
// searched, and its LAST match wins.
const SID_RE = /(?:^|\s)CLAUDE_CODE_SESSION_ID=([A-Za-z0-9-]+)(?=\s|$)/g;
const lastSid = (text) => [...String(text ?? '').matchAll(SID_RE)].pop()?.[1] ?? null;
const ENV_KEY = 'CLAUDE_CODE_SESSION_ID=';

/** `pid ppid rest` lines of `ps -o pid=,ppid=,command=`. */
export function parsePs(text) {
    const out = new Map();
    for (const line of String(text ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
        if (m) out.set(Number(m[1]), {ppid: Number(m[2]), rest: m[3]});
    }
    return out;
}

/**
 * Bind the scan to one environment. io (all optional, read at call time):
 * platform, procDir ('/proc'), exec (execFileSync), pid (process.pid).
 */
export function openLeftovers(io = {}) {
    const platform = () => io.platform ?? process.platform;
    const procDir = () => io.procDir ?? '/proc';
    const exec = (cmd, args) => (io.exec ?? execFileSync)(cmd, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

    function readProc(pid) {
        const base = path.join(procDir(), String(pid));
        try {
            const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8');
            // the command name in (...) may hold spaces and parens: cut after the last ')'
            const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            const cmd = fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
            let sessionId = null;
            try {
                const env = fs.readFileSync(path.join(base, 'environ'), 'utf8').split('\0');
                const hit = env.find((e) => e.startsWith(ENV_KEY));
                if (hit) sessionId = hit.slice(ENV_KEY.length);
            } catch {
                // another user's process, or gone: no session id
            }
            return {pid, ppid: Number.isInteger(ppid) ? ppid : 0, cmd, sessionId};
        } catch {
            return null; // exited while we read
        }
    }

    /** Every process: {pid, ppid, cmd, sessionId}. Throws when the table
     *  cannot be read: an unread table is never "nothing left running". */
    function processes() {
        if (platform() === 'linux') {
            const names = fs.readdirSync(procDir());
            return names.filter((n) => /^\d+$/.test(n)).map((n) => readProc(Number(n))).filter(Boolean);
        }
        const bare = parsePs(exec('ps', ['-axww', '-o', 'pid=,ppid=,command=']));
        const withEnv = parsePs(exec('ps', ['-axwwE', '-o', 'pid=,ppid=,command=']));
        if (!bare.size) throw new Error('ps listed no process');
        return [...bare].map(([pid, b]) => {
            // `ps -E` prints the arguments, then the environment: only what
            // follows the bare command line is environment
            const full = withEnv.get(pid)?.rest ?? '';
            const env = full.startsWith(b.rest) ? full.slice(b.rest.length) : '';
            return {pid, ppid: b.ppid, cmd: b.rest, sessionId: lastSid(env)};
        });
    }

    /** This process and every ancestor: never reported as a leftover. */
    function selfChain(procs) {
        const byPid = new Map(procs.map((p) => [p.pid, p]));
        const chain = [];
        for (let pid = io.pid ?? process.pid; pid > 1 && !chain.includes(pid); pid = byPid.get(pid)?.ppid ?? 0) chain.push(pid);
        return chain;
    }

    /** pauseLeftovers over the live table. `live`: rows {session_id, pid}.
     *  Throws when the process table cannot be read. */
    function scan(live = []) {
        const procs = processes();
        const map = {};
        for (const r of live) if (r?.session_id && r.pid) map[r.session_id] = r.pid;
        return pauseLeftovers({procs, live: map, skip: selfChain(procs)});
    }

    return {processes, scan};
}
