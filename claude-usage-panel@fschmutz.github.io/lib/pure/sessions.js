// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

import {formatClock, localDay, parseStamp, shiftLocalDay} from './pings.js';

// ── Recent Claude Code sessions ─────────────────────────────────────────────
// Rank today's sessions by the tokens they actually spent, so the dropdown's
// resume links point at the work that is costing the plan - not merely the last
// window that was touched. Everything here is pure string/array work; the
// platform layer walks ~/.claude/projects/*/*.jsonl and feeds it chunks
// (lib/sessionIndex.js on GNOME, Sessions.swift on macOS, the node ports
// inline). Twin of ClaudeUsageCore/Sessions.swift, pinned by
// tests/fixtures/sessions.json.

/** Tokens billed for one assistant turn. Cache READS are excluded: they bill at
 *  a fraction and counting them at face value ranks every long session first,
 *  which is the opposite of "where did the spend go". Cache creation is real
 *  write cost, so it stays. Same rule as scripts/token-attribution.mjs. */
export function turnTokens(usage) {
    if (!usage)
        return 0;
    return (Number(usage.input_tokens) || 0) +
        (Number(usage.output_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0);
}

const SEEN_IDS_MAX = 32;

/** Fresh accumulator for one transcript file. `byDay` is capped to the days the
 *  UI can ask for; `ids` is a bounded tail of message ids so a replayed line at
 *  an incremental read boundary is not counted twice. */
export function newSessionAcc() {
    return {sessionId: null, cwd: null, title: null, lastMs: 0, byDay: {}, ids: []};
}

/**
 * Fold ONE transcript line into an accumulator, in place.
 * @param {string} line raw JSONL line (a partial trailing line is skipped)
 * @param {object} acc from newSessionAcc(), or a rehydrated index entry
 * @param {string} defaultDay YYYY-MM-DD used when a usage line carries no timestamp
 */
export function foldSessionLine(line, acc, defaultDay) {
    if (!line)
        return acc;
    // Most lines of a long transcript are user text and tool results with no
    // usage block. Once the header fields are known, a substring probe skips
    // the JSON.parse for all of them - that is what makes a 60 MB transcript
    // affordable to scan at all. A rename line is still parsed: the LAST
    // custom title wins, and a session that was never named must not pay a
    // parse per line for a title it will never get.
    const hasUsage = line.indexOf('"usage"') >= 0;
    const hasTitle = line.indexOf('"customTitle"') >= 0;
    if (!hasUsage && !hasTitle && acc.sessionId && acc.cwd)
        return acc;
    let o;
    try {
        o = JSON.parse(line);
    } catch {
        return acc; // partial last line while Claude Code is writing
    }
    if (!acc.sessionId && typeof o.sessionId === 'string')
        acc.sessionId = o.sessionId;
    if (!acc.cwd && typeof o.cwd === 'string')
        acc.cwd = o.cwd;
    if (typeof o.customTitle === 'string' && o.customTitle)
        acc.title = o.customTitle;
    const usage = o.message?.usage;
    if (!usage)
        return acc;
    const id = o.message?.id;
    if (id) {
        if (acc.ids.includes(id))
            return acc;
        acc.ids.push(id);
        if (acc.ids.length > SEEN_IDS_MAX)
            acc.ids.shift();
    }
    const at = o.timestamp ? parseStamp(o.timestamp) : null;
    if (at !== null && at > acc.lastMs)
        acc.lastMs = at;
    const day = at !== null ? localDay(at) : defaultDay;
    acc.byDay[day] = (acc.byDay[day] ?? 0) + turnTokens(usage);
    return acc;
}

/** The mtime an index entry records for a file: whole seconds, in ms. Every
 *  port stats at a different precision (GIO whole seconds, node fractional
 *  ms, Foundation a Double), and the entry is shared - an entry one port
 *  wrote must compare equal to the other ports' stat of the same file, or
 *  each re-folds and rewrites the whole index after the other. */
export function indexMtime(ms) {
    return Math.floor(Number(ms) / 1000) * 1000;
}

/** Drop every day but the two the UI can show, so the on-disk index cannot grow
 *  without bound as sessions are resumed across weeks. Yesterday is a calendar
 *  step: 24 h before 23:30 on a 25 h fall-back day is still that same day. */
export function pruneByDay(byDay, nowMs) {
    const keep = new Set([localDay(nowMs), localDay(shiftLocalDay(nowMs, -1).getTime())]);
    const out = {};
    for (const [day, n] of Object.entries(byDay ?? {})) {
        if (keep.has(day))
            out[day] = n;
    }
    return out;
}

/** Display name for a session: its custom title, else the project directory. */
export function sessionTitle(entry) {
    if (entry.title)
        return entry.title;
    const cwd = entry.cwd ?? '';
    const base = cwd.replace(/\/+$/, '').split('/').pop();
    return base || (entry.sessionId ?? '').slice(0, 8) || 'session';
}

/** 847 → "847", 16_700 → "16.7k", 1_240_000 → "1.2M". Mirrors the status line. */
export function compactTokens(n) {
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) {
        const k = (n / 1e3).toFixed(1);
        return k === '1000.0' ? '1.0M' : `${k}k`;
    }
    return String(Math.round(n));
}

