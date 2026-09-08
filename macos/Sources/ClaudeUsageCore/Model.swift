import Foundation

// Pure model + normalization - Foundation only (no networking, no SwiftUI),
// so it builds and unit-tests on any platform incl. Linux CI.
// Mirrors the GNOME extension's lib/pure.js.

public enum Severity: String, Sendable {
    case normal, warning, critical
}

public struct LimitCard: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    /// Pool this limit draws from: "session" or "weekly".
    public let group: String
    /// A per-model sub-cap of `group`'s pool (e.g. Fable), not a pool of its own.
    public let scoped: Bool
    public let percent: Int  // 0...100
    public let severity: Severity
    public var resetsAt: Date?
    public let active: Bool

    public init(
        id: String, label: String, percent: Int, severity: Severity,
        resetsAt: Date?, active: Bool, group: String = "", scoped: Bool = false
    ) {
        self.id = id
        self.label = label
        self.group = group
        self.scoped = scoped
        self.percent = percent
        self.severity = severity
        self.resetsAt = resetsAt
        self.active = active
    }
}

public enum UsageNormalizer {
    static let kindLabels: [String: String] = [
        "session": "Current session",
        "weekly_all": "Weekly · all models",
        "weekly_scoped": "Weekly",
        "weekly_oauth_apps": "Weekly · apps",
    ]
    static let kindOrder = ["session", "weekly_all", "weekly_scoped", "weekly_oauth_apps"]

    static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    static func clampPercent(_ v: Double) -> Int {
        max(0, min(100, Int(v.rounded())))
    }

    /// Which pool a limit draws from. The API sends `group` ("session" /
    /// "weekly"); payloads that predate it are grouped by the kind prefix.
    static func groupOf(_ kind: String, _ group: String?) -> String {
        if let group, !group.isEmpty { return group }
        return kind.hasPrefix("weekly") ? "weekly" : kind
    }

    /// A scoped (per-model) limit is a sub-cap ON its group's pooled limit, not a
    /// pool of its own: Fable usage counts toward `weekly_all` and shares its
    /// reset. The API leaves the scoped `resets_at` null until that model is used
    /// in the window, so borrow the pooled reset.
    static func inheritPooledResets(_ cards: [LimitCard]) -> [LimitCard] {
        var out = cards
        for i in out.indices where out[i].scoped && out[i].resetsAt == nil {
            if let pooled = out.first(where: {
                !$0.scoped && $0.group == out[i].group && $0.resetsAt != nil
            }) {
                out[i].resetsAt = pooled.resetsAt
            }
        }
        return out
    }

    /// Sub-line for a scoped (per-model) card: its percent is a *share* of the
    /// weekly pool (on Max, up to 50 % of the weekly allowance may go to Fable),
    /// never extra headroom - every Fable token also moves `weekly_all`.
    public static func poolNote(_ card: LimitCard) -> String {
        card.scoped && card.group == "weekly" ? "Share of the weekly all-models limit" : ""
    }

    /// Extract normalized cards from the raw payload. Prefers the modern
    /// `limits[]` array; falls back to legacy five_hour / seven_day fields.
    public static func normalize(_ payload: [String: Any]) -> [LimitCard] {
        if let limits = payload["limits"] as? [[String: Any]], !limits.isEmpty {
            let cards: [LimitCard] = limits.map { entry in
                let kind = entry["kind"] as? String ?? "unknown"
                var label = kindLabels[kind] ?? kind
                let scope = entry["scope"] as? [String: Any]
                let model = (scope?["model"] as? [String: Any])?["display_name"] as? String
                if let model { label += " · \(model)" }
                let pct = clampPercent((entry["percent"] as? NSNumber)?.doubleValue ?? 0)
                let sev = Severity(rawValue: entry["severity"] as? String ?? "normal") ?? .normal
                return LimitCard(
                    id: kind + (model.map { ":\($0)" } ?? ""),
                    label: label, percent: pct, severity: sev,
                    resetsAt: parseDate(entry["resets_at"] as? String),
                    active: (entry["is_active"] as? Bool) ?? false,
                    group: groupOf(kind, entry["group"] as? String), scoped: model != nil)
            }
            return inheritPooledResets(cards).sorted {
                let ai = kindOrder.firstIndex(of: $0.id.components(separatedBy: ":")[0]) ?? 99
                let bi = kindOrder.firstIndex(of: $1.id.components(separatedBy: ":")[0]) ?? 99
                return ai < bi
            }
        }

        var cards: [LimitCard] = []
        func legacy(
            _ payloadKey: String, id: String, _ label: String, group: String, active: Bool
        ) {
            guard let obj = payload[payloadKey] as? [String: Any],
                let util = (obj["utilization"] as? NSNumber)?.doubleValue
            else { return }
            cards.append(
                LimitCard(
                    id: id, label: label, percent: clampPercent(util), severity: .normal,
                    resetsAt: parseDate(obj["resets_at"] as? String), active: active,
                    group: group, scoped: false))
        }
        legacy("five_hour", id: "session", "Current session", group: "session", active: true)
        legacy("seven_day", id: "weekly_all", "Weekly · all models", group: "weekly", active: false)
        return cards
    }
}

