import Foundation

// Session pings and today's Claude Code sessions. Mirrors the GNOME extension's
// lib/pure.js (parseStamp / formatLastPing / nextPing / foldSessionLine /
// rankSessions / resumeCommand) and is pinned to it by
// tests/fixtures/sessions.json - change one port, change them all.
//
// Foundation only: no networking, no SwiftUI, so it unit-tests on Linux CI. The
// file walking and the terminal launch live in the app target
// (ClaudeUsagePanel/Sessions.swift), the same split as UsageNormalizer.

// MARK: - Ping stamps

public enum SessionPingStatus {
    /// scripts/session-ping.sh writes `date '+%Y-%m-%dT%H:%M:%S%z'`, whose zone
    /// has no colon (+0200). ISO8601DateFormatter rejects that shape outright,
    /// so every port parses the stamp with the same explicit pattern instead.
    public static func parseStamp(_ text: String?) -> Date? {
        let raw = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pattern =
            #"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$"#
        guard let re = try? NSRegularExpression(pattern: pattern),
            let m = re.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw))
        else { return nil }

        func group(_ i: Int) -> String? {
            guard let r = Range(m.range(at: i), in: raw) else { return nil }
            return String(raw[r])
        }
        var comps = DateComponents()
        comps.year = Int(group(1) ?? "")
        comps.month = Int(group(2) ?? "")
        comps.day = Int(group(3) ?? "")
        comps.hour = Int(group(4) ?? "")
        comps.minute = Int(group(5) ?? "")
        comps.second = Int(group(6) ?? "")

        var calendar = Calendar(identifier: .gregorian)
        guard let zone = group(7) else {
            // No offset: local time, which is what `date` would have printed.
            calendar.timeZone = .current
            return calendar.date(from: comps)
        }
        // The wall clock read as UTC, then the offset applied as arithmetic,
        // like the JS ports. Never through TimeZone(secondsFromGMT:): it is
        // nil past +-18h, and the pattern lets "+99:00" from a hand-edited
        // line through - a force-unwrap there crashed every scan.
        calendar.timeZone = TimeZone(identifier: "UTC") ?? calendar.timeZone
        guard let utc = calendar.date(from: comps) else { return nil }
        if zone == "Z" { return utc }
        let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
        let hours = Int(digits.prefix(2)) ?? 0
        let minutes = Int(digits.suffix(2)) ?? 0
        let sign = zone.hasPrefix("-") ? -1 : 1
        return utc.addingTimeInterval(-Double(sign * (hours * 3600 + minutes * 60)))
    }

    /// Monday first, `date +%u` order - the one copy every UI reads.
    public static let dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    /// "05:30" today, "yesterday 05:30", "Fri 09:00" inside the week, else
    /// "2026-08-12 05:30". Empty when the stamp is missing or unreadable.
    public static func formatLastPing(_ text: String?, now: Date, zone: TimeZone = .current)
        -> String
    {
        guard let at = parseStamp(text) else { return "" }
        let clock = SessionFormat.clock(at, zone: zone)
        let day = SessionFormat.day(at, zone: zone)
        if day == SessionFormat.day(now, zone: zone) { return clock }
        if day == SessionFormat.day(SessionFormat.shiftDay(now, by: -1, zone: zone), zone: zone) {
            return "yesterday \(clock)"
        }
        if now.timeIntervalSince(at) < 6 * 86400 {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = zone
            let weekday = (cal.component(.weekday, from: at) + 5) % 7  // 0 = Monday
            return "\(dayNames[weekday]) \(clock)"
        }
        return "\(day) \(clock)"
    }

    /// The next scheduled ping: "10:35" later today, else "Mon 05:30".
    public static func nextPing(
        times: [String], days: Set<Int>, now: Date, zone: TimeZone = .current
    ) -> String {
        let minutes = times.compactMap(WindowPlanner.minutes(from:)).sorted()
        guard !minutes.isEmpty else { return "" }
        let wanted = days.isEmpty ? Set(1...7) : days
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let nowMinute = cal.component(.hour, from: now) * 60 + cal.component(.minute, from: now)
        for ahead in 0..<8 {
            let day = SessionFormat.shiftDay(now, by: ahead, zone: zone)
            let weekday = ((cal.component(.weekday, from: day) + 5) % 7) + 1  // 1 = Monday
            guard wanted.contains(weekday) else { continue }
            for minute in minutes {
                if ahead == 0 && minute <= nowMinute { continue }
                let hhmm = WindowPlanner.label(minute)
                return ahead == 0 ? hhmm : "\(dayNames[weekday - 1]) \(hhmm)"
            }
        }
        return ""
    }
}

