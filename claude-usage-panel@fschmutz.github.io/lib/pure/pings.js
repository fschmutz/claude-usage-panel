// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Session-window planner ──────────────────────────────────────────────────
// Twin of ClaudeUsageCore/WindowPlanner.swift, kept identical by
// tests/fixtures/window-plan.json (asserted from both ports).
//
// Claude's 5-hour window is anchored to your first message, not the clock, so a
// 09:00 start fits only two full windows into a 09:00-18:00 day and the second
// runs out mid-afternoon. `install.sh sessionping` schedules pings; this
// decides WHEN, instead of making the user guess. It does not raise quota - it
// lines the windows up with the hours actually worked.

export const WINDOW_MINUTES = 5 * 60;

export function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

export function formatHHMM(minute) {
    const m = ((minute % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function coveragePercent(covered, day) {
    const len = day.endMinute - day.startMinute;
    return len > 0 ? Math.round((covered / len) * 100) : 0;
}

function summarize(pingTimes, coverage, day) {
    return (
        `${pingTimes.join(' ')} · ${coverage}% of ` +
        `${formatHHMM(day.startMinute)}-${formatHHMM(day.endMinute)} covered`
    );
}

/**
 * Plan `count` back-to-back windows across a working day.
 * A ping inside an already-open window is wasted (the window stays anchored to
 * its own first message), so the only real choice is where the FIRST one goes.
 */
export function planWindows(day, count = 2) {
    const dayLen = day.endMinute - day.startMinute;
    // More windows than the day can use is meaningless: the extras start after
    // the day is over (and used to wrap past midnight). Cap at the number it
    // takes to blanket the working day.
    const useful = Math.max(1, Math.ceil(dayLen / WINDOW_MINUTES));
    const n = Math.max(1, Math.min(count, useful));
    const span = n * WINDOW_MINUTES;
    let first = span >= dayLen ? day.endMinute - span : day.startMinute;
    first = Math.max(0, Math.min(first, day.startMinute));

    const windows = [];
    let covered = 0;
    for (let i = 0; i < n; i++) {
        const open = first + i * WINDOW_MINUTES;
        const close = open + WINDOW_MINUTES;
        const overlap = Math.max(
            0,
            Math.min(close, day.endMinute) - Math.max(open, day.startMinute),
        );
        covered += overlap;
        windows.push({openMinute: open, usefulMinutes: overlap});
    }
    const pingTimes = windows.map((w) => formatHHMM(w.openMinute));
    const coveredMinutes = Math.min(covered, dayLen);
    const pct = coveragePercent(coveredMinutes, day);
    return {pingTimes, windows, coveredMinutes, coveragePercent: pct, summary: summarize(pingTimes, pct, day)};
}

/**
 * Coverage of a schedule the user already has, so the UI can say
 * "yours covers 56%, this would cover 100%". Overlapping windows are unioned,
 * never summed - a naive sum ranks a redundant schedule above a spread one.
 */
export function evaluateWindows(pingTimes, day) {
    const opens = pingTimes
        .map(parseHHMM)
        .filter((v) => v !== null)
        .sort((a, b) => a - b);
    if (!opens.length) return null;

    const windows = [];
    const merged = [];
    for (const open of opens) {
        const close = open + WINDOW_MINUTES;
        const overlap = Math.max(
            0,
            Math.min(close, day.endMinute) - Math.max(open, day.startMinute),
        );
        windows.push({openMinute: open, usefulMinutes: overlap});
        const lo = Math.max(open, day.startMinute);
        const hi = Math.min(close, day.endMinute);
        if (hi <= lo) continue;
        const last = merged[merged.length - 1];
        if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
        else merged.push([lo, hi]);
    }
    const coveredMinutes = merged.reduce((a, [lo, hi]) => a + (hi - lo), 0);
    const times = opens.map(formatHHMM);
    const pct = coveragePercent(coveredMinutes, day);
    return {pingTimes: times, windows, coveredMinutes, coveragePercent: pct, summary: summarize(times, pct, day)};
}

// ── Session-ping status ─────────────────────────────────────────────────────
// scripts/session-ping.sh writes `date '+%Y-%m-%dT%H:%M:%S%z'` into
// $XDG_STATE_HOME/claude-usage-panel/last-ping after a successful ping. The
// offset it prints has NO colon (+0200), which Date.parse only accepts through
// a legacy path and ISO8601DateFormatter rejects outright - so every port
// parses the stamp with the same explicit regex instead. Twin of
// ClaudeUsageCore/SessionPingStatus.swift, pinned by tests/fixtures/sessions.json.

const STAMP_RE =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse a session-ping stamp to epoch ms. Returns null on anything else. */
export function parseStamp(text) {
    const m = STAMP_RE.exec(String(text ?? '').trim());
    if (!m)
        return null;
    const [, y, mo, d, h, mi, s, zone] = m;
    let offsetMin = 0;
    if (zone && zone !== 'Z') {
        const sign = zone[0] === '-' ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
    } else if (!zone) {
        // No offset at all: treat it as local time, like `date` would print it.
        const local = new Date(
            Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
        return local.getTime();
    }
    const utc = Date.UTC(
        Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return utc - offsetMin * 60_000;
}

/** Local calendar day of an instant, as YYYY-MM-DD. */
export function localDay(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
        `${String(d.getDate()).padStart(2, '0')}`;
}

/** Local wall-clock HH:MM of an instant. */
export function formatClock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * "05:30", "yesterday 05:30", "Mon 05:30" (this week), else "2026-08-12 05:30".
 * Empty string when there is no readable stamp - the UIs then say "never".
 */
export function formatLastPing(text, nowMs) {
    const at = parseStamp(text);
    if (at === null)
        return '';
    const clock = formatClock(at);
    const today = localDay(nowMs);
    const day = localDay(at);
    if (day === today)
        return clock;
    if (day === localDay(nowMs - 86_400_000))
        return `yesterday ${clock}`;
    if (nowMs - at < 6 * 86_400_000)
        return `${DAY_NAMES[(new Date(at).getDay() + 6) % 7]} ${clock}`;
    return `${day} ${clock}`;
}

/**
 * The next scheduled ping, as "10:35" today or "Mon 05:30" on a later day.
 * @param {string[]} times HH:MM, any order
 * @param {number[]} days 1 = Monday … 7 = Sunday (empty → every day)
 */
export function nextPing(times, days, nowMs) {
    const mins = (times ?? []).map(parseHHMM).filter(v => v !== null).sort((a, b) => a - b);
    if (!mins.length)
        return '';
    const wanted = new Set((days ?? []).length ? days : [1, 2, 3, 4, 5, 6, 7]);
    const now = new Date(nowMs);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (let ahead = 0; ahead < 8; ahead++) {
        const d = new Date(nowMs + ahead * 86_400_000);
        const weekday = ((d.getDay() + 6) % 7) + 1; // 1 = Monday
        if (!wanted.has(weekday))
            continue;
        for (const m of mins) {
            if (ahead === 0 && m <= nowMin)
                continue;
            return ahead === 0 ? formatHHMM(m) : `${DAY_NAMES[weekday - 1]} ${formatHHMM(m)}`;
        }
    }
    return '';
}
