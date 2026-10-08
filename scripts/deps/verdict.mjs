// The freshness rule, pure. Two outcomes only: current, or DECLARED in
// .github/dependency-holds with a reason. Anything else fails, and so does a
// declaration that no longer matches anything (a hold that outlived its reason
// reads exactly like the drift it was meant to replace).
//
// One grace window, and it is Dependabot's own: every ecosystem in
// .github/dependabot.yml runs weekly with a 7-day cooldown, so a release can be
// up to 14 days old before Dependabot even proposes it. Inside that window an
// update is Dependabot's next PR, not staleness of this tree; past it, an open
// Dependabot PR for that version means it is in flight. tests/deps.test.js
// fails if dependabot.yml stops matching this number.
export const GRACE_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

/**
 * A release version as numbers, or null for a pre-release. `v7.0.1`,
 * `3.14.1-1` (a packaging revision: newer than 3.14.1, older than 3.14.2) and `0.11.0.1` read; `2.0.0-rc1`
 * and `6.4-noble` are not plain releases and give null (a Docker tag's variant
 * is stripped by the caller).
 */
export function versionParts(v) {
    const m = String(v).match(/^v?(\d+(?:\.\d+)*)(?:-(\d+))?$/);
    if (!m)
        return null;
    const parts = m[1].split('.').map(Number);
    return m[2] === undefined ? parts : [...parts, 0, Number(m[2])];
}

export function compareVersions(a, b) {
    const x = versionParts(a) ?? [];
    const y = versionParts(b) ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d)
            return Math.sign(d);
    }
    return 0;
}

/** The newest plain release among `versions`, inside `track` when given. */
export function newest(versions, track = null) {
    let best = null;
    for (const v of versions) {
        if (!versionParts(v))
            continue;
        if (track && v.replace(/^v/, '') !== track && !v.replace(/^v/, '').startsWith(`${track}.`))
            continue;
        if (best === null || compareVersions(v, best) > 0)
            best = v;
    }
    return best;
}

/**
 * The verdict for one pin. `upstream` is what the registry said:
 * {latest, publishedAt (ms|null), deprecated?, digest?, digestUpdatedAt?}, or
 * {error} when it would not answer - which is UNKNOWN, a failure, never clean.
 * Returns {level: 'pass'|'info'|'fail', msg, hold?}.
 */
export function verdict(pin, upstream, {hold = null, openPr = null, now = Date.now()} = {}) {
    const who = `${pin.kind} ${pin.name}`;
    if (upstream.error)
        return {level: 'fail', msg: `${who}: could not ask upstream (${upstream.error}) - freshness UNKNOWN, not clean`};
    const {latest} = upstream;
    if (!latest)
        return {level: 'fail', msg: `${who}: upstream lists no release - freshness UNKNOWN, not clean`};
    const cmp = compareVersions(pin.current, latest);
    if (cmp > 0) {
        if (upstream.deprecated)
            return {level: 'fail', msg: `${who} ${pin.current}: ahead of latest (${latest}) and DEPRECATED - move forward off it, never back`};
        return {level: 'info', msg: `${who} ${pin.current}: ahead of the latest tag (${latest}), still published`};
    }
    if (cmp === 0) {
        if (hold?.version)
            return {level: 'fail', hold, msg: `${who}: held at ${hold.version} but already current - delete the hold (dependency-holds:${hold.line})`};
        if (upstream.digest && pin.digest && upstream.digest !== pin.digest)
            return dueOrFresh(`${who}:${pin.current} digest moved upstream`, upstream.digestUpdatedAt, openPr, now);
        return {level: 'pass', hold, msg: `${who} ${pin.current}${hold?.track ? ` (newest ${hold.track}.x, tracked by dependency-holds:${hold.line})` : ''}`};
    }
    if (hold?.version) {
        if (hold.version === latest)
            return {level: 'info', hold, msg: `${who} ${pin.current} -> ${latest}: HELD (dependency-holds:${hold.line}): ${hold.reason}`};
        return {level: 'fail', hold, msg: `${who}: held at ${hold.version}, upstream is now ${latest} - retake the bump or restate the hold (dependency-holds:${hold.line})`};
    }
    return dueOrFresh(`${who} ${pin.current} -> ${latest}`, upstream.publishedAt, openPr, now, hold);
}

function dueOrFresh(what, publishedAt, openPr, now, hold = null) {
    if (openPr)
        return {level: 'info', hold, msg: `${what}: in flight, PR #${openPr}`};
    if (publishedAt && now - publishedAt < GRACE_DAYS * DAY_MS) {
        const days = Math.floor((now - publishedAt) / DAY_MS);
        return {level: 'info', hold, msg: `${what}: released ${days}d ago, inside Dependabot's ${GRACE_DAYS}-day window`};
    }
    return {level: 'fail', hold, msg: `${what}: stale - take the bump (or merge its Dependabot PR), or declare a hold with the reason`};
}

/**
 * Node: the engines floor must not be end-of-life, and every other CI
 * node-version must be the newest LTS line once it has been LTS for the grace
 * window. `lines` = [{major, ltsSince (ms|null), eol (ms|null)}].
 */
export function nodeVerdict(pin, lines, now = Date.now()) {
    const line = lines.find(l => String(l.major) === pin.current);
    if (pin.floor) {
        if (!line)
            return {level: 'fail', msg: `node ${pin.current} (engines floor): not a known release line`};
        if (line.eol && line.eol <= now)
            return {level: 'fail', msg: `node ${pin.current} (engines floor): end-of-life since ${new Date(line.eol).toISOString().slice(0, 10)} - raise engines.node and the CI matrix floor`};
        return {level: 'pass', msg: `node ${pin.current} (engines floor) still maintained`};
    }
    const lts = lines.filter(l => l.ltsSince && now - l.ltsSince >= GRACE_DAYS * DAY_MS)
        .sort((a, b) => b.major - a.major)[0];
    if (!lts)
        return {level: 'fail', msg: 'node: no LTS line found upstream - freshness UNKNOWN, not clean'};
    if (String(lts.major) === pin.current)
        return {level: 'pass', msg: `node ${pin.current} (${pin.file}) is the active LTS`};
    return {level: 'fail', msg: `node ${pin.current} (${pin.file}): the active LTS is ${lts.major} - move CI to it`};
}
