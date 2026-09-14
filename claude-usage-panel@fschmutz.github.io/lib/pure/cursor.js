// Pure logic - no GJS/gi imports, so it is unit-testable under plain `node`.
// Re-exported by lib/pure.js; import from there.

// ── Cursor team spend (optional) ─────────────────────────────────────────────

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