// MARK: - Usage against the clock

/// Usage measured against the window it lives in. Mirrors pure.js
/// `clockPace()`; tests/fixtures/pace.json pins both ports (ClockPaceParityTests).
public struct ClockPace: Equatable, Sendable {
    /// How much of the window has gone, 0...100.
    public let elapsedPercent: Int
    /// percent − elapsed. Positive means the quota outruns its window.
    public let deltaPoints: Int
    public let state: State

    public enum State: String, Sendable { case ahead, even, behind }

    public init(elapsedPercent: Int, deltaPoints: Int, state: State) {
        self.elapsedPercent = elapsedPercent
        self.deltaPoints = deltaPoints
        self.state = state
    }
}

public enum UsageClock {
    /// The payload dates every reset but never says when the window opened, so
    /// the length comes from the group: 5 h session, 7 d weekly.
    public static let windowSeconds: [String: Double] = [
        "session": 5 * 3600, "weekly": 7 * 86400,
    ]
    /// Points of divergence below which used ≈ elapsed; under it a card would
    /// flicker between ahead and behind on rounding alone.
    public static let tolerance = 5

    public static func elapsedPercent(_ card: LimitCard, now: Date = Date()) -> Int? {
        guard let span = windowSeconds[card.group], let reset = card.resetsAt else { return nil }
        let ratio = 1 - (reset.timeIntervalSince(now) / span)
        return max(0, min(100, Int((ratio * 100).rounded())))
    }

    public static func pace(_ card: LimitCard, now: Date = Date()) -> ClockPace? {
        guard let elapsed = elapsedPercent(card, now: now) else { return nil }
        let delta = card.percent - elapsed
        let state: ClockPace.State =
            delta > tolerance ? .ahead : (delta < -tolerance ? .behind : .even)
        return ClockPace(elapsedPercent: elapsed, deltaPoints: delta, state: state)
    }

    /// "62% of the window gone - 18 pts ahead of the clock". Only the ahead case
    /// earns a sub-line; even and behind are the healthy states.
    public static func format(_ pace: ClockPace?) -> String {
        guard let pace, pace.state == .ahead else { return "" }
        return "\(pace.elapsedPercent)% of the window gone - "
            + "\(pace.deltaPoints) pts ahead of the clock"
    }
}

// MARK: - Burn-rate forecast

/// Projection of when a limit hits 100% at the current pace. Mirrors pure.js
/// `forecast()`; tests/fixtures/forecast.json pins both ports to the same
/// numbers (ForecastParityTests).
public struct Forecast: Equatable, Sendable {
    /// Percent consumed per hour, rounded to 2 decimals.
    public let pctPerHour: Double
    /// Instant the limit reaches 100% at this pace, minute precision.
    public let projectedFullAt: Date
    /// True when `projectedFullAt` lands BEFORE the limit's reset - the case
    /// worth warning about.
    public let exhaustsBeforeReset: Bool
    /// projectedFullAt − reset in hours (1 decimal): negative when the limit
    /// runs out early. Nil when the card has no reset to compare to.
    public let marginHours: Double?

