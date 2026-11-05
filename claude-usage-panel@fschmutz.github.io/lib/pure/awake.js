// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.
//
// Awake: keep the machine from sleeping while Claude Code is working, for a
// timer, or both. Twin of ClaudeUsageCore/Awake.swift; pinned by
// tests/fixtures/awake.json. The platform half (pmset / sysfs / thermal
// parsing and every argv) is ./awake-power.js, the twin of AwakePower.swift.
//
// The safety design is adapted from Insomnia (https://github.com/krishhgg/Insomnia,
// MIT): a recovery journal written BEFORE every machine change, a backstop
// that undoes the journal with no app running, battery and thermal floors,
// a hard ceiling on one session, and a disable that is read back.
//
// Nothing here runs a command or touches a file. It decides: how long a
// session lasts, whether it is still held, which floor action is owed, what
// the backstop must undo, and the exact argv each platform needs.

import {isObject, num} from './json.js';

export const AWAKE_VERSION = 1;

/** Why a session is still being held. The end reasons and the thermal
 *  states are vocabulary only the fixture (and Swift's enums) spell out. */
export const AWAKE_HOLDS = Object.freeze(['timer', 'sessions']);

/** What the journal can own, and the order the backstop undoes it in: the
 *  sleep setting first (the one that keeps a closed laptop running), then the
 *  power mode that was switched on for it.
 *
 *  Only a PERSISTENT change belongs here. The idle/sleep assertion and the
 *  Linux lid inhibitor are child processes, so the kernel gives them back when
 *  the holder exits and there is nothing for a backstop to undo. */
export const AWAKE_JOURNAL_KEYS = Object.freeze(['sleepDisabled', 'lowPower']);

/** Shortest session worth taking: below a minute the release costs more than
 *  the hold. */
export const AWAKE_MIN_SECONDS = 60;

/** The hard ceiling on ONE session, whatever was asked for. A machine that
 *  cannot sleep is a machine cooking in a bag; it gets a deadline, always. */
export const AWAKE_MAX_SECONDS = 12 * 3600;

/** How long after a session's end the backstop waits before undoing the
 *  journal itself: enough for an orderly release, short enough that a crashed
 *  panel does not leave sleep off for the afternoon. */
export const AWAKE_BACKSTOP_GRACE_MS = 2 * 60_000;

/** How often the holder re-reads the sessions, the battery and the thermal
 *  state while it holds. */
export const AWAKE_POLL_SECONDS = 30;

/** Defaults every port starts from; `normalizeAwakeConfig` repairs the rest. */
export const AWAKE_DEFAULTS = Object.freeze({
    lowPowerFloor: 40,
    endFloor: 10,
    maxSeconds: AWAKE_MAX_SECONDS,
    thermalRules: true,
});

/** What a bare `awake on` (CLI or MCP) asks for when it names no duration and
 *  does not hold on sessions: a session with no end of its own is the one
 *  thing this feature must never create. */
export const AWAKE_DEFAULT_SECONDS = 3600;

const SECONDS = {s: 1, m: 60, h: 3600, d: 86400};
const NO_OWNER = Object.freeze({pid: 0, host: '', kind: ''});

/**
 * Seconds in a duration written the way a person writes one: `90m`, `2h`,
 * `1h30m`, `1d2h`, `45s`, or a bare number of minutes (`90`). Mixed units add
 * up and may repeat; whitespace and case are ignored.
 *
 * null for anything else, and for zero or less: `--for 0` is not a session,
 * it is a mistake the caller must notice rather than a one-second hold.
 */
