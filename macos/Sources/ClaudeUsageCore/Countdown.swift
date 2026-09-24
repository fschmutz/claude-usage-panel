import Foundation

// MARK: - Reset countdown

/// "Resets in 3h 05m" / "Resets in 4d 2h" / "Resetting…". Mirrors pure.js
/// `resetParts()` + `formatResets()`: whole seconds FLOORED (a reset 59 s
/// away is "0m", 23h59m40s is never "1d"), then the two most significant
/// units. The status line's compact "3h05m" (claude-code/stamps.js) splits
/// the same way; tests/fixtures/resets.json pins every port.
public enum ResetCountdown {
    public struct Parts: Equatable, Sendable {
        public let past: Bool
        public let d: Int
        public let h: Int
        public let m: Int
    }

    /// nil without a date; `past` once the reset is due.
    public static func parts(_ date: Date?, now: Date = Date()) -> Parts? {
        guard let date else { return nil }
        var delta = Int(date.timeIntervalSince(now).rounded(.down))
        if delta <= 0 { return Parts(past: true, d: 0, h: 0, m: 0) }
        let d = delta / 86400
        delta %= 86400
        return Parts(past: false, d: d, h: delta / 3600, m: (delta % 3600) / 60)
    }

    public static func text(_ date: Date?, now: Date = Date()) -> String {
        guard let r = parts(date, now: now) else { return "" }
        if r.past { return "Resetting…" }
        if r.d > 0 { return "Resets in \(r.d)d \(r.h)h" }
        if r.h > 0 { return String(format: "Resets in %dh %02dm", r.h, r.m) }
        return "Resets in \(r.m)m"
    }
}

// MARK: - Sparkline

/// The newest `samples` readings as block characters. Mirrors pure.js
/// `sparkline()` + `historyPercents()`; tests/fixtures/sparkline.json pins
/// both, half-step boundaries included (they round up in every port).
public enum Sparkline {
    public static let samples = 12
    static let blocks = Array(" ▁▂▃▄▅▆▇█")

    /// Percent series from pair-form [epochMs, percent] history; entries of
    /// any other shape are skipped.
    public static func percents(_ pairs: [[Double]]) -> [Double] {
        pairs.compactMap { $0.count == 2 ? $0[1] : nil }
    }

    public static func render(_ percents: [Double]) -> String {
        let tail = percents.suffix(samples)
        guard tail.count >= 2 else { return "" }
        return String(
            tail.map { p -> Character in
                // Clamp as a Double first: Int() traps on NaN and on overflow.
                let x = p.isFinite ? (p / 100 * 8 + 0.5).rounded(.down) : 0
                return blocks[Int(Swift.max(0, Swift.min(8, x)))]
            })
    }
}
