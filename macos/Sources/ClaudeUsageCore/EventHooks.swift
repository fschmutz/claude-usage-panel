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
    static func alertThreshold(_ percent: Int) -> Int {
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

    /// POSIX single-quoting - the label comes from the API, and a command built
    /// by pasting it in raw is a command the API gets to write.
    public static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
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
                out += shellQuote(value)
            } else {
                out.append("%")
                out.append(next)
            }
            i += 2
        }
        return out
    }
}
