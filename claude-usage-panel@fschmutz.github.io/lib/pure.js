// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Shared by the extension (extension.js / claudeUsage.js / cursorUsage.js).

const KIND_LABELS = {
    session: 'Current session',
    weekly_all: 'Weekly · all models',
    weekly_scoped: 'Weekly',
    weekly_oauth_apps: 'Weekly · apps',
};
const KIND_ORDER = ['session', 'weekly_all', 'weekly_scoped', 'weekly_oauth_apps'];

const SPARK_BLOCKS = ' ▁▂▃▄▅▆▇█';

export function clampPercent(v) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
}

export function severityClass(severity) {
    if (severity === 'critical')
        return 'cu-critical';
    if (severity === 'warning')
        return 'cu-warning';
    return 'cu-normal';
}

// Which pool a limit draws from. The API sends `group` ("session" / "weekly");
// payloads that predate it are grouped by the kind prefix instead.
function groupOf(kind, group) {
    if (group)
        return group;
    return String(kind).startsWith('weekly') ? 'weekly' : String(kind);
}

function normalizeLimit(entry) {
    let label = KIND_LABELS[entry.kind] ?? entry.kind;
    const model = entry.scope?.model?.display_name;
    if (model)
        label = `${label} · ${model}`;
    return {
        key: entry.kind + (model ? `:${model}` : ''),
        label,
        group: groupOf(entry.kind, entry.group),
        scoped: Boolean(model),
        percent: clampPercent(entry.percent),
        severity: entry.severity ?? 'normal',
        resetsAt: entry.resets_at ?? null,
        active: Boolean(entry.is_active),
    };
}

// A scoped (per-model) limit is a sub-cap ON its group's pooled limit, not a
// pool of its own: Fable usage counts toward `weekly_all` and shares its reset.
// The API leaves the scoped `resets_at` null until that model is used in the
// window, so borrow the pooled reset - otherwise the Fable card shows no
// countdown for every week it hasn't been touched yet.
function inheritPooledResets(cards) {
    for (const card of cards) {
        if (!card.scoped || card.resetsAt)
            continue;
        const pooled = cards.find(o => !o.scoped && o.group === card.group && o.resetsAt);
        if (pooled)
            card.resetsAt = pooled.resetsAt;
    }
    return cards;
}

// Extract normalized limit cards from the raw usage payload. Prefers the modern
// `limits[]` array; falls back to legacy five_hour / seven_day fields.
export function normalizeUsage(payload) {
    if (Array.isArray(payload?.limits) && payload.limits.length) {
        return inheritPooledResets(payload.limits.map(normalizeLimit))
            .sort((a, b) => {
                const ai = KIND_ORDER.indexOf(a.key.split(':')[0]);
                const bi = KIND_ORDER.indexOf(b.key.split(':')[0]);
                return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            });
    }
    const cards = [];
    if (Number.isFinite(Number(payload?.five_hour?.utilization))) {
        cards.push({
            key: 'session', label: KIND_LABELS.session,
            group: 'session', scoped: false,
            percent: clampPercent(payload.five_hour.utilization),
            severity: 'normal', resetsAt: payload.five_hour.resets_at ?? null, active: true,
        });
    }
    if (Number.isFinite(Number(payload?.seven_day?.utilization))) {
        cards.push({
            key: 'weekly_all', label: KIND_LABELS.weekly_all,
            group: 'weekly', scoped: false,
            percent: clampPercent(payload.seven_day.utilization),
            severity: 'normal', resetsAt: payload.seven_day.resets_at ?? null, active: false,
        });
    }
    return cards;
}

// Sub-line for a scoped (per-model) card. Its percent measures a *share* of the
// weekly pool - on Max, up to 50 % of the weekly allowance may go to Fable - so
// it is never extra headroom: every Fable token also moves `weekly_all`. Say so
// on the card, or a Fable reading of 0 % reads as an untouched second pool.
export function poolNote(card) {
    return card?.scoped && card.group === 'weekly'
        ? 'Share of the weekly all-models limit' : '';
}

// Render a history array (percentages) as a unicode sparkline.
export function sparkline(history) {
    if (!history || history.length < 2)
        return '';
    return history.map(p => {
        const i = Math.max(0, Math.min(8, Math.round((p / 100) * 8)));
        return SPARK_BLOCKS[i];
    }).join('');
}

