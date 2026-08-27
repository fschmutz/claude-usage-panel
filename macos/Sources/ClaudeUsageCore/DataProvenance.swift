import Foundation

// Where a number on screen came from. The distinction is the whole reason to
// trust this panel over the alternatives: the limit percentages are read from
// the account's own usage endpoint (`limits[]`), while every other Claude
// usage tool in circulation reconstructs cost by parsing local JSONL logs and
// multiplying by a price table it has to keep up to date.
//
// Those are different classes of number and they fail differently: an official
// figure can be stale or unreachable, an estimated one can be quietly wrong.
// Showing them identically is what makes a dashboard untrustworthy, so every
// value carries its provenance and the UIs render it.

public enum Provenance: String, Sendable, CaseIterable {
    /// Read from Anthropic's usage endpoint - the same numbers `/usage` shows.
    case official
    /// Derived locally (log parsing, price tables, burn-rate projection).
    case estimated

    /// Short badge text for a dense UI.
    public var badge: String {
        switch self {
        case .official: return "official"
        case .estimated: return "est."
        }
    }

    /// Tooltip / accessibility description.
    public var explanation: String {
        switch self {
        case .official:
            return "Read from your account's usage endpoint - the same numbers /usage shows."
        case .estimated:
            return "Derived locally from logs and a price table, not reported by Anthropic."
        }
    }
}

/// A value plus where it came from.
public struct Sourced<Value>: Sendable where Value: Sendable {
    public let value: Value
    public let provenance: Provenance

    public init(_ value: Value, _ provenance: Provenance) {
        self.value = value
        self.provenance = provenance
    }

    public var isOfficial: Bool { provenance == .official }
}

extension Sourced: Equatable where Value: Equatable {}

public enum Provenances {
    /// Plan limits, percentages, reset times: straight from the endpoint.
    public static let limits: Provenance = .official
    /// Session cost via ccusage: local logs times a price table.
    public static let cost: Provenance = .estimated
    /// Burn-rate projection: computed from observed history.
    public static let forecast: Provenance = .estimated
    /// Cursor team spend: read from Cursor's admin API, but it is spend, not a
    /// plan limit, and the panel does not control how Cursor aggregates it.
    public static let cursorSpend: Provenance = .official
}
