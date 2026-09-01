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

export function serviceText(runner, days) {
    return `[Unit]
Description=Claude Usage Panel - session-window ping
Documentation=https://github.com/fschmutz/claude-usage-panel

[Service]
Type=oneshot
ExecStart=${runner} --quiet --days=${daysArg(days)}
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
    const m = /^ExecStart=(\S+)(.*)$/m.exec(String(text ?? ''));
    if (!m)
        return {runner: null, days: null};
    const daysMatch = /--days=([0-9,]+)/.exec(m[2]);
    const days = daysMatch
        ? daysMatch[1].split(',').map(Number).filter(d => d >= 1 && d <= 7)
        : null;
    return {runner: m[1], days: days && days.length ? days : null};
}