export function parseAwakeDuration(text) {
    const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!s)
        return null;
    if (/^\d+$/.test(s)) {
        const minutes = Number(s);
        return minutes > 0 ? minutes * 60 : null;
    }
    // Every piece must be <number><unit>, with one trailing unitless piece
    // allowed so "2h30" reads as two and a half hours (the minutes of "2h").
    if (!/^(\d+[smhd])+\d*$/.test(s))
        return null;
    let total = 0;
    let lastUnit = null;
    for (const [, digits, unit] of s.matchAll(/(\d+)([smhd])?/g)) {
        if (digits === undefined)
            continue;
        if (unit) {
            total += Number(digits) * SECONDS[unit];
            lastUnit = unit;
            continue;
        }
        // "2h30": the bare tail is one unit finer than the last named one.
        const finer = lastUnit === 'd' ? 'h' : lastUnit === 'h' ? 'm' : 's';
        total += Number(digits) * SECONDS[finer];
    }
    return total > 0 ? total : null;
}

/**
 * Compact duration, two most significant units, whole seconds floored:
 * "2h 30m", "45m", "1d 2h", "30s", "0s". Zero secondary units are dropped.
 */
export function formatAwakeDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0)
        return h ? `${d}d ${h}h` : `${d}d`;
    if (h > 0)
        return m ? `${h}h ${m}m` : `${h}h`;
    if (m > 0)
        return s ? `${m}m ${s}s` : `${m}m`;
    return `${s}s`;
}

/**
 * The live countdown both panels draw, ticking in a stable shape so the top
 * bar does not jitter as units drop off: `H:MM:SS` from an hour up, `MM:SS`
 * below it, `Nd H:MM:SS` past a day. Partial seconds round UP, so a fresh
 * 30-minute session opens on 30:00 and only reads all-zeros at the deadline.
 */
export function awakeCountdown(remainingMs) {
    const total = Math.max(0, Math.ceil((Number(remainingMs) || 0) / 1000));
    const ss = String(total % 60).padStart(2, '0');
    const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
    const days = Math.floor(total / 86400);
    if (days > 0)
        return `${days}d ${Math.floor((total % 86400) / 3600)}:${mm}:${ss}`;
    const hours = Math.floor(total / 3600);
    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Clamp a requested duration into [AWAKE_MIN_SECONDS, maxSeconds]. */
export function clampAwakeDuration(seconds, maxSeconds = AWAKE_MAX_SECONDS) {
    const upper = Math.max(Number(maxSeconds) || 0, AWAKE_MIN_SECONDS);
    const want = Math.floor(Number(seconds) || 0);
    return Math.min(Math.max(want, AWAKE_MIN_SECONDS), upper);
}

/** A config with the floors in a usable order, whatever was stored.
 *  A hand-edited end floor at or above the low-power floor is corrected by
 *  RAISING the low-power floor, never by lowering the end: the end floor is
 *  the one that protects the machine. */
export function normalizeAwakeConfig(config = {}) {
    const int = (v, fallback) => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) ? n : fallback;
    };
    const endFloor = Math.min(100, Math.max(0, int(config.endFloor, AWAKE_DEFAULTS.endFloor)));
    let lowPowerFloor = Math.min(100, Math.max(0, int(config.lowPowerFloor, AWAKE_DEFAULTS.lowPowerFloor)));
    if (endFloor > 0 && lowPowerFloor <= endFloor)
        lowPowerFloor = Math.min(100, endFloor + 1);
    const maxSeconds = Math.min(AWAKE_MAX_SECONDS,
        Math.max(AWAKE_MIN_SECONDS, int(config.maxSeconds, AWAKE_DEFAULTS.maxSeconds)));
    return {
        lowPowerFloor,
        endFloor,
        maxSeconds,
        thermalRules: config.thermalRules !== false,
    };
}

/** The one reading of an `owner` block, for a session and a journal alike:
 *  {pid, host, kind} with a non-positive or non-integer pid read as 0 and a
 *  non-string field as ''. null when it is not an object at all. */
export function parseAwakeOwner(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    return {
        pid: Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : 0,
        host: typeof raw.host === 'string' ? raw.host : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
    };
}

/**
 * A fresh session. `seconds` null means "no timer of its own": it then runs
 * on the hard ceiling, so `endsAt` is always a real deadline and a session
 * can never outlive `maxSeconds`.
 *
 * @param {object} p
 * @param {number} p.nowMs
 * @param {number|null} [p.seconds]        requested duration, clamped
 * @param {boolean} [p.whileSessions]      hold while Claude Code is running
 * @param {boolean} [p.lid]                closed-lid mode (experimental)
 * @param {object} [p.owner]               {pid, host, kind}
 * @param {number} [p.maxSeconds]
 */