public enum SessionFormat {
    /// Local calendar day as YYYY-MM-DD.
    public static func day(_ date: Date, zone: TimeZone = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Local noon of the calendar day `offset` days from the day of `date`.
    /// Days step on the calendar, never as 86400 s: across a 23 h or 25 h DST
    /// day a fixed step lands on the wrong date (Sat 23:30 + 24 h is Mon 00:30
    /// across spring-forward). Noon stays clear of every transition. Mirrors
    /// lib/pure.js shiftLocalDay.
    public static func shiftDay(_ date: Date, by offset: Int, zone: TimeZone = .current) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        var c = cal.dateComponents([.year, .month, .day], from: date)
        c.hour = 12
        let noon = cal.date(from: c) ?? date
        return cal.date(byAdding: .day, value: offset, to: noon) ?? noon
    }

    /// Local wall-clock HH:MM.
    public static func clock(_ date: Date, zone: TimeZone = .current) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let c = cal.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    /// 847 → "847", 16_700 → "16.7k", 1_240_000 → "1.2M".
    public static func compactTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1000 {
            let k = String(format: "%.1fk", Double(n) / 1000)
            return k == "1000.0k" ? "1.0M" : k
        }
        return String(n)
    }
}

// MARK: - Folding transcripts

/// One transcript's running totals. Rehydrated from the on-disk index, which is
/// shared with the other clients, so the field names match lib/pure.js exactly.
public struct SessionAcc: Codable, Equatable, Sendable {
    public var sessionId: String?
    public var cwd: String?
    public var title: String?
    public var lastMs: Double
    public var byDay: [String: Int]
    public var ids: [String]
    /// Bytes of the transcript already folded (files are append-only).
    public var offset: Int
    public var size: Int?
    public var mtimeMs: Double?

    public init(
        sessionId: String? = nil, cwd: String? = nil, title: String? = nil, lastMs: Double = 0,
        byDay: [String: Int] = [:], ids: [String] = [], offset: Int = 0,
        size: Int? = nil, mtimeMs: Double? = nil
    ) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.title = title
        self.lastMs = lastMs
        self.byDay = byDay
        self.ids = ids
        self.offset = offset
        self.size = size
        self.mtimeMs = mtimeMs
    }

    private enum CodingKeys: String, CodingKey {
        case sessionId, cwd, title, lastMs, byDay, ids, offset, size, mtimeMs
    }

    /// Tolerant: the index is written by every port, and the JS ones read a
    /// missing counter as 0 / empty. A synthesized decoder instead throws on
    /// any missing key, and one entry it cannot read makes the whole shared
    /// index "empty" - re-folded from byte 0, then overwritten for everyone.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        lastMs = try c.decodeIfPresent(Double.self, forKey: .lastMs) ?? 0
        byDay = try c.decodeIfPresent([String: Int].self, forKey: .byDay) ?? [:]
        ids = try c.decodeIfPresent([String].self, forKey: .ids) ?? []
        offset = try c.decodeIfPresent(Int.self, forKey: .offset) ?? 0
        size = try c.decodeIfPresent(Int.self, forKey: .size)
        mtimeMs = try c.decodeIfPresent(Double.self, forKey: .mtimeMs)
    }
}

/// Where Claude Code keeps the transcripts: <config dir>/projects, the config
/// dir being $CLAUDE_CONFIG_DIR when set and non-empty, else ~/.claude - the
/// same rule as the node ports (claude-code/paths.js) and GNOME
/// (lib/sessionIndex.js), pinned by tests/fixtures/sessions.json.
public enum SessionPaths {
    public static func projectsDir(environment: [String: String], home: String) -> String {
        let config = environment["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        let base = config ?? (home as NSString).appendingPathComponent(".claude")
        return (base as NSString).appendingPathComponent("projects")
    }
}

public struct RankedSession: Identifiable, Equatable, Sendable {
    public let sessionId: String
    public let cwd: String
    public let title: String?
    public let lastMs: Double
    public let tokens: Int
    public let label: String
    public let when: String

    public var id: String { sessionId }
}

public enum SessionIndexer {
    static let seenIdsMax = 32

    /// Tokens billed for one assistant turn. Cache READS are excluded: they bill
    /// at a fraction, and counting them at face value ranks every long session
    /// first - the opposite of "where did the spend go".
    public static func turnTokens(_ usage: [String: Any]?) -> Int {
        guard let usage else { return 0 }
        func int(_ key: String) -> Int { (usage[key] as? NSNumber)?.intValue ?? 0 }
        return int("input_tokens") + int("output_tokens") + int("cache_creation_input_tokens")
    }

