import ClaudeUsageCore
import Combine
import Foundation

/// Session pings as the UI sees them. The launchd agent plist is the source of
/// truth (shared with `./install.sh sessionping`), not UserDefaults: `reload()`
/// re-reads it before the Settings window shows, and every user edit rewrites
/// it - coalesced, because a DatePicker fires once per spinner tick and each
/// apply is a full bootout + bootstrap.
@MainActor
final class SessionPingSettings: ObservableObject {
    @Published var enabled: Bool {
        didSet { apply() }
    }
    @Published var times: [String] {
        didSet { apply() }
    }
    @Published var days: Set<Int> {
        didSet { apply() }
    }
    @Published var error: String?
    /// When a scheduled ping last opened a 5-hour window ("" when never).
    @Published var lastPing: String = ""

    /// Working day used to plan pings. Same @Published + UserDefaults idiom as
    /// every other persisted setting - @AppStorage does not publish from an
    /// ObservableObject.
    @Published var workDayStart: String {
        didSet { UserDefaults.standard.set(workDayStart, forKey: "workDayStart") }
    }
    @Published var workDayEnd: String {
        didSet { UserDefaults.standard.set(workDayEnd, forKey: "workDayEnd") }
    }

    /// `reload()` writes the plist back through the properties; only user
    /// edits (after init / reload) may rewrite it.
    private var ready = false
    private var applyTask: Task<Void, Never>?
    /// How long an edit must settle before the agent is rewritten. Long enough
    /// to swallow a spinner drag, short enough that closing Settings right
    /// after an edit still lands it.
    private static let applyDelayNs: UInt64 = 600_000_000

    init() {
        workDayStart = UserDefaults.standard.string(forKey: "workDayStart") ?? "09:00"
        workDayEnd = UserDefaults.standard.string(forKey: "workDayEnd") ?? "18:00"
        let sp = SessionPing.read()
        enabled = sp.enabled
        times = sp.schedule.times
        days = sp.schedule.days
        ready = true
    }

    /// Re-read the agent plist - the CLI installer edits the same file, so
    /// refresh before showing (and thus before any UI edit could rewrite the
    /// plist from a stale copy). Guarded so the read-back never applies.
    func reload() {
        applyTask?.cancel()
        ready = false
        let sp = SessionPing.read()
        enabled = sp.enabled
        times = sp.schedule.times
        days = sp.schedule.days
        ready = true
    }

    /// The most recent scheduled ping, for the dropdown and Settings.
    func refreshLastPing(now: Date = Date()) {
        lastPing = SessionPingStatus.formatLastPing(SessionStore.readLastPing(), now: now)
    }

    private func apply() {
        guard ready else { return }
        applyTask?.cancel()
        applyTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.applyDelayNs)
            guard !Task.isCancelled, let self else { return }
            self.error = SessionPing.apply(
                enabled: self.enabled,
                schedule: SessionPingSchedule(times: self.times, days: self.days))
        }
    }

    private var workDay: WorkDay {
        WorkDay(start: workDayStart, end: workDayEnd) ?? .default
    }

    /// Replace the schedule with the one that covers the working day best.
    func suggestTimes() {
        times = WindowPlanner.plan(day: workDay, pings: 2).pingTimes
    }

    /// The next scheduled ping, for the dropdown's ping line.
    var next: String {
        guard enabled else { return "" }
        return SessionPingStatus.nextPing(times: times, days: days, now: Date())
    }

    /// "56% of 09:00-18:00 covered" for the current schedule.
    var coverage: String {
        guard let p = WindowPlanner.evaluate(pingTimes: times, day: workDay) else {
            return "No valid ping times."
        }
        let best = WindowPlanner.plan(day: workDay, pings: 2)
        if p.coveragePercent >= best.coveragePercent { return p.summary }
        return p.summary + " · \(best.pingTimes.joined(separator: " ")) would cover "
            + "\(best.coveragePercent)%"
    }

    /// "last 05:30 · next 10:35" for the dropdown - what the schedule actually
    /// did, and what it will do next, rather than only what is configured.
    var statusLine: String {
        var parts = ["last \(lastPing.isEmpty ? "never" : lastPing)"]
        let next = next
        if !next.isEmpty { parts.append("next \(next)") }
        return parts.joined(separator: " · ")
    }
}