export function newAwakeSession({
    nowMs = 0, seconds = null, whileSessions = false, lid = false, owner = null,
    maxSeconds = AWAKE_MAX_SECONDS,
} = {}) {
    const cap = clampAwakeDuration(maxSeconds, maxSeconds);
    const timed = seconds !== null && seconds !== undefined;
    const length = timed ? clampAwakeDuration(seconds, cap) : cap;
    return {
        version: AWAKE_VERSION,
        startedAt: nowMs,
        endsAt: nowMs + length * 1000,
        timed,
        whileSessions: Boolean(whileSessions),
        lid: Boolean(lid),
        owner: parseAwakeOwner(owner),
    };
}

/** A session object, or null when a field is the wrong JSON type. A session
 *  with no deadline is not a session: it would be a hold nobody ends. */
export function parseAwakeSession(raw) {
    if (!isObject(raw))
        return null;
    const startedAt = num(raw.startedAt);
    const endsAt = num(raw.endsAt);
    if (startedAt === null || endsAt === null)
        return null;
    return {
        version: Number.isInteger(raw.version) ? raw.version : AWAKE_VERSION,
        startedAt,
        endsAt,
        timed: raw.timed !== false,
        whileSessions: raw.whileSessions === true,
        lid: raw.lid === true,
        owner: parseAwakeOwner(raw.owner),
    };
}

/** Milliseconds left on the timer, floored at zero. */
export function awakeRemainingMs(session, nowMs = 0) {
    const s = parseAwakeSession(session);
    if (!s)
        return 0;
    return Math.max(0, s.endsAt - nowMs);
}

/**
 * Push `endsAt` out by `extraSeconds`, never past `now + maxSeconds`: the
 * ceiling is on the session, not on one extension, so no chain of "+1h" can
 * walk a laptop through the night. Extending an expired session restarts the
 * countdown from now.
 */
export function extendAwakeSession(session, extraSeconds, nowMs = 0, maxSeconds = AWAKE_MAX_SECONDS) {
    const s = parseAwakeSession(session);
    if (!s)
        return null;
    const cap = clampAwakeDuration(maxSeconds, maxSeconds);
    const base = Math.max(s.endsAt, nowMs);
    const ceiling = nowMs + cap * 1000;
    return {
        ...s,
        timed: true,
        endsAt: Math.min(base + Math.max(0, Math.floor(Number(extraSeconds) || 0)) * 1000, ceiling),
    };
}

/**
 * Why the session is over, or null while something still holds it.
 *
 * The deadline wins over everything: past `endsAt` a session started with an
 * explicit duration ended on its `timer`, one that was only ever going to run
 * while Claude Code did ended on `max-session`. Before the deadline, a
 * `--while-sessions` session with no duration of its own ends the moment the
 * last session goes away.
 */
export function awakeEndReason(session, {nowMs = 0, sessions = 0} = {}) {
    const s = parseAwakeSession(session);
    if (!s)
        return 'user';
    if (nowMs >= s.endsAt)
        return s.timed ? 'timer' : 'max-session';
    if (s.whileSessions && !s.timed && sessions <= 0)
        return 'sessions';
    return null;
}

/** What is still holding the machine awake, strongest first. */
export function awakeHolds(session, {nowMs = 0, sessions = 0} = {}) {
    const s = parseAwakeSession(session);
    if (!s || nowMs >= s.endsAt)
        return [];
    const holds = [];
    if (s.timed)
        holds.push('timer');
    if (s.whileSessions && sessions > 0)
        holds.push('sessions');
    return holds;
}

/**
 * Everything a panel or `claudectl awake status` shows, from
 * the two files on disk plus the live session count. The single reader of all
 * the rules above, so no port re-derives one of them.
 *
 * @param {object} p
 * @param {object|null} p.session  session.json as read
 * @param {object|null} p.journal  journal.json as read
 * @param {number} p.sessions      live Claude Code sessions
 * @param {number} p.nowMs
 */
