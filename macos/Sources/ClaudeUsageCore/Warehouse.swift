import Foundation

// The forecast history is a rolling 6-hour window in a temp file - it answers
// "how fast right now" and is gone by tomorrow. This is the durable half: one
// JSONL line per poll that MOVED, kept for 90 days, so the panel can answer "is
// this week worse than last". Mirrors pure.js; tests/fixtures/warehouse.json
// pins both ports.

public struct WarehouseEntry: Equatable, Sendable {
    public let t: Double  // epoch ms
    public let limits: [String: Int]

    public init(t: Double, limits: [String: Int]) {
        self.t = t
        self.limits = limits
    }
}

public struct WeekOverWeek: Equatable, Sendable {
    public let thisWeekPeak: Int
    /// nil on a fresh install - one week of data is still worth showing.
    public let lastWeekPeak: Int?
    public let deltaPoints: Int?

    public init(thisWeekPeak: Int, lastWeekPeak: Int?, deltaPoints: Int?) {
        self.thisWeekPeak = thisWeekPeak
        self.lastWeekPeak = lastWeekPeak
        self.deltaPoints = deltaPoints
    }
}

public enum Warehouse {
    public static let keepDays = 90.0

    /// Same file the MCP server reads. macOS keeps it in Application Support;
    /// everything else follows XDG_STATE_HOME.
    public static func defaultURL(
        environment: [String: String] = ProcessInfo.processInfo.environment
    )
        -> URL
    {
        let home = FileManager.default.homeDirectoryForCurrentUser
        #if os(macOS)
            let base = home.appendingPathComponent("Library/Application Support")
        #else
            let base =
                environment["XDG_STATE_HOME"].map { URL(fileURLWithPath: $0) }
                ?? home.appendingPathComponent(".local/state")
        #endif
        return base.appendingPathComponent("claude-usage-panel/history.jsonl")
    }

    /// Load, dropping anything past the retention window. The pruned file is
    /// rewritten only when it actually shrank, so a normal start does no write.
    public static func load(url: URL = defaultURL(), nowMs: Double) -> [WarehouseEntry] {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        let entries = parse(text)
        let kept = prune(entries, nowMs: nowMs)
        if kept.count != entries.count {
            let rewritten = kept.map { entry -> String in
                let obj: [String: Any] = ["t": Int(entry.t.rounded()), "limits": entry.limits]
                let data =
                    (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
                return data.map { String(decoding: $0, as: UTF8.self) } ?? ""
            }
            try? (rewritten.joined(separator: "\n") + (kept.isEmpty ? "" : "\n"))
                .write(to: url, atomically: true, encoding: .utf8)
        }
        return kept
    }

    /// Append one poll. Best-effort: a failed write costs a data point, never a
    /// refresh.
    @discardableResult
    public static func append(_ cards: [LimitCard], nowMs: Double, url: URL = defaultURL()) -> Bool
    {
        let text = line(cards, nowMs: nowMs) + "\n"
        guard let data = text.data(using: .utf8) else { return false }
        let fm = FileManager.default
        try? fm.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !fm.fileExists(atPath: url.path) {
            return (try? data.write(to: url)) != nil
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return false }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }

    /// One line per poll: the instant, then each limit's percent by key.
    public static func line(_ cards: [LimitCard], nowMs: Double) -> String {
        let limits = Dictionary(cards.map { ($0.id, $0.percent) }, uniquingKeysWith: { a, _ in a })
        let obj: [String: Any] = ["t": Int(nowMs.rounded()), "limits": limits]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Unreadable lines are skipped, never fatal: two processes append to this
    /// file, so a torn last line is normal.
    public static func parse(_ text: String) -> [WarehouseEntry] {
        text.split(separator: "\n").compactMap { raw in
            guard let data = raw.data(using: .utf8),
                let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let t = (o["t"] as? NSNumber)?.doubleValue,
                let limits = o["limits"] as? [String: Any]
            else { return nil }
            var parsed: [String: Int] = [:]
            for (k, v) in limits {
                if let n = (v as? NSNumber)?.intValue { parsed[k] = n }
            }
            return WarehouseEntry(t: t, limits: parsed)
        }
    }

    /// Drop what is older than the retention window; the caller rewrites the
    /// file with what comes back.
    public static func prune(_ entries: [WarehouseEntry], nowMs: Double) -> [WarehouseEntry] {
        let cutoff = nowMs - keepDays * 86_400_000
        return entries.filter { $0.t >= cutoff }
    }

    /// Peak of one limit over the last 7 days against the 7 before that.
    public static func weekOverWeek(
        _ entries: [WarehouseEntry], key: String, nowMs: Double
    ) -> WeekOverWeek? {
        let week = 7.0 * 86_400_000
        var thisWeek: Int?
        var lastWeek: Int?
        for e in entries {
            guard let p = e.limits[key] else { continue }
            let age = nowMs - e.t
            guard age >= 0, age < 2 * week else { continue }
            if age < week {
                thisWeek = max(thisWeek ?? p, p)
            } else {
                lastWeek = max(lastWeek ?? p, p)
            }
        }
        guard let thisWeek else { return nil }
        return WeekOverWeek(
            thisWeekPeak: thisWeek, lastWeekPeak: lastWeek,
            deltaPoints: lastWeek.map { thisWeek - $0 })
    }

    /// "peak 71% this week · 84% last" - the comparison only when there is one.
    public static func format(_ w: WeekOverWeek?) -> String {
        guard let w else { return "" }
        guard let last = w.lastWeekPeak else { return "peak \(w.thisWeekPeak)% this week" }
        return "peak \(w.thisWeekPeak)% this week · \(last)% last"
    }
}
