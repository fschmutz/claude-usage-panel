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
    /// The payload actually carried a number for this limit. False for the
    /// null placeholders the endpoint ships for kinds nobody has enabled -
    /// those are no reading at all, not a limit sitting at 0 % (UsageReading).
    public let percentKnown: Bool
    public let severity: Severity
    public var resetsAt: Date?
    public let active: Bool

    public init(
        id: String, label: String, percent: Int, severity: Severity,
        resetsAt: Date?, active: Bool, group: String = "", scoped: Bool = false,
        percentKnown: Bool = true
    ) {
        self.id = id
        self.label = label
        self.group = group
        self.scoped = scoped
        self.percent = percent
        self.percentKnown = percentKnown
        self.severity = severity
        self.resetsAt = resetsAt
        self.active = active
    }
}

/// What a card's percentage may honestly say right now. A percentage is only
/// worth printing while it still describes the window it is drawn under, and
/// two things end that: a payload that carried no number for the limit
/// (`percentKnown == false`), and a window whose reset instant has passed -
/// the endpoint keeps the old figure until the next window is opened, so for
/// the minutes in between the number on file belongs to a window that is gone.
/// Both give `–` and an empty bar rather than a stale percentage that looks
/// exactly like a fresh one. Mirrors `usageReading()` in lib/pure/usage.js
/// (GNOME + every Node client); tests/fixtures/reading.json pins both.
public struct UsageReading: Equatable, Sendable {
    public enum Reason: String, Sendable {
        case noReading = "no_reading"
        case windowReset = "window_reset"
    }

    public let known: Bool
    public let percent: Int?
    /// What a bar draws: 0 for an unknown reading, so the bar is empty rather
    /// than frozen at the last percentage.
    public let fill: Int
    public let text: String
    public let reason: Reason?

    /// What a bar shows in place of a percentage nobody can stand behind.
    public static let noReading = "–"

    public init(known: Bool, percent: Int?, fill: Int, text: String, reason: Reason?) {
        self.known = known
        self.percent = percent
        self.fill = fill
        self.text = text
        self.reason = reason
    }

    /// The window this card measures has already rolled over. Whole seconds
    /// floored, exactly like `ResetCountdown`, so a reading and its countdown
    /// never disagree by a rounding step.
    public static func windowRolledOver(_ resetsAt: Date?, now: Date) -> Bool {
        guard let resetsAt else { return false }
        return (resetsAt.timeIntervalSince(now)).rounded(.down) <= 0
    }