export function awakeState({session = null, journal = null, sessions = 0, nowMs = 0} = {}) {
    const s = parseAwakeSession(session);
    const holds = awakeHolds(s, {nowMs, sessions});
    const endReason = s ? awakeEndReason(s, {nowMs, sessions}) : null;
    const remainingMs = awakeRemainingMs(s, nowMs);
    const active = holds.length > 0;
    return {
        active,
        holds,
        timed: s?.timed ?? false,
        whileSessions: s?.whileSessions ?? false,
        lid: s?.lid ?? false,
        sessions,
        startedAt: s?.startedAt ?? null,
        endsAt: s?.endsAt ?? null,
        remainingMs: active ? remainingMs : 0,
        countdown: active && s?.timed ? awakeCountdown(remainingMs) : '',
        owner: s?.owner ?? null,
        endReason: active ? null : endReason,
        recovery: awakeRecoveryNotice(journal, nowMs),
    };
}

/** The whole state in one short word for a badge or a top-bar count: '' when
 *  nothing holds, the countdown for a timer, '∞' for a session-only hold. */
export function awakeBadge(state) {
    if (!state?.active)
        return '';
    return state.timed ? state.countdown : '\u221e';
}

// ── Floors ──────────────────────────────────────────────────────────────────
// Insomnia's section 6 decision table, as a pure function. A machine held
// awake on battery is the one case where this feature can do real harm, so
// the rules end the session rather than warn about it.

/** The strongest reason Low Power Mode should be on right now, or null:
 *  thermal, then battery, then the closed lid. */
export function awakeLowPowerCause({
    percent = null, charging = false, thermal = 'nominal', lidClosed = false, config = {},
} = {}) {
    const cfg = normalizeAwakeConfig(config);
    if (cfg.thermalRules && thermal === 'serious')
        return 'thermal';
    if (percent !== null && !charging && percent < cfg.lowPowerFloor)
        return 'battery';
    if (lidClosed)
        return 'lid';
    return null;
}

/**
 * The ordered actions the current readings call for.
 *
 *  - below `endFloor` on battery: end. An end floor of 0 turns that off.
 *  - thermal `critical`: end.
 *  - a battery that is PRESENT but unreadable twice in a row on battery, with
 *    an end floor set: end. A floor cannot be applied to a level nobody can
 *    read, and the machine may be minutes from dying. A desktop has no
 *    battery, so it has no floor and never ends here.
 *  - below `lowPowerFloor` on battery, thermal `serious`, or a closed lid:
 *    Low Power Mode on.
 *  - none of the above while WE switched it on: Low Power Mode off again.
 *
 * @returns {Array<{action: string, reason?: string, cause?: string}>}
 */
export function awakeFloorActions({
    percent = null, charging = false, hasBattery = false, unreadableMisses = 0,
    thermal = 'nominal', lidClosed = false, lowPowerSetByUs = false, config = {},
} = {}) {
    const cfg = normalizeAwakeConfig(config);
    const onBattery = !charging;
    if (percent !== null && onBattery && percent < cfg.endFloor)
        return [{action: 'end', reason: 'battery'}];
    if (cfg.thermalRules && thermal === 'critical')
        return [{action: 'end', reason: 'thermal'}];
    if (percent === null && hasBattery && onBattery && unreadableMisses >= 2 && cfg.endFloor > 0)
        return [{action: 'end', reason: 'battery-unreadable'}];
    const cause = awakeLowPowerCause({percent, charging, thermal, lidClosed, config: cfg});
    if (cause && !lowPowerSetByUs)
        return [{action: 'low-power-on', cause}];
    if (!cause && lowPowerSetByUs)
        return [{action: 'low-power-off'}];
    return [];
}

// ── Recovery journal ────────────────────────────────────────────────────────
// Written BEFORE every machine change and cleared only after the undo
// succeeded, so the backstop can put the machine back from the file alone -
// no panel, no CLI, no Swift.

