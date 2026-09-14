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

/// The two values the panels label.
public enum Provenances {
    /// Plan limits, percentages, reset times: straight from the endpoint.
    public static let limits: Provenance = .official
    /// Session cost via ccusage: local logs times a price table.
    public static let cost: Provenance = .estimated
}