// "Resets in 3h 06m" / "Resets in 4d 2h". nowMs is injectable for tests.
export function formatResets(iso, nowMs = Date.now()) {
    if (!iso)
        return '';
    const target = Date.parse(iso);
    if (Number.isNaN(target))
        return '';
    let delta = Math.floor((target - nowMs) / 1000);
    if (delta <= 0)
        return 'Resetting…';
    const d = Math.floor(delta / 86400);
    delta %= 86400;
    const h = Math.floor(delta / 3600);
    const m = Math.floor((delta % 3600) / 60);
    let span;
    if (d > 0)
        span = `${d}d ${h}h`;
    else if (h > 0)
        span = `${h}h ${String(m).padStart(2, '0')}m`;
    else
        span = `${m}m`;
    return `Resets in ${span}`;
}

// Threshold a limit crossed (0 / 90 / 100), for alert logic.
export function alertThreshold(percent) {
    return percent >= 100 ? 100 : (percent >= 90 ? 90 : 0);
}

// ── Burn-rate forecast ──────────────────────────────────────────────────────────
// From timestamped percent samples, project when a limit hits 100% at the
// current pace and whether that lands before its reset. Part of the shared
// cross-port contract (Model.swift / statusline.js / mcp/server.js mirror it;
// tests/fixtures/forecast.json pins the numbers).

const FORECAST_WINDOW_MS = 6 * 3600_000; // regress over the last 6 h only
const FORECAST_MIN_SAMPLES = 3;          // never extrapolate from 2 points
const FORECAST_MIN_SPAN_MS = 30 * 60_000; // …or from a burst narrower than 30 min
const FORECAST_MIN_PACE = 0.2;           // %/h below this is idle → no forecast

/**
 * @param {Array<[number, number]>} samples chronological [epochMs, percent]
 * @param {?string} resetsAt ISO reset time of the limit (null → no comparison)
 * @param {number} nowMs injectable clock
 * @returns {?{pctPerHour: number, projectedFullAt: string,
 *            exhaustsBeforeReset: boolean, marginHours: ?number}}
 *   pctPerHour is rounded to 2 decimals; projectedFullAt to the minute;
 *   marginHours (projectedFullAt − reset, 1 decimal) is negative when the limit
 *   runs out BEFORE the reset - that is the alarming case - and null without a
 *   reset to compare to. Returns null whenever an honest projection isn't
 *   possible: too few samples, idle pace, already at 100%.
 */
export function forecast(samples, resetsAt, nowMs) {
    if (!Array.isArray(samples) || !samples.length)
        return null;
    // A percent DROP means the window reset between samples - everything before
    // the drop belongs to the previous window and would poison the slope.
    let start = 0;
    for (let i = samples.length - 1; i > 0; i--) {
        if (samples[i - 1][1] > samples[i][1] + 1) {
            start = i;
            break;
        }
    }
    const win = samples.slice(start)
        .filter(([t]) => Number.isFinite(t) && t > nowMs - FORECAST_WINDOW_MS && t <= nowMs);
    if (win.length < FORECAST_MIN_SAMPLES)
        return null;
    const [t0] = win[0];
    const [tLast, pLast] = win[win.length - 1];
    if (tLast - t0 < FORECAST_MIN_SPAN_MS || pLast >= 100)
        return null;

    // Weighted least squares (weight = recency rank) so the current pace
    // dominates but one burst an hour ago doesn't predict doom all day.
    let sw = 0, swt = 0, swp = 0, swtt = 0, swtp = 0;
    win.forEach(([t, p], i) => {
        const w = i + 1;
        const th = (t - t0) / 3600_000; // hours since window start, keeps numbers small
        sw += w;
        swt += w * th;
        swp += w * p;
        swtt += w * th * th;
        swtp += w * th * p;
    });
    const denom = sw * swtt - swt * swt;
    if (denom === 0)
        return null;
    const slope = (sw * swtp - swt * swp) / denom; // %/h
    if (!Number.isFinite(slope) || slope < FORECAST_MIN_PACE)
        return null;

    const fullMs = tLast + ((100 - pLast) / slope) * 3600_000;
    const projected = Math.round(fullMs / 60_000) * 60_000; // minute precision
    const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
    const margin = Number.isFinite(resetMs)
        ? Math.round(((projected - resetMs) / 3600_000) * 10) / 10 : null;
    return {
        pctPerHour: Math.round(slope * 100) / 100,
        projectedFullAt: new Date(projected).toISOString(),
        exhaustsBeforeReset: margin !== null && margin < 0,
        marginHours: margin,
    };
}

