import Foundation

// Where to put your session pings.
//
// Claude's 5-hour window is anchored to your first message, not to the clock,
// so a 09:00 start fits only two full windows into a 09:00-18:00 day and the
// second one runs out mid-afternoon. Pinging earlier re-anchors the windows so
// more of them land inside working hours. `install.sh sessionping` schedules
// the pings; this decides *when* they should fire, instead of making the user
// guess and re-guess.
//
// It does not raise your quota. It changes how the windows line up with the
// hours you actually work, which is the only lever the 5-hour rule leaves you.

public struct WorkDay: Equatable, Sendable {
    /// Minutes from midnight, local time.
    public let startMinute: Int
    public let endMinute: Int

    public init(startMinute: Int, endMinute: Int) {
        self.startMinute = startMinute
        self.endMinute = endMinute
    }

    public init?(start: String, end: String) {
        guard let s = WindowPlanner.minutes(from: start),
            let e = WindowPlanner.minutes(from: end), e > s
        else { return nil }
        self.startMinute = s
        self.endMinute = e
    }

    public static let `default` = WorkDay(startMinute: 9 * 60, endMinute: 18 * 60)
    public var lengthMinutes: Int { endMinute - startMinute }
}

public struct PlannedWindow: Equatable, Sendable {
    /// Minutes from midnight when the window opens (i.e. when the ping fires).
    public let openMinute: Int
    /// Minutes of this window that fall inside the working day.
    public let usefulMinutes: Int

    public var closeMinute: Int { openMinute + WindowPlanner.windowMinutes }
    public var openLabel: String { WindowPlanner.label(openMinute) }
    public var closeLabel: String { WindowPlanner.label(closeMinute) }
}

public struct WindowPlan: Equatable, Sendable {
    public let pingTimes: [String]
    public let windows: [PlannedWindow]
    /// Working minutes covered by at least one window.
    public let coveredMinutes: Int
    public let workDay: WorkDay

    /// 0...100 - how much of the working day sits inside a session window.
    public var coveragePercent: Int {
        guard workDay.lengthMinutes > 0 else { return 0 }
        return Int((Double(coveredMinutes) / Double(workDay.lengthMinutes) * 100).rounded())
    }

    /// One line for the UI: "05:30 10:30 · 100% of 09:00-18:00 covered".
    public var summary: String {
        "\(pingTimes.joined(separator: " ")) · \(coveragePercent)% of "
            + "\(WindowPlanner.label(workDay.startMinute))-"
            + "\(WindowPlanner.label(workDay.endMinute)) covered"
    }
}

public enum WindowPlanner {
    /// Claude's session window length.
    public static let windowMinutes = 5 * 60

    public static func minutes(from hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
            (0...23).contains(h), (0...59).contains(m)
        else { return nil }
        return h * 60 + m
    }

    public static func label(_ minute: Int) -> String {
        let m = ((minute % 1440) + 1440) % 1440
        return String(format: "%02d:%02d", m / 60, m % 60)
    }

    /// Plan `count` windows across `day`.
    ///
    /// Windows are laid back-to-back from the first ping, because a ping inside
    /// an already-open window is wasted - it does not extend anything, the
    /// window stays anchored to its own first message. So the only real choice
    /// is where the *first* one goes, and the rest follow at +5h.
    ///
    /// The first ping is placed so the last window's end lands as close as
    /// possible to the end of the working day without the chain starting so
    /// early that the first window is mostly burned before work begins.
    public static func plan(day: WorkDay = .default, pings count: Int = 2) -> WindowPlan {
        // More windows than the day can use is meaningless: the extra ones start
        // after the day is over (and used to wrap past midnight). Cap at the
        // number it takes to blanket the working day.
        let useful = max(1, Int((Double(day.lengthMinutes) / Double(windowMinutes)).rounded(.up)))
        let count = max(1, min(count, useful))
        let span = count * windowMinutes

        // Ideal: the chain ends exactly when the day ends. If the chain is
        // shorter than the day it cannot cover everything, so start at the
        // day's start and cover the front. Never schedule before 00:00.
        var first = span >= day.lengthMinutes ? day.endMinute - span : day.startMinute
        first = max(0, min(first, day.startMinute))

        var windows: [PlannedWindow] = []
        var covered = 0
        for i in 0..<count {
            let open = first + i * windowMinutes
            let close = open + windowMinutes
            let overlap = max(0, min(close, day.endMinute) - max(open, day.startMinute))
            covered += overlap
            windows.append(PlannedWindow(openMinute: open, usefulMinutes: overlap))
        }
        return WindowPlan(
            pingTimes: windows.map { label($0.openMinute) },
            windows: windows,
            coveredMinutes: min(covered, day.lengthMinutes),
            workDay: day
        )
    }

    /// Coverage of a schedule the user already has - so the UI can say
    /// "yours covers 71%, this would cover 100%".
    public static func evaluate(pingTimes: [String], day: WorkDay = .default) -> WindowPlan? {
        let opens = pingTimes.compactMap(minutes(from:)).sorted()
        guard !opens.isEmpty else { return nil }

        var windows: [PlannedWindow] = []
        // Union of the covered ranges - overlapping pings must not be counted
        // twice, which is exactly what a naive sum would do and would make a
        // bad schedule look better than a good one.
        var merged: [(Int, Int)] = []
        for open in opens {
            let close = open + windowMinutes
            let overlap = max(0, min(close, day.endMinute) - max(open, day.startMinute))
            windows.append(PlannedWindow(openMinute: open, usefulMinutes: overlap))
            let lo = max(open, day.startMinute)
            let hi = min(close, day.endMinute)
            guard hi > lo else { continue }
            if var last = merged.last, lo <= last.1 {
                last.1 = max(last.1, hi)
                merged[merged.count - 1] = last
            } else {
                merged.append((lo, hi))
            }
        }
        let covered = merged.reduce(0) { $0 + ($1.1 - $1.0) }
        return WindowPlan(
            pingTimes: opens.map(label),
            windows: windows,
            coveredMinutes: covered,
            workDay: day
        )
    }
}