/** A journal entry for what is about to be owned. */
export function awakeJournalEntry({
    nowMs = 0, endsAt = 0, owner = null, sleepDisabled = false, lowPower = false,
} = {}) {
    return {
        version: AWAKE_VERSION,
        at: nowMs,
        endsAt,
        owner: parseAwakeOwner(owner) ?? {...NO_OWNER},
        sleepDisabled: Boolean(sleepDisabled),
        lowPower: Boolean(lowPower),
    };
}

/** A journal object, or null when it is not one. An unreadable journal is
 *  NOT a clean one: the backstop must leave the machine alone and say so
 *  rather than assume there is nothing to undo. */
export function parseAwakeJournal(raw) {
    if (!isObject(raw))
        return null;
    for (const key of AWAKE_JOURNAL_KEYS) {
        if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
            return null;
    }
    return {
        version: Number.isInteger(raw.version) ? raw.version : AWAKE_VERSION,
        at: num(raw.at) ?? 0,
        endsAt: num(raw.endsAt) ?? 0,
        owner: parseAwakeOwner(raw.owner) ?? {...NO_OWNER},
        sleepDisabled: raw.sleepDisabled === true,
        lowPower: raw.lowPower === true,
    };
}

/** Does the journal still own anything the machine has to be given back? */
export function awakeJournalDirty(journal) {
    const j = parseAwakeJournal(journal);
    return Boolean(j) && AWAKE_JOURNAL_KEYS.some((k) => j[k]);
}

/** What the backstop has to undo, in the order it must undo it. */
export function awakeRecoverySteps(journal) {
    const j = parseAwakeJournal(journal);
    if (!j)
        return [];
    return AWAKE_JOURNAL_KEYS.filter((k) => j[k]);
}

/**
 * Whether the backstop may act yet: only once the session it was written for
 * has been over for `AWAKE_BACKSTOP_GRACE_MS`, or `force`. A journal whose
 * deadline is still in the future belongs to a live session and is left
 * alone - the backstop must never cut a session short.
 */
export function awakeBackstopDue(journal, nowMs = 0, {force = false} = {}) {
    if (!awakeJournalDirty(journal))
        return false;
    if (force)
        return true;
    const j = parseAwakeJournal(journal);
    return nowMs >= j.endsAt + AWAKE_BACKSTOP_GRACE_MS;
}

/**
 * The warning the dropdown and the menu show when a session is over and the
 * machine was not given back. Codes, not sentences: each port writes its own
 * words (the GNOME one through gettext).
 *
 * @returns {{codes: string[], endedAgoMs: number, endedAgo: string}|null}
 */
export function awakeRecoveryNotice(journal, nowMs = 0) {
    const steps = awakeRecoverySteps(journal);
    if (!steps.length)
        return null;
    const j = parseAwakeJournal(journal);
    if (nowMs < j.endsAt)
        return null;
    const endedAgoMs = Math.max(0, nowMs - j.endsAt);
    return {codes: steps, endedAgoMs, endedAgo: formatAwakeDuration(endedAgoMs / 1000)};
}

/**
 * The sentence a refused start is reported with, for every surface that can
 * start a hold (`claudectl awake on`, the MCP tool). `endHint` is how THAT
 * surface ends a running session - the only part the surfaces word apart.
 *
 * @param {{reason?: string, owner?: object, steps?: string[], log?: string}} result
 * @param {{endHint?: string}} [opts]
 */
export function awakeStartError(result, {endHint = ''} = {}) {
    switch (result?.reason) {
        case 'already-held':
            return `already awake, held by pid ${result.owner?.pid ?? '?'}${endHint ? ` - ${endHint}` : ''}`;
        case 'recovery-pending':
            return `a previous session left ${(result.steps ?? []).join(', ')} to give back`
                + ' - run `claudectl awake recover --force` first';
        case 'busy':
            return 'another Awake change holds the lock - nothing was started, try again in a moment';
        default:
            return `the holder did not start${result?.log ? `:\n${result.log}` : ''}`;
    }
}