    /// Fold ONE transcript line into an accumulator.
    public static func fold(
        line: String, into acc: inout SessionAcc, defaultDay: String, zone: TimeZone = .current
    ) {
        guard !line.isEmpty else { return }
        // Most lines of a long transcript carry no usage block. Once the header
        // fields are known, this substring probe skips parsing all of them -
        // that is what makes a 60 MB transcript affordable to scan at all.
        // A rename line is still parsed: the LAST custom title wins.
        let hasUsage = line.contains("\"usage\"")
        let hasTitle = line.contains("\"customTitle\"")
        if !hasUsage, !hasTitle, acc.sessionId != nil, acc.cwd != nil { return }
        guard let data = line.data(using: .utf8),
            let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if acc.sessionId == nil, let id = o["sessionId"] as? String { acc.sessionId = id }
        if acc.cwd == nil, let cwd = o["cwd"] as? String { acc.cwd = cwd }
        if let title = o["customTitle"] as? String, !title.isEmpty { acc.title = title }

        guard let message = o["message"] as? [String: Any],
            let usage = message["usage"] as? [String: Any]
        else { return }
        if let id = message["id"] as? String {
            if acc.ids.contains(id) { return }
            acc.ids.append(id)
            if acc.ids.count > seenIdsMax { acc.ids.removeFirst() }
        }
        let at = SessionPingStatus.parseStamp(o["timestamp"] as? String)
        if let at, at.timeIntervalSince1970 * 1000 > acc.lastMs {
            acc.lastMs = at.timeIntervalSince1970 * 1000
        }
        let day = at.map { SessionFormat.day($0, zone: zone) } ?? defaultDay
        acc.byDay[day, default: 0] += turnTokens(usage)
    }

    /// The mtime an index entry records: whole seconds, in ms. The entry is
    /// shared, and GIO stats whole seconds - an entry any port wrote must
    /// compare equal to this port's stat of the same file.
    public static func indexMtime(_ ms: Double) -> Double {
        (ms / 1000).rounded(.down) * 1000
    }

    /// A newline-less run this long is not a line (lib/sessionIndex.js
    /// CARRY_MAX, mcp/sessions.js): it is skipped, never re-read forever.
    public static let carryMax = 1 << 20

    /// How many bytes of a read window to consume: through its last newline
    /// (the tail may be a half-written line, read again next time), or the
    /// whole window when it holds no newline yet is already past what a line
    /// can be - otherwise the offset would stay before it on every pass.
    public static func consumable(_ window: Data) -> Int {
        if let cut = window.lastIndex(of: 0x0a) {
            return window.distance(from: window.startIndex, to: cut) + 1
        }
        return window.count >= carryMax ? window.count : 0
    }

    /// Keep only the days the UI can show, so the index cannot grow without
    /// bound as sessions are resumed across weeks.
    public static func pruneByDay(_ byDay: [String: Int], now: Date, zone: TimeZone = .current)
        -> [String: Int]
    {
        let keep: Set<String> = [
            SessionFormat.day(now, zone: zone),
            SessionFormat.day(SessionFormat.shiftDay(now, by: -1, zone: zone), zone: zone),
        ]
        return byDay.filter { keep.contains($0.key) }
    }

    /// Display name: the session's custom title, else its project directory.
    public static func title(_ acc: SessionAcc) -> String {
        if let title = acc.title, !title.isEmpty { return title }
        let trimmed = (acc.cwd ?? "").replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression)
        if let base = trimmed.split(separator: "/").last, !base.isEmpty { return String(base) }
        let id = acc.sessionId ?? ""
        return id.isEmpty ? "session" : String(id.prefix(8))
    }

    /// Today's sessions, biggest token spender first. A session with activity
    /// today but no billed turns still lists (it opened a window); one with
    /// neither is dropped.
    public static func rank(
        _ entries: [SessionAcc], now: Date, limit: Int = 5, zone: TimeZone = .current
    ) -> [RankedSession] {
        let today = SessionFormat.day(now, zone: zone)
        var ranked: [RankedSession] = []
        for acc in entries {
            guard let sessionId = acc.sessionId else { continue }
            let tokens = acc.byDay[today] ?? 0
            let lastDate = Date(timeIntervalSince1970: acc.lastMs / 1000)
            let activeToday = acc.lastMs > 0 && SessionFormat.day(lastDate, zone: zone) == today
            guard tokens > 0 || activeToday else { continue }
            ranked.append(
                RankedSession(
                    sessionId: sessionId,
                    cwd: acc.cwd ?? "",
                    title: acc.title,
                    lastMs: acc.lastMs,
                    tokens: tokens,
                    label: title(acc),
                    when: acc.lastMs > 0 ? SessionFormat.clock(lastDate, zone: zone) : ""))
        }
        ranked.sort { a, b in
            a.tokens != b.tokens ? a.tokens > b.tokens : a.lastMs > b.lastMs
        }
        return Array(ranked.prefix(max(0, limit)))
    }
}

// MARK: - Resuming one of them

public enum SessionResume {
    /// The command that resumes one session where it was left.
    public static func command(cwd: String, sessionId: String, claudeBin: String = "claude")
        -> String
    {
        let cd = cwd.isEmpty ? "" : "cd \(ShellQuote.quote(cwd)) && "
        return "\(cd)\(claudeBin) --resume \(ShellQuote.quote(sessionId))"
    }

    /// What a resume CLICK runs: the same thing, then an interactive shell, so
    /// the window does not vanish with whatever Claude Code printed last.
    public static func interactive(cwd: String, sessionId: String, claudeBin: String = "claude")
        -> String
    {
        "\(command(cwd: cwd, sessionId: sessionId, claudeBin: claudeBin)); exec \"$SHELL\" -i"
    }
}
