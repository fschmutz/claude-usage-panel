import Foundation

// Pure Cursor spend model + math - Foundation only, unit-testable on Linux.

public struct CursorTop: Equatable, Sendable {
    public let email: String
    public let usd: Double
    public init(email: String, usd: Double) {
        self.email = email
        self.usd = usd
    }
}

public struct CursorSummary: Equatable, Sendable {
    public let cycleUSD: Double
    public let limitUSD: Double
    public let percent: Int?  // % of monthly limit, when the team has one set
    public let members: Int
    public let todayUSD: Double?
    public let top: CursorTop?

    public init(
        cycleUSD: Double, limitUSD: Double, percent: Int?, members: Int,
        todayUSD: Double?, top: CursorTop?
    ) {
        self.cycleUSD = cycleUSD
        self.limitUSD = limitUSD
        self.percent = percent
        self.members = members
        self.todayUSD = todayUSD
        self.top = top
    }
}

public enum CursorMath {
    /// Summarize `/teams/spend` rows into cycle spend, limit, %, top, members.
    /// `todayUSD` is threaded in from the caller (usage-events sum).
    public static func summarizeSpend(_ rows: [[String: Any]], todayUSD: Double? = nil)
        -> CursorSummary
    {
        var cycleCents = 0.0
        var limitUSD = 0.0
        var top: CursorTop?
        for r in rows {
            let cents = centsValue(r["overallSpendCents"]) ?? centsValue(r["spendCents"]) ?? 0
            cycleCents += cents
            limitUSD += (r["monthlyLimitDollars"] as? NSNumber)?.doubleValue ?? 0
            if top == nil || cents / 100 > top!.usd {
                let who = (r["email"] as? String) ?? (r["name"] as? String) ?? "?"
                top = CursorTop(email: who, usd: cents / 100)
            }
        }
        let cycleUSD = cycleCents / 100
        return CursorSummary(
            cycleUSD: cycleUSD,
            limitUSD: limitUSD,
            percent: limitUSD > 0 ? min(100, Int((cycleUSD / limitUSD * 100).rounded())) : nil,
            members: rows.count,
            todayUSD: todayUSD,
            top: top)
    }

    /// Sum `chargedCents` across usage events → dollars.
    public static func summarizeToday(_ events: [[String: Any]]) -> Double {
        events.reduce(0.0) { $0 + (centsValue($1["chargedCents"]) ?? 0) } / 100
    }

    /// A cents field as the API sends it. Cursor's cents have been fractional
    /// since 2026-06-04 (`"chargedCents": 21.36232`), so they are read as
    /// Double: an Int read dropped up to 0.99c per row or event and moved both
    /// totals and the top spender away from the GNOME port on the same data.
    static func centsValue(_ raw: Any?) -> Double? {
        (raw as? NSNumber)?.doubleValue
    }
}