// "↗ 1.8%/h - full ~Sun 03:40, 1d10h before reset" (alarming) or
// "↗ 0.6%/h - lasts past reset" (fine) or "" (no forecast). Weekday+time are
// local, matching the reset countdowns next to it.
export function formatForecast(fc) {
    if (!fc)
        return '';
    const pace = `↗ ${fc.pctPerHour}%/h`;
    if (!fc.exhaustsBeforeReset)
        return fc.marginHours === null ? pace : `${pace} - lasts past reset`;
    const d = new Date(fc.projectedFullAt);
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const lead = Math.abs(fc.marginHours);
    const dd = Math.floor(lead / 24);
    const hh = Math.round(lead % 24);
    const span = dd > 0 ? `${dd}d${hh}h` : `${hh}h`;
    return `${pace} - full ~${day} ${hm}, ${span} before reset`;
}

// History entries are stored as [t, p] pairs; entries written by versions that
// stored bare percents migrate as [0, p] - still good for the sparkline, and
// the forecast window (t > now − 6 h) naturally ignores them.
export function normalizeHistory(list) {
    if (!Array.isArray(list))
        return [];
    return list.map(e => Array.isArray(e) ? [Number(e[0]) || 0, clampPercent(e[1])]
        : [0, clampPercent(e)]);
}

// Percent series for the sparkline, from pair-form history.
export function historyPercents(pairs) {
    return (pairs ?? []).map(e => e[1]);
}

// Summarize Cursor /teams/spend rows into cycle spend, limit, %, top, members.
export function summarizeCursorSpend(rows) {
    let cycleCents = 0;
    let limitUSD = 0;
    let top = null;
    for (const r of rows ?? []) {
        const c = r.overallSpendCents ?? r.spendCents ?? 0;
        cycleCents += c;
        limitUSD += r.monthlyLimitDollars ?? 0;
        if (!top || c > top.cents)
            top = {email: r.email ?? r.name ?? '?', cents: c};
    }
    const cycleUSD = cycleCents / 100;
    return {
        cycleUSD,
        limitUSD,
        percent: limitUSD > 0 ? Math.min(100, Math.round((cycleUSD / limitUSD) * 100)) : null,
        topSpender: top ? {email: top.email, usd: top.cents / 100} : null,
        members: (rows ?? []).length,
    };
}

// Sum chargedCents across Cursor usage events → dollars.
export function summarizeCursorToday(events) {
    let cents = 0;
    for (const e of events ?? [])
        cents += e.chargedCents ?? 0;
    return cents / 100;
}

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
    // affordable to scan at all.
    const hasUsage = line.indexOf('"usage"') >= 0;
    if (!hasUsage && acc.sessionId && acc.cwd && acc.title)
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

/** Drop every day but the two the UI can show, so the on-disk index cannot grow
 *  without bound as sessions are resumed across weeks. */
export function pruneByDay(byDay, nowMs) {
    const keep = new Set([localDay(nowMs), localDay(nowMs - 86_400_000)]);
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
// `argv(dir, cmd)` returns the full argv - no shell involved on our side, the
// command string is handed to bash -lc by the terminal itself.
export const TERMINALS = [
    {bin: 'ghostty', argv: (d, c) => [`--working-directory=${d}`, '-e', 'bash', '-lc', c]},
    {bin: 'kitty', argv: (d, c) => ['--directory', d, 'bash', '-lc', c]},
    {bin: 'wezterm', argv: (d, c) => ['start', '--cwd', d, '--', 'bash', '-lc', c]},
    {bin: 'alacritty', argv: (d, c) => ['--working-directory', d, '-e', 'bash', '-lc', c]},
    {bin: 'foot', argv: (d, c) => ['-D', d, 'bash', '-lc', c]},
    {bin: 'gnome-terminal', argv: (d, c) => [`--working-directory=${d}`, '--', 'bash', '-lc', c]},
    {bin: 'konsole', argv: (d, c) => ['--workdir', d, '-e', 'bash', '-lc', c]},
    {bin: 'tilix', argv: (d, c) => ['-w', d, '-e', 'bash', '-lc', c]},
    {bin: 'xfce4-terminal', argv: (d, c) => [`--working-directory=${d}`, '-x', 'bash', '-lc', c]},
    {bin: 'x-terminal-emulator', argv: (d, c) => ['-e', 'bash', '-lc', `cd ${d} && ${c}`]},
    {bin: 'xterm', argv: (d, c) => ['-e', 'bash', '-lc', `cd ${d} && ${c}`]},
];

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