/**
 * Today's sessions, biggest spender first.
 * @param {Array<{sessionId, cwd, title, lastMs, byDay}>} entries index rows
 * @param {{nowMs: number, limit: number}} opts
 * @returns {Array<{sessionId, cwd, title, lastMs, tokens, label, when}>}
 *   A session with no tokens today but activity today still lists (it opened a
 *   window even if the turns were cheap); one with neither is dropped.
 */
export function rankSessions(entries, {nowMs = Date.now(), limit = 5} = {}) {
    const today = localDay(nowMs);
    return (entries ?? [])
        .filter(e => e.sessionId)
        .map(e => ({
            sessionId: e.sessionId,
            cwd: e.cwd ?? '',
            title: e.title ?? null,
            lastMs: e.lastMs ?? 0,
            tokens: (e.byDay ?? {})[today] ?? 0,
        }))
        .filter(e => e.tokens > 0 || (e.lastMs > 0 && localDay(e.lastMs) === today))
        .sort((a, b) => b.tokens - a.tokens || b.lastMs - a.lastMs)
        .slice(0, Math.max(0, limit))
        .map(e => ({
            ...e,
            label: sessionTitle(e),
            when: e.lastMs ? formatClock(e.lastMs) : '',
        }));
}

// ── Resuming one of them in a terminal ──────────────────────────────────────

/** POSIX single-quoting. Session ids and project paths come out of a log file,
 *  so they are quoted, never interpolated bare, in every port. */