    public init(
        pctPerHour: Double, projectedFullAt: Date,
        exhaustsBeforeReset: Bool, marginHours: Double?
    ) {
        self.pctPerHour = pctPerHour
        self.projectedFullAt = projectedFullAt
        self.exhaustsBeforeReset = exhaustsBeforeReset
        self.marginHours = marginHours
    }
}

public enum UsageForecast {
    static let windowMs: Double = 6 * 3_600_000  // regress over the last 6 h only
    static let minSamples = 3  // never extrapolate from 2 points
    static let minSpanMs: Double = 30 * 60_000  // …or from a burst narrower than 30 min
    static let minPace = 0.2  // %/h below this is idle → no forecast

    /// - Parameters:
    ///   - samples: chronological (epochMs, percent) pairs
    ///   - resetsAt: reset instant of the limit (nil → no comparison)
    ///   - nowMs: injectable clock, epoch milliseconds
    public static func forecast(samples: [(t: Double, p: Double)], resetsAt: Date?, nowMs: Double)
        -> Forecast?
    {
        guard !samples.isEmpty else { return nil }
        // A percent DROP means the window reset between samples - everything
        // before the drop belongs to the previous window.
        var start = 0
        var i = samples.count - 1
        while i > 0 {
            if samples[i - 1].p > samples[i].p + 1 {
                start = i
                break
            }
            i -= 1
        }
        let win = samples[start...].filter { $0.t > nowMs - windowMs && $0.t <= nowMs }
        guard win.count >= minSamples else { return nil }
        let t0 = win[0].t
        let last = win[win.count - 1]
        guard last.t - t0 >= minSpanMs, last.p < 100 else { return nil }

        // Weighted least squares (weight = recency rank) so the current pace
        // dominates but one burst an hour ago doesn't predict doom all day.
        var sw = 0.0
        var swt = 0.0
        var swp = 0.0
        var swtt = 0.0
        var swtp = 0.0
        for (idx, s) in win.enumerated() {
            let w = Double(idx + 1)
            let th = (s.t - t0) / 3_600_000  // hours since window start
            sw += w
            swt += w * th
            swp += w * s.p
            swtt += w * th * th
            swtp += w * th * s.p
        }
        let denom = sw * swtt - swt * swt
        guard denom != 0 else { return nil }
        let slope = (sw * swtp - swt * swp) / denom  // %/h
        guard slope.isFinite, slope >= minPace else { return nil }

        let fullMs = last.t + ((100 - last.p) / slope) * 3_600_000
        let projectedMs = (fullMs / 60_000).rounded() * 60_000  // minute precision
        let projected = Date(timeIntervalSince1970: projectedMs / 1000)
        let margin: Double? = resetsAt.map {
            (((projectedMs - $0.timeIntervalSince1970 * 1000) / 3_600_000) * 10).rounded() / 10
        }
        return Forecast(
            pctPerHour: (slope * 100).rounded() / 100,
            projectedFullAt: projected,
            exhaustsBeforeReset: margin.map { $0 < 0 } ?? false,
            marginHours: margin)
    }

    /// "↗ 1.8%/h - full ~Sun 03:40, 1d10h before reset" (alarming) or
    /// "↗ 0.6%/h - lasts past reset" (fine). Mirrors pure.js `formatForecast`.
    public static func format(_ fc: Forecast?) -> String {
        guard let fc else { return "" }
        let paceNum =
            fc.pctPerHour == fc.pctPerHour.rounded()
            ? String(Int(fc.pctPerHour)) : String(fc.pctPerHour)
        let pace = "↗ \(paceNum)%/h"
        guard fc.exhaustsBeforeReset else {
            return fc.marginHours == nil ? pace : "\(pace) - lasts past reset"
        }
        let f = DateFormatter()
        f.dateFormat = "EEE HH:mm"
        f.locale = Locale(identifier: "en_US_POSIX")
        let lead = abs(fc.marginHours ?? 0)
        let dd = Int(lead / 24)
        let hh = Int((lead.truncatingRemainder(dividingBy: 24)).rounded())
        let span = dd > 0 ? "\(dd)d\(hh)h" : "\(hh)h"
        return "\(pace) - full ~\(f.string(from: fc.projectedFullAt)), \(span) before reset"
    }
}