    public static func of(_ card: LimitCard, now: Date = Date()) -> UsageReading {
        let rolledOver = windowRolledOver(card.resetsAt, now: now)
        let known = card.percentKnown && !rolledOver
        let percent = known ? max(0, min(100, card.percent)) : nil
        return UsageReading(
            known: known, percent: percent, fill: percent ?? 0,
            text: percent.map { "\($0)%" } ?? noReading,
            reason: known ? nil : (rolledOver ? .windowReset : .noReading))
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

    /// A label for a kind we have no entry for - the endpoint keeps adding them
    /// (seven_day_cowork and friends already sit in the payload as null
    /// placeholders). Mirrors pure.js `kindLabel()`.
    public static func kindLabel(_ kind: String) -> String {
        if let known = kindLabels[kind] { return known }
        func words(_ w: Substring) -> String {
            w.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
        }
        if kind.hasPrefix("weekly_") { return "Weekly · \(words(kind.dropFirst(7)))" }
        if kind.hasPrefix("session_") { return "Session · \(words(kind.dropFirst(8)))" }
        let plain = words(Substring(kind))
        return plain.isEmpty ? "Limit" : plain
    }

    /// An ISO 8601 instant as the payload writes it, with or without
    /// fractional seconds. Public because the app layer parses the same shape
    /// out of files the endpoint never touched (a Codex transcript's stamp).
    public static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// A JSON number, read strictly: JSONSerialization hands `true` back as an
    /// NSNumber too, and `as? NSNumber` alone would read it as 1 %.
    static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, !Accounts.isJSONBool(n) else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
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
                var label = kindLabel(kind)
                let scope = entry["scope"] as? [String: Any]
                let model = (scope?["model"] as? [String: Any])?["display_name"] as? String
                if let model { label += " · \(model)" }
                // A limit the payload gave no number for is not a limit at 0 %.
                let raw = number(entry["percent"])
                let pct = clampPercent(raw ?? 0)
                let sev = Severity(rawValue: entry["severity"] as? String ?? "normal") ?? .normal
                return LimitCard(
                    id: kind + (model.map { ":\($0)" } ?? ""),
                    label: label, percent: pct, severity: sev,
                    resetsAt: parseDate(entry["resets_at"] as? String),
                    active: (entry["is_active"] as? Bool) ?? false,
                    group: groupOf(kind, entry["group"] as? String), scoped: model != nil,
                    percentKnown: raw != nil)
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
                let util = number(obj["utilization"])
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

// MARK: - Extra usage

/// Prepaid credits already charged this cycle. Not a `limits[]` entry - it has
/// no window and no reset - and reported only while the account has extra usage
/// switched on. Mirrors pure.js `normalizeExtraUsage()`;
/// tests/fixtures/extra-usage.json pins every port.
public struct ExtraUsage: Equatable, Sendable {
    public let percent: Int
    public let severity: Severity
    public let usedAmount: Double
    public let limitAmount: Double?
    public let currency: String
    /// "$12.40 of $50.00" - or just the used amount when there is no cap.
    public let detail: String

    public init(
        percent: Int, severity: Severity, usedAmount: Double, limitAmount: Double?,
        currency: String, detail: String
    ) {
        self.percent = percent
        self.severity = severity
        self.usedAmount = usedAmount
        self.limitAmount = limitAmount
        self.currency = currency
        self.detail = detail
    }

    public static func formatMoney(_ amount: Double, currency: String = "USD") -> String {
        let n = String(format: "%.2f", amount)
        return currency == "USD" ? "$\(n)" : "\(n) \(currency)"
    }

    static func money(_ obj: [String: Any]?) -> Double? {
        guard let minor = UsageNormalizer.number(obj?["amount_minor"]) else { return nil }
        let exp = UsageNormalizer.number(obj?["exponent"]) ?? 2
        return minor / pow(10, exp)
    }

    public static func normalize(_ payload: [String: Any]) -> ExtraUsage? {
        guard let spend = payload["spend"] as? [String: Any],
            (spend["enabled"] as? Bool) == true,
            let used = money(spend["used"] as? [String: Any])
        else { return nil }
        let limit = money(spend["limit"] as? [String: Any])
        let currency =
            (spend["used"] as? [String: Any])?["currency"] as? String
            ?? (spend["limit"] as? [String: Any])?["currency"] as? String ?? "USD"
        let usedText = formatMoney(used, currency: currency)
        let detail =
            limit.map { "\(usedText) of \(formatMoney($0, currency: currency))" } ?? usedText
        return ExtraUsage(
            percent: UsageNormalizer.clampPercent(
                UsageNormalizer.number(spend["percent"]) ?? 0),
            severity: Severity(rawValue: spend["severity"] as? String ?? "normal") ?? .normal,
            usedAmount: used, limitAmount: limit, currency: currency, detail: detail)
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

    /// Round half toward +infinity, as `floor(x + 0.5)` - the rule every port
    /// writes out. Swift's default `.rounded()` sends -0.5 away from zero, and
    /// a margin of whole minutes lands on an exact negative half-tenth one gap
    /// in six (3 min early is -0.05 h). Mirrors pure.js `roundHalfUp()`.
    public static func roundHalfUp(_ x: Double, decimals: Int = 0) -> Double {
        let k = pow(10, Double(decimals))
        return (x * k + 0.5).rounded(.down) / k
    }

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
            roundHalfUp((projectedMs - $0.timeIntervalSince1970 * 1000) / 3_600_000, decimals: 1)
        }
        return Forecast(
            pctPerHour: (slope * 100).rounded() / 100,
            projectedFullAt: projected,
            exhaustsBeforeReset: margin.map { $0 < 0 } ?? false,
            marginHours: margin)
    }

    /// How far ahead of the reset a limit runs out: "1d10h", "8h", "<1h". The
    /// lead is rounded to whole hours BEFORE the day split, so 47.6 h reads
    /// "2d0h", never "1d24h", and under half an hour it is "<1h", never "0h".
    /// Mirrors pure.js `forecastLead()`; forecast.json `leads` pins both.
    public static func lead(_ marginHours: Double) -> String {
        let total = roundHalfUp(abs(marginHours))
        guard total.isFinite, total >= 1 else { return "<1h" }
        let hours = Int(total)
        let dd = hours / 24
        let hh = hours % 24
        return dd > 0 ? "\(dd)d\(hh)h" : "\(hh)h"
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
        let span = lead(fc.marginHours ?? 0)
        return "\(pace) - full ~\(f.string(from: fc.projectedFullAt)), \(span) before reset"
    }
}

// MARK: - Top-bar readout

/// The one card a single-reading surface shows. Mirrors lib/pure/usage.js
/// `panelCard()` (GNOME + every Node client); tests/fixtures/reading.json
/// "panelCard" pins both.
public enum PanelCard {
    public enum Mode: String, Sendable {
        case worst, session
    }