export function shellQuote(s) {
    return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

/** The command that resumes one session where it was left: enter the project,
 *  resume that exact session id. Same string in every port (the MCP tool hands
 *  it to a human or an agent to run). */
export function resumeCommand(entry, {claudeBin = 'claude'} = {}) {
    const cd = entry.cwd ? `cd ${shellQuote(entry.cwd)} && ` : '';
    return `${cd}${claudeBin} --resume ${shellQuote(entry.sessionId)}`;
}

/** What a resume CLICK runs: the same thing, then an interactive shell, so the
 *  window does not vanish with whatever Claude Code printed last. */
export function interactiveResume(entry, opts) {
    return `${resumeCommand(entry, opts)}; exec "$SHELL" -i`;
}

// Terminals we know how to open at a directory with a command, best first.
// Mirrored in claude-code/terminals.js (`claudectl session open` must open the
// same terminal the same way); tests/terminals.test.js asserts the parity.
// `argv(dir, cmd)` returns the full argv - no shell involved on our side, the
// command string is handed to bash -lc by the terminal itself.
export const TERMINALS = [
    {bin: 'ghostty', desktop: ['com.mitchellh.ghostty.desktop'],
        argv: (d, c) => [`--working-directory=${d}`, '-e', 'bash', '-lc', c]},
    {bin: 'kitty', desktop: ['kitty.desktop'], argv: (d, c) => ['--directory', d, 'bash', '-lc', c]},
    {bin: 'wezterm', desktop: ['org.wezfurlong.wezterm.desktop'],
        argv: (d, c) => ['start', '--cwd', d, '--', 'bash', '-lc', c]},
    {bin: 'alacritty', desktop: ['Alacritty.desktop'],
        argv: (d, c) => ['--working-directory', d, '-e', 'bash', '-lc', c]},
    {bin: 'foot', desktop: ['foot.desktop', 'footclient.desktop'], argv: (d, c) => ['-D', d, 'bash', '-lc', c]},
    {bin: 'gnome-terminal', desktop: ['org.gnome.Terminal.desktop'],
        argv: (d, c) => [`--working-directory=${d}`, '--', 'bash', '-lc', c]},
    {bin: 'konsole', desktop: ['org.kde.konsole.desktop'], argv: (d, c) => ['--workdir', d, '-e', 'bash', '-lc', c]},
    {bin: 'tilix', desktop: ['com.gexperts.Tilix.desktop'], argv: (d, c) => ['-w', d, '-e', 'bash', '-lc', c]},
    {bin: 'xfce4-terminal', desktop: ['xfce4-terminal.desktop'],
        argv: (d, c) => [`--working-directory=${d}`, '-x', 'bash', '-lc', c]},
    {bin: 'x-terminal-emulator', desktop: [], argv: (d, c) => ['-e', 'bash', '-lc', `cd ${shellQuote(d)} && ${c}`]},
    {bin: 'xterm', desktop: ['xterm.desktop', 'debian-xterm.desktop'],
        argv: (d, c) => ['-e', 'bash', '-lc', `cd ${shellQuote(d)} && ${c}`]},
    // The Default Terminal spec launcher: whatever the desktop's default is,
    // even one we have no entry for. Last, so plain autodetection prefers a
    // terminal we can drive directly.
    {bin: 'xdg-terminal-exec', desktop: [], argv: (d, c) => [`--dir=${d}`, '--', 'bash', '-lc', c]},
];

/** The terminal binary behind a Desktop Entry ID, as `xdg-terminal-exec
 *  --print-id` prints it (an action may follow a colon), or null. */
export function terminalForDesktopId(id) {
    const bare = String(id ?? '').trim().split(':')[0];
    return TERMINALS.find(t => t.desktop.includes(bare))?.bin ?? null;
}

/** The terminal behind Debian's x-terminal-emulator alternative
 *  (/usr/bin/gnome-terminal.wrapper -> gnome-terminal), or null. */
export function terminalForAlternative(target) {
    const name = String(target ?? '').split('/').pop().replace(/\.wrapper$/, '');
    return TERMINALS.find(t => t.bin === name && t.bin !== 'x-terminal-emulator')?.bin ?? null;
}

/**
 * Which terminal a resume opens. The user's explicit choice, then $TERMINAL,
 * then the DESKTOP's default terminal (the Default Terminal spec, then the
 * Debian alternative) - installing a second emulator must not silently take
 * over - and only then the first installed one we know.
 * @param {object} p {configured, envTerminal, desktopId, alternative}
 * @param {(bin: string) => boolean} installed
 */
export function pickTerminal({configured, envTerminal, desktopId, alternative}, installed) {
    if (configured)
        return configured;
    if (envTerminal && installed(envTerminal))
        return envTerminal;
    if (desktopId) {
        const bin = terminalForDesktopId(desktopId);
        if (bin && installed(bin))
            return bin;
        if (installed('xdg-terminal-exec'))
            return 'xdg-terminal-exec';
    }
    const alt = terminalForAlternative(alternative);
    if (alt && installed(alt))
        return alt;
    return TERMINALS.find(t => installed(t.bin))?.bin ?? null;
}

/**
 * argv for launching `command` in `cwd`.
 * @param {string} bin terminal binary, from the setting or autodetection
 * @param {string} cwd project directory ('' → the terminal's default)
 * @param {string} command shell command to run inside it
 * A terminal we have no entry for still works: it gets the lowest-common
 * `-e bash -lc "cd … && …"` form rather than being refused.
 */
export function terminalArgv(bin, cwd, command) {
    if (!bin)
        return null;
    const dir = cwd || '.';
    const known = TERMINALS.find(t => t.bin === bin || bin.endsWith(`/${t.bin}`));
    const tail = known
        ? known.argv(dir, command)
        : ['-e', 'bash', '-lc', `cd ${shellQuote(dir)} && ${command}`];
    return [bin, ...tail];
}
