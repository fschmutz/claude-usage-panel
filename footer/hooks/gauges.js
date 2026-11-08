// What every footer gauge shows, through the shared contract rather than a
// copy of it: a limit becomes a card, the card a reading (usageReading: no
// number, or a window whose reset has passed, is `–` and an empty bar, never
// 0% or a stale percent), and the reading a tone (panelGauge: the severity,
// lifted to warning when the forecast runs dry before the reset).
//
// Plain JS on purpose: the footer's hooks import it, and so does the repo's
// node suite (tests/footer-gauges.test.js), which runs it against the same
// fixtures every other port answers to (reading.json, gauge.json).
//
// Severity: Claude Code hands a mod each window's percent and reset, not the
// endpoint's severity. A severity on the limit is used when there is one;
// without it the card takes usageSeverity's thresholds, the rule the status
// line applies to the same stdin numbers.

import {GAUGE_COLORS, clampPercent, panelGauge, usageReading} from './pure/usage.js';
import {usageSeverity} from './pure/accounts.js';
import {forecast, normalizeHistory} from './pure/pace.js';
import {warehouseAccount} from './pure/warehouse.js';

const SEVERITIES = ['normal', 'warning', 'critical'];
/** How far back samples are kept: the forecast reads the last 6 h. */
export const SAMPLE_TTL_MS = 6 * 3600_000;
/** Samples kept per limit. */
export const SAMPLE_MAX = 120;
/** A sample equal to the last one is still taken after this long. */
const SAMPLE_EVERY_MS = 5 * 60_000;

/**
 * A window as the engine hands it ({kind, percentUsed, resetsAt}) - or the
 * context ({kind: 'context', percentUsed}) - as a card, read by JSON type: a
 * percent that is not a finite number is no reading.
 */
export function limitCard(raw) {
    const p = raw?.percentUsed;
    const known = typeof p === 'number' && Number.isFinite(p);
    const percent = known ? clampPercent(p) : 0;
    return {
        key: String(raw?.kind ?? 'unknown'),
        percent,
        percentKnown: known,
        severity: SEVERITIES.includes(raw?.severity) ? raw.severity : (known ? usageSeverity(percent) : 'normal'),
        resetsAt: typeof raw?.resetsAt === 'string' ? raw.resetsAt : null,
    };
}

/**
 * What one gauge draws: the reading (`text`, `fill`), its tone and color,
 * and whether the forecast has it running dry before the reset. A gauge with
 * no honest reading has no forecast and no tone of its own.
 */
export function gauge(card, samples, nowMs) {
    const reading = usageReading(card, nowMs);
    const fc = reading.known && card.resetsAt ? forecast(samples ?? [], card.resetsAt, nowMs) : null;
    const runningDry = fc?.exhaustsBeforeReset === true;
    const {fraction, tone} = panelGauge(reading, card.severity, runningDry);
    return {...reading, fraction, tone, color: GAUGE_COLORS[tone], runningDry};
}

/** The samples key: one series per login and window, like the shared history file. */
export function sampleKey(account, kind) {
    return `${account ?? ''}|${kind}`;
}

/** The login key (warehouseAccount) of a ~/.claude.json text, or null. */
export function accountFromConfig(text) {
    try {
        return warehouseAccount(JSON.parse(text)?.oauthAccount ?? null);
    } catch {
        return null;
    }
}

/** @returns {Array<[number, number]>} */
function cleanSeries(list, nowMs) {
    return normalizeHistory(list).filter(([t]) => t > nowMs - SAMPLE_TTL_MS && t <= nowMs);
}

/**
 * The samples to store: what is stored now (another session may have written
 * since this one read) merged with this session's, per key, by time; junk
 * dropped, each series pruned to the forecast's window and SAMPLE_MAX.
 * @returns {Record<string, Array<[number, number]>>}
 */
export function mergeSamples(stored, mine, nowMs) {
    const out = {};
    const keys = new Set([
        ...Object.keys(stored && typeof stored === 'object' ? stored : {}),
        ...Object.keys(mine ?? {}),
    ]);
    for (const k of keys) {
        const byTime = new Map();
        for (const [t, p] of [...cleanSeries(stored?.[k], nowMs), ...cleanSeries(mine?.[k], nowMs)])
            byTime.set(t, p);
        const series = [...byTime].sort((a, b) => a[0] - b[0]).slice(-SAMPLE_MAX);
        if (series.length) out[k] = series;
    }
    return out;
}

/**
 * `series` with a sample for `percent` at `nowMs`, when it adds anything.
 * @returns {Array<[number, number]>}
 */
export function addSample(series, percent, nowMs) {
    const list = cleanSeries(series, nowMs);
    const last = list[list.length - 1];
    if (!last || last[1] !== clampPercent(percent) || nowMs - last[0] > SAMPLE_EVERY_MS)
        list.push([nowMs, clampPercent(percent)]);
    return list.slice(-SAMPLE_MAX);
}

/**
 * The toast latch ($.store 'fired'), as latchCrossings' Map; junk dropped.
 * @returns {Map<string, number>}
 */
export function latchFromStore(stored) {
    const fired = new Map();
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [k, v] of Object.entries(stored))
            if (typeof v === 'number' && Number.isFinite(v)) fired.set(k, v);
    }
    return fired;
}