    /// `.session` is the session card, else the first. `.worst` ranks on the
    /// honest reading, so a rolled-over window's stale figure never wins while
    /// another card has a reading. Ties go to the first card in the kind order,
    /// then to payload order - never to however `max(by:)` breaks them, which
    /// with every unknown card at fill 0 is a certain tie.
    public static func pick(_ cards: [LimitCard], mode: Mode = .worst, now: Date = Date())
        -> LimitCard?
    {
        guard let first = cards.first else { return nil }
        if mode == .session { return cards.first { $0.id.hasPrefix("session") } ?? first }
        let order = UsageNormalizer.kindOrder
        func rank(_ c: LimitCard) -> Int {
            order.firstIndex(of: c.id.components(separatedBy: ":")[0]) ?? order.count
        }
        let scored = cards.enumerated().map { index, card in
            let r = UsageReading.of(card, now: now)
            return (index: index, card: card, fill: r.fill, known: r.known)
        }
        let honest = scored.filter(\.known)
        let pool = honest.isEmpty ? scored : honest
        var best = pool[0]
        for s in pool.dropFirst() {
            if s.fill != best.fill {
                if s.fill > best.fill { best = s }
                continue
            }
            let r = rank(s.card) - rank(best.card)
            if r < 0 || (r == 0 && s.index < best.index) { best = s }
        }
        return best.card
    }
}

/// The menu-bar / top-bar text. Mirrors pure.js `panelText()`;
/// tests/fixtures/panel.json pins both ports (PanelTextParityTests).
public enum PanelReadout {
    /// The bar is shared real estate, so the readout has a hard character
    /// budget. What gives when it does not fit: the percentage never (it is the
    /// reading), the limit label second, the account name first - and the name
    /// is all-or-nothing, because half an identity ("PR…") reads as noise and
    /// the menu names the account in full anyway.
    public static let maxChars = 20

    /// Cut to `max` INCLUDING the ellipsis, "" when there is no room.
    public static func ellipsize(_ text: String, _ max: Int) -> String {
        let s = text.trimmingCharacters(in: .whitespaces)
        if s.count <= max { return s }
        guard max >= 3 else { return "" }
        return String(s.prefix(max - 1)) + "…"
    }

    /// "PRO · Fable 100%" - "" account means no prefix. `known: false` puts
    /// the en dash where the percentage would go, so the bar never carries a
    /// figure the popup is already refusing to show (UsageReading).
    public static func text(
        account: String = "", label: String, percent: Int, known: Bool = true,
        max: Int = maxChars
    ) -> String {
        let short =
            label.components(separatedBy: "·").last?.trimmingCharacters(in: .whitespaces) ?? label
        let pct =
            known ? "\(UsageNormalizer.clampPercent(Double(percent)))%" : UsageReading.noReading
        let name = account.trimmingCharacters(in: .whitespaces)
        // The limit reading is built at the full budget first; the name is
        // added only if it fits beside it, never by squeezing the label.
        let tail = "\(ellipsize(short, Swift.max(1, max - pct.count - 1))) \(pct)"
            .trimmingCharacters(in: .whitespaces)
        return !name.isEmpty && name.count + 3 + tail.count <= max ? "\(name) · \(tail)" : tail
    }
}

// MARK: - The top-bar gauge

/// What the top-bar / menu-bar gauge draws for the panel card: the arc's fill
/// (0...1, empty for no honest reading) and its tone. The tone is the card's
/// severity, lifted to warning while the forecast says the limit runs out
/// before its reset - trouble at 50%, not at 90%. The label shares the tone.
/// Mirrors lib/pure/usage.js `panelGauge`; pinned by tests/fixtures/gauge.json.
public struct PanelGauge: Equatable, Sendable {
    public enum Tone: String, Sendable {
        case normal, warning, critical
    }

    public let fraction: Double
    public let tone: Tone

    public static let colors: [Tone: String] = [
        .normal: "#3fb950", .warning: "#e0a458", .critical: "#e5484d",
    ]

    public static func of(
        known: Bool, percent: Int?, severity: Severity, exhaustsBeforeReset: Bool = false
    ) -> PanelGauge {
        guard known else { return PanelGauge(fraction: 0, tone: .normal) }
        var tone: Tone
        switch severity {
        case .critical: tone = .critical
        case .warning: tone = .warning
        case .normal: tone = .normal
        }
        if tone == .normal, exhaustsBeforeReset { tone = .warning }
        let pct = max(0, min(100, percent ?? 0))
        return PanelGauge(fraction: Double(pct) / 100, tone: tone)
    }

    public static func of(
        _ reading: UsageReading, severity: Severity, exhaustsBeforeReset: Bool = false
    ) -> PanelGauge {
        of(
            known: reading.known, percent: reading.percent, severity: severity,
            exhaustsBeforeReset: exhaustsBeforeReset)
    }
}
