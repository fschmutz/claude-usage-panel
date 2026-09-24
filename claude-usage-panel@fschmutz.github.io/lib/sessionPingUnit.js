// Session-ping schedule, systemd side. Pure string work - no gi imports, so it
// unit-tests under plain `node`.
//
// This is the Linux twin of ClaudeUsageCore/SessionPing.swift: the extension's
// preferences and `./install.sh sessionping` are two frontends over ONE
// schedule, and the unit files on disk are the source of truth (nothing is
// mirrored into GSettings). install.sh reads these files back with
// line-oriented sed, so the rendered text must keep the exact shapes its
// `_sp_current_times` / `_sp_current_days` parsers match:
//
//   OnCalendar=*-*-* 05:30:00
//   ExecStart=/path/to/session-ping.sh --quiet --days=1,2,3,4,5
//   ExecStart="/path/with blanks/session-ping.sh" --quiet --days=1,2,3,4,5
//
// The runner is quoted exactly like scripts/install/scheduler.sh
// _sched_systemd_word, and read back the way scripts/auto-update.sh
// runner_in() does, so either writer's unit parses in every reader.

export const SP_UNIT = 'claude-usage-panel-sessionping';

export const DEFAULT_TIMES = ['05:30'];
export const DEFAULT_DAYS = [1, 2, 3, 4, 5];

export function isValidPingTime(t) {
    return /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(t ?? ''));
}

/** Zero-pad an accepted time so "9:00" and "09:00" cannot both be scheduled. */
export function normalizePingTime(t) {
    if (!isValidPingTime(t))
        return null;
    const [h, m] = String(t).split(':');
    return `${String(Number(h)).padStart(2, '0')}:${m}`;
}

/** The `--days=` value baked into the runner invocation: sorted, comma-joined. */
export function daysArg(days) {
    const list = [...new Set((days ?? []).filter(d => d >= 1 && d <= 7))].sort((a, b) => a - b);
    return (list.length ? list : DEFAULT_DAYS).join(',');
}

/**
 * One ExecStart= word for systemd. A plain path stays bare (the shape every
 * existing unit has); anything else is double-quoted with \\ and \" escaped,
 * and % / $ doubled, since systemd expands specifiers and variables even
 * inside quotes. Mirrors scripts/install/scheduler.sh _sched_systemd_word.
 */
export function systemdWord(word) {
    const s = String(word);
    if (!/[^A-Za-z0-9_./+,:@=-]/.test(s))
        return s;
    return `"${s.replace(/[\\"%$]/g, c => (c === '%' || c === '$' ? c + c : `\\${c}`))}"`;
}

/**
 * The first word of an ExecStart= value and what follows it: {word, rest}.
 * A double-quoted word is unescaped (\x -> x, %% -> %, $$ -> $); a bare one
 * ends at the first blank. Null when there is no word at all.
 */
export function splitExecWord(value) {
    const v = String(value ?? '');
    if (!v.startsWith('"')) {
        const m = /^(\S+)(.*)$/s.exec(v);
        return m ? {word: m[1], rest: m[2]} : null;
    }
    let word = '';
    for (let i = 1; i < v.length; i++) {
        const c = v[i];
        if (c === '"')
            return {word, rest: v.slice(i + 1)};
        if (c === '\\' && i + 1 < v.length) {
            word += v[++i];
        } else if ((c === '%' || c === '$') && v[i + 1] === c) {
            word += c;
            i++;
        } else {
            word += c;
        }
    }
    return null; // an unterminated quote is not a runner we can trust
}

export function serviceText(runner, days) {
    return `[Unit]
Description=Claude Usage Panel - session-window ping
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=${systemdWord(runner)} --quiet --days=${daysArg(days)}
`;
}

export function timerText(times) {
    const entries = (times ?? []).map(t => `OnCalendar=*-*-* ${t}:00\n`).join('');
    // Exact times are the point: no RandomizedDelaySec, and no catch-up on wake
    // (Persistent) - a late ping would only shift the window it was meant to
    // open. Same reasoning, same text, as install.sh.
    return `[Unit]
Description=Claude Usage Panel - session-window ping

[Timer]
${entries}Persistent=false

[Install]
WantedBy=timers.target
`;
}

/** Times out of a .timer file, in file order. */
export function parseTimerTimes(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
        const m = /^OnCalendar=\*-\*-\* (\d{2}:\d{2}):00\s*$/.exec(line);
        if (m)
            out.push(m[1]);
    }
    return out;
}

/** {runner, days} out of a .service file. Either may be missing. */
export function parseServiceExec(text) {
    // systemd's exec prefixes (-@+!:) come before the path; skip them.
    const m = /^ExecStart=[-@+!:]*(.*)$/m.exec(String(text ?? ''));
    const exec = m ? splitExecWord(m[1]) : null;
    if (!exec)
        return {runner: null, days: null};
    const daysMatch = /--days=([0-9,]+)/.exec(exec.rest);
    const days = daysMatch
        ? daysMatch[1].split(',').map(Number).filter(d => d >= 1 && d <= 7)
        : null;
    return {runner: exec.word, days: days && days.length ? days : null};
}
