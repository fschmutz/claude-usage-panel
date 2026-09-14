import Foundation

// A command the user asks to be run when a limit crosses 90/100 % or when a
// window rolls over. The panel already knows both moments; without a hook they
// are only ever a notification nobody can act on. Mirrors pure.js
// detectEvents() / expandEventCommand(); tests/fixtures/events.json pins both.

public struct UsageEvent: Equatable, Sendable {
    public enum Kind: String, Sendable { case threshold, reset }

    public let event: Kind
    public let key: String
    public let label: String
    public let percent: Int
    /// The threshold crossed (90 or 100); 0 for a reset.
    public let threshold: Int

    public init(event: Kind, key: String, label: String, percent: Int, threshold: Int) {
        self.event = event
        self.key = key
        self.label = label
        self.percent = percent
        self.threshold = threshold
    }
}

public enum EventHooks {
    /// The alert bucket a percentage falls in: 100, 90, or 0 (none).
    public static func alertThreshold(_ percent: Int) -> Int {
        percent >= 100 ? 100 : (percent >= 90 ? 90 : 0)
    }

    /// What changed between two polls. A reset is a percent DROP - the window
    /// rolled over; 1 point of slack, because the endpoint rounds and a
    /// one-point wobble downward is not a new window. A threshold is an upward
    /// crossing of 90 or 100, reporting only the higher one when both are
    /// cleared in a single poll.
    public static func detect(previous: [LimitCard], current: [LimitCard]) -> [UsageEvent] {
        let before = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var events: [UsageEvent] = []
        for card in current {
            guard let prev = before[card.id] else { continue }
            if card.percent < prev.percent - 1 {
                events.append(
                    UsageEvent(
                        event: .reset, key: card.id, label: card.label, percent: card.percent,
                        threshold: 0))
                continue
            }
            let crossed = alertThreshold(card.percent)
            if crossed > alertThreshold(prev.percent) {
                events.append(
                    UsageEvent(
                        event: .threshold, key: card.id, label: card.label,
                        percent: card.percent, threshold: crossed))
            }
        }
        return events
    }

    /// %e event  %k key  %l label  %p percent  %t threshold  %% literal %
    public static func expand(_ template: String, _ event: UsageEvent) -> String {
        guard !template.isEmpty else { return "" }
        let values: [Character: String] = [
            "e": event.event.rawValue, "k": event.key, "l": event.label,
            "p": String(event.percent), "t": String(event.threshold),
        ]
        var out = ""
        var chars = Array(template)
        var i = 0
        while i < chars.count {
            guard chars[i] == "%", i + 1 < chars.count else {
                out.append(chars[i])
                i += 1
                continue
            }
            let next = chars[i + 1]
            if next == "%" {
                out.append("%")
            } else if let value = values[next] {
                out += ShellQuote.quote(value)
            } else {
                out.append("%")
                out.append(next)
            }
            i += 2
        }
        return out
    }
}

// MARK: - Notification latch

/// Which limit crossings deserve a notification. `EventHooks.detect` reports
/// every upward crossing between two polls; a notification must fire ONCE per
/// window, so this latch remembers the highest bucket already announced for
/// each limit and re-arms only once usage has clearly dropped back (a fresh
/// window), not on a one-point wobble around the threshold.
public struct AlertLatch: Equatable, Sendable {
    /// Below this, a limit that had crossed 90 is considered back in a new window.
    public static let rearmBelow = 85

    private var fired: [String: Int] = [:]

    public init() {}

    /// The crossings to announce for this poll, in card order.
    public mutating func crossings(_ cards: [LimitCard]) -> [(card: LimitCard, threshold: Int)] {
        var out: [(card: LimitCard, threshold: Int)] = []
        for card in cards {
            let prev = fired[card.id] ?? 0
            let threshold = EventHooks.alertThreshold(card.percent)
            if threshold > prev {
                fired[card.id] = threshold
                out.append((card, threshold))
            } else if threshold < prev && card.percent < Self.rearmBelow {
                fired[card.id] = threshold
            }
        }
        return out
    }
}
