import Foundation

// Awake: keep the Mac from sleeping while Claude Code is working, for a
// timer, or both. Mirrors the GNOME extension's lib/pure/awake.js;
// tests/fixtures/awake.json pins both.
//
// The safety design is adapted from Insomnia
// (https://github.com/krishhgg/Insomnia, MIT): a recovery journal written
// BEFORE every machine change, a backstop that undoes the journal with no app
// running, battery and thermal floors, a hard ceiling on one session, and a
// disable that is read back.
//
// Nothing here runs a command or touches a file. It decides: how long a
// session lasts, whether it is still held, which floor action is owed, what
// the backstop must undo, and the exact argv each platform needs.

/// Why a session is still being held.
public enum AwakeHold: String, Sendable, CaseIterable {
    case timer
    case sessions
}

/// Why a session is over. `user` is the only one the machine did not decide.
public enum AwakeEndReason: String, Sendable {
    case timer
    case sessions
    case maxSession = "max-session"
    case user
    case battery
    case batteryUnreadable = "battery-unreadable"
    case thermal
    case recovery
}

/// Thermal states, weakest first - the same four macOS reports.
public enum AwakeThermal: String, Sendable, CaseIterable {
    case nominal
    case fair
    case serious
    case critical
}

/// The strongest reason Low Power Mode should be on.
public enum AwakeLowPowerCause: String, Sendable {
    case thermal
    case battery
    case lid
}

/// One action the floors call for.
public enum AwakeFloorAction: Equatable, Sendable {
    case end(reason: AwakeEndReason)
    case lowPowerOn(cause: AwakeLowPowerCause)
    case lowPowerOff
}

public struct AwakeOwner: Equatable, Sendable {
    public let pid: Int
    public let host: String
    public let kind: String

    public init(pid: Int = 0, host: String = "", kind: String = "") {
        self.pid = pid
        self.host = host
        self.kind = kind
    }
}

/// One awake session: a deadline, plus what else holds it up.
public struct AwakeSession: Equatable, Sendable {
    public let version: Int
    public let startedAt: Double
    public let endsAt: Double
    /// Started with a duration of its own, as opposed to only ever running
    /// while Claude Code does.
    public let timed: Bool
    public let whileSessions: Bool
    public let lid: Bool
    public let owner: AwakeOwner?

    public init(
        version: Int = Awake.version, startedAt: Double, endsAt: Double, timed: Bool = true,
        whileSessions: Bool = false, lid: Bool = false, owner: AwakeOwner? = nil
    ) {
        self.version = version
        self.startedAt = startedAt
        self.endsAt = endsAt
        self.timed = timed
        self.whileSessions = whileSessions
        self.lid = lid
        self.owner = owner
    }
}

/// What the journal still owns, and therefore what has to be given back.
public struct AwakeJournal: Equatable, Sendable {
    public let version: Int
    public let at: Double
    public let endsAt: Double
    public let owner: AwakeOwner
    public let sleepDisabled: Bool
    public let lowPower: Bool

    public init(
        version: Int = Awake.version, at: Double = 0, endsAt: Double = 0,
        owner: AwakeOwner = AwakeOwner(), sleepDisabled: Bool = false, lowPower: Bool = false
    ) {
        self.version = version
        self.at = at
        self.endsAt = endsAt
        self.owner = owner
        self.sleepDisabled = sleepDisabled
        self.lowPower = lowPower
    }
}

/// The warning the menu shows when a session is over and the Mac was not
/// given back. Codes, not sentences: the UI writes its own words.
public struct AwakeRecoveryNotice: Equatable, Sendable {
    public let codes: [String]
    public let endedAgoMs: Double
    public let endedAgo: String
}

/// Everything the menu, the status line and `claudectl awake status` show.
public struct AwakeState: Equatable, Sendable {
    public let active: Bool
    public let holds: [AwakeHold]
    public let timed: Bool
    public let whileSessions: Bool
    public let lid: Bool
    public let sessions: Int
    public let startedAt: Double?
    public let endsAt: Double?
    public let remainingMs: Double
    public let countdown: String
    public let owner: AwakeOwner?
    public let endReason: AwakeEndReason?
    public let recovery: AwakeRecoveryNotice?
}

/// The battery and thermal floors, plus the session ceiling.
public struct AwakeConfig: Equatable, Sendable {
    public let lowPowerFloor: Int
    public let endFloor: Int
    public let maxSeconds: Int
    public let thermalRules: Bool

    public init(
        lowPowerFloor: Int = 40, endFloor: Int = 10, maxSeconds: Int = Awake.maxSeconds,
        thermalRules: Bool = true
    ) {
        self.lowPowerFloor = lowPowerFloor
        self.endFloor = endFloor
        self.maxSeconds = maxSeconds
        self.thermalRules = thermalRules
    }
}

/// What a battery read came back with. `hasBattery` false is a desktop: no
/// floor applies. `percent` nil WITH a battery is a read that failed, which
/// is a very different thing.
public struct AwakeBattery: Equatable, Sendable {
    public let percent: Int?
    public let charging: Bool
    public let hasBattery: Bool

    public init(percent: Int?, charging: Bool, hasBattery: Bool) {
        self.percent = percent
        self.charging = charging
        self.hasBattery = hasBattery
    }
}

public enum Awake {
    public static let version = 1
    public static let holds = ["timer", "sessions"]
    public static let endReasons = [
        "timer", "sessions", "max-session", "user", "battery", "battery-unreadable", "thermal",
        "recovery",
    ]
    /// What the journal can own, and the order the backstop undoes it in.
    /// Only a PERSISTENT change belongs here: the idle/sleep assertion is a
    /// child process the kernel gives back when the holder exits.
    public static let journalKeys = ["sleepDisabled", "lowPower"]
    public static let thermalStates = ["nominal", "fair", "serious", "critical"]

    /// Shortest session worth taking.
    public static let minSeconds = 60
    /// The hard ceiling on ONE session, whatever was asked for.
    public static let maxSeconds = 12 * 3600
    /// How long after a session's end the backstop waits before undoing the
    /// journal itself.
    public static let backstopGraceMs: Double = 120_000
    /// How often the holder re-reads the sessions, battery and thermal state.
    public static let pollSeconds = 30

    public static let defaults = AwakeConfig()

    /// The ONLY four commands the lid mode ever runs as root, and the only
    /// ones the sudoers rule grants.
    public static let sudoCommands: [[String]] = [
        ["/usr/bin/pmset", "-a", "disablesleep", "1"],
        ["/usr/bin/pmset", "-a", "disablesleep", "0"],
        ["/usr/bin/pmset", "-b", "lowpowermode", "1"],
        ["/usr/bin/pmset", "-b", "lowpowermode", "0"],
    ]

    private static let unitSeconds: [Character: Int] = ["s": 1, "m": 60, "h": 3600, "d": 86400]

    // MARK: Durations

    /// Seconds in a duration written the way a person writes one: `90m`,
    /// `2h`, `1h30m`, `1d2h`, `45s`, or a bare number of minutes (`90`).
    /// nil for anything else, and for zero or less.
    public static func parseDuration(_ text: String?) -> Int? {
        let s = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        if s.isEmpty { return nil }
        if matches(s, #"^\d+$"#) {
            guard let minutes = Int(s), minutes > 0 else { return nil }
            return minutes * 60
        }
        guard matches(s, #"^(\d+[smhd])+\d*$"#) else { return nil }
        var total = 0
        var lastUnit: Character?
        var digits = ""
        for ch in s {
            if ch.isNumber {
                digits.append(ch)
                continue
            }
            total += (Int(digits) ?? 0) * (unitSeconds[ch] ?? 0)
            lastUnit = ch
            digits = ""
        }
        if !digits.isEmpty {
            // "2h30": the bare tail is one unit finer than the last named one.
            let finer: Character = lastUnit == "d" ? "h" : (lastUnit == "h" ? "m" : "s")
            total += (Int(digits) ?? 0) * (unitSeconds[finer] ?? 1)
        }
        return total > 0 ? total : nil
    }

    /// Compact duration, two most significant units, whole seconds floored.
    public static func formatDuration(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let d = total / 86400
        let h = (total % 86400) / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if d > 0 { return h > 0 ? "\(d)d \(h)h" : "\(d)d" }
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return s > 0 ? "\(m)m \(s)s" : "\(m)m" }
        return "\(s)s"
    }

    /// The live countdown, in a stable shape so the menu bar does not jitter
    /// as units drop off. Partial seconds round UP.
    public static func countdown(remainingMs: Double) -> String {
        let total = max(0, Int((remainingMs / 1000).rounded(.up)))
        let ss = String(format: "%02d", total % 60)
        let mm = String(format: "%02d", (total / 60) % 60)
        let days = total / 86400
        if days > 0 { return "\(days)d \((total % 86400) / 3600):\(mm):\(ss)" }
        let hours = total / 3600
        return hours > 0 ? "\(hours):\(mm):\(ss)" : "\(mm):\(ss)"
    }

    /// Clamp a requested duration into [minSeconds, maxSeconds].
    public static func clampDuration(_ seconds: Int, maxSeconds: Int = Awake.maxSeconds) -> Int {
        let upper = max(maxSeconds, minSeconds)
        return min(max(seconds, minSeconds), upper)
    }

    /// A config with the floors in a usable order. An end floor at or above
    /// the low-power floor is repaired by RAISING the low-power one: the end
    /// floor is the one that protects the machine.
    public static func normalizeConfig(_ config: AwakeConfig) -> AwakeConfig {
        let endFloor = min(100, max(0, config.endFloor))
        var lowPowerFloor = min(100, max(0, config.lowPowerFloor))
        if endFloor > 0, lowPowerFloor <= endFloor { lowPowerFloor = min(100, endFloor + 1) }
        return AwakeConfig(
            lowPowerFloor: lowPowerFloor, endFloor: endFloor,
            maxSeconds: min(maxSeconds, max(minSeconds, config.maxSeconds)),
            thermalRules: config.thermalRules)
    }

    // MARK: Sessions

    /// A fresh session. `seconds` nil means "no timer of its own": it then
    /// runs on the hard ceiling, so `endsAt` is always a real deadline.
    public static func newSession(
        nowMs: Double, seconds: Int? = nil, whileSessions: Bool = false, lid: Bool = false,
        owner: AwakeOwner? = nil, maxSeconds: Int = Awake.maxSeconds
    ) -> AwakeSession {
        let cap = clampDuration(maxSeconds, maxSeconds: maxSeconds)
        let length = seconds.map { clampDuration($0, maxSeconds: cap) } ?? cap
        return AwakeSession(
            startedAt: nowMs, endsAt: nowMs + Double(length) * 1000, timed: seconds != nil,
            whileSessions: whileSessions, lid: lid, owner: owner)
    }

    /// A session object, or nil when a field is the wrong JSON type. A
    /// session with no deadline is not a session: it would be a hold nobody
    /// ends.
    public static func parseSession(_ raw: Any?) -> AwakeSession? {
        guard let obj = raw as? [String: Any] else { return nil }
        guard let startedAt = finite(obj["startedAt"]), let endsAt = finite(obj["endsAt"])
        else { return nil }
        return AwakeSession(
            version: intOr(obj["version"], version),
            startedAt: startedAt,
            endsAt: endsAt,
            timed: (obj["timed"] as? Bool) ?? true,
            whileSessions: (obj["whileSessions"] as? Bool) == true,
            lid: (obj["lid"] as? Bool) == true,
            owner: parseOwner(obj["owner"]))
    }

    /// Milliseconds left on the timer, floored at zero.
    public static func remainingMs(_ session: AwakeSession?, nowMs: Double) -> Double {
        guard let session else { return 0 }
        return max(0, session.endsAt - nowMs)
    }

    /// Push `endsAt` out by `extraSeconds`, never past `now + maxSeconds`:
    /// the ceiling is on the session, not on one extension. Extending an
    /// expired session restarts the countdown from now.
    public static func extend(
        _ session: AwakeSession?, by extraSeconds: Int, nowMs: Double,
        maxSeconds: Int = Awake.maxSeconds
    ) -> AwakeSession? {
        guard let session else { return nil }
        let cap = clampDuration(maxSeconds, maxSeconds: maxSeconds)
        let base = max(session.endsAt, nowMs)
        let ceiling = nowMs + Double(cap) * 1000
        return AwakeSession(
            version: session.version, startedAt: session.startedAt,
            endsAt: min(base + Double(max(0, extraSeconds)) * 1000, ceiling), timed: true,
            whileSessions: session.whileSessions, lid: session.lid, owner: session.owner)
    }

    /// Why the session is over, or nil while something still holds it. The
    /// deadline wins over everything.
    public static func endReason(
        _ session: AwakeSession?, nowMs: Double, sessions: Int = 0
    ) -> AwakeEndReason? {
        guard let session else { return .user }
        if nowMs >= session.endsAt { return session.timed ? .timer : .maxSession }
        if session.whileSessions, !session.timed, sessions <= 0 { return .sessions }
        return nil
    }

    /// What is still holding the Mac awake, strongest first.
    public static func holds(
        _ session: AwakeSession?, nowMs: Double, sessions: Int = 0
    ) -> [AwakeHold] {
        guard let session, nowMs < session.endsAt else { return [] }
        var out: [AwakeHold] = []
        if session.timed { out.append(.timer) }
        if session.whileSessions, sessions > 0 { out.append(.sessions) }
        return out
    }

    /// The single reader of all the rules above, so no view re-derives one.
    public static func state(
        session: AwakeSession?, journal: AwakeJournal? = nil, sessions: Int = 0, nowMs: Double
    ) -> AwakeState {
        let held = holds(session, nowMs: nowMs, sessions: sessions)
        let reason = session.flatMap { endReason($0, nowMs: nowMs, sessions: sessions) }
        let left = remainingMs(session, nowMs: nowMs)
        let active = !held.isEmpty
        return AwakeState(
            active: active,
            holds: held,
            timed: session?.timed ?? false,
            whileSessions: session?.whileSessions ?? false,
            lid: session?.lid ?? false,
            sessions: sessions,
            startedAt: session?.startedAt,
            endsAt: session?.endsAt,
            remainingMs: active ? left : 0,
            countdown: active && session?.timed == true ? countdown(remainingMs: left) : "",
            owner: session?.owner,
            endReason: active ? nil : reason,
            recovery: recoveryNotice(journal, nowMs: nowMs))
    }

    /// The whole state in one short word for the menu bar: "" when nothing
    /// holds, the countdown for a timer, "∞" for a session-only hold.
    public static func badge(_ state: AwakeState) -> String {
        guard state.active else { return "" }
        return state.timed ? state.countdown : "\u{221e}"
    }

    // MARK: Floors

    /// The strongest reason Low Power Mode should be on right now, or nil:
    /// thermal, then battery, then the closed lid.
    public static func lowPowerCause(
        percent: Int?, charging: Bool, thermal: AwakeThermal = .nominal, lidClosed: Bool = false,
        config: AwakeConfig = Awake.defaults
    ) -> AwakeLowPowerCause? {
        let cfg = normalizeConfig(config)
        if cfg.thermalRules, thermal == .serious { return .thermal }
        if let percent, !charging, percent < cfg.lowPowerFloor { return .battery }
        if lidClosed { return .lid }
        return nil
    }

    /// The ordered actions the current readings call for. A machine held
    /// awake on battery is the one case where this feature can do real harm,
    /// so the rules end the session rather than warn about it.
    public static func floorActions(
        battery: AwakeBattery, unreadableMisses: Int = 0, thermal: AwakeThermal = .nominal,
        lidClosed: Bool = false, lowPowerSetByUs: Bool = false,
        config: AwakeConfig = Awake.defaults
    ) -> [AwakeFloorAction] {
        let cfg = normalizeConfig(config)
        let onBattery = !battery.charging
        if let percent = battery.percent, onBattery, percent < cfg.endFloor {
            return [.end(reason: .battery)]
        }
        if cfg.thermalRules, thermal == .critical { return [.end(reason: .thermal)] }
        if battery.percent == nil, battery.hasBattery, onBattery, unreadableMisses >= 2,
            cfg.endFloor > 0
        {
            return [.end(reason: .batteryUnreadable)]
        }
        let cause = lowPowerCause(
            percent: battery.percent, charging: battery.charging, thermal: thermal,
            lidClosed: lidClosed, config: cfg)
        if let cause, !lowPowerSetByUs { return [.lowPowerOn(cause: cause)] }
        if cause == nil, lowPowerSetByUs { return [.lowPowerOff] }
        return []
    }

    // MARK: Recovery journal

    /// A journal entry for what is about to be owned.
    public static func journalEntry(
        nowMs: Double, endsAt: Double, owner: AwakeOwner = AwakeOwner(),
        sleepDisabled: Bool = false, lowPower: Bool = false
    ) -> AwakeJournal {
        AwakeJournal(
            at: nowMs, endsAt: endsAt, owner: owner, sleepDisabled: sleepDisabled,
            lowPower: lowPower)
    }

    /// A journal object, or nil when it is not one. An unreadable journal is
    /// NOT a clean one: the backstop must leave the machine alone and say so.
    public static func parseJournal(_ raw: Any?) -> AwakeJournal? {
        guard let obj = raw as? [String: Any] else { return nil }
        for key in journalKeys where obj[key] != nil && (obj[key] as? Bool) == nil {
            return nil
        }
        return AwakeJournal(
            version: intOr(obj["version"], version),
            at: finite(obj["at"]) ?? 0,
            endsAt: finite(obj["endsAt"]) ?? 0,
            owner: parseOwner(obj["owner"]) ?? AwakeOwner(),
            sleepDisabled: (obj["sleepDisabled"] as? Bool) == true,
            lowPower: (obj["lowPower"] as? Bool) == true)
    }

    /// Does the journal still own anything the Mac has to be given back?
    public static func journalDirty(_ journal: AwakeJournal?) -> Bool {
        guard let journal else { return false }
        return journal.sleepDisabled || journal.lowPower
    }

    /// What the backstop has to undo, in the order it must undo it.
    public static func recoverySteps(_ journal: AwakeJournal?) -> [String] {
        guard let journal else { return [] }
        var out: [String] = []
        if journal.sleepDisabled { out.append("sleepDisabled") }
        if journal.lowPower { out.append("lowPower") }
        return out
    }

    /// Whether the backstop may act yet: only once the session it was written
    /// for has been over for `backstopGraceMs`, or `force`. A journal whose
    /// deadline is in the future belongs to a live session and is left alone.
    public static func backstopDue(
        _ journal: AwakeJournal?, nowMs: Double, force: Bool = false
    ) -> Bool {
        guard journalDirty(journal), let journal else { return false }
        if force { return true }
        return nowMs >= journal.endsAt + backstopGraceMs
    }

    /// The warning the menu shows when a session is over and the Mac was not
    /// given back.
    public static func recoveryNotice(
        _ journal: AwakeJournal?, nowMs: Double
    ) -> AwakeRecoveryNotice? {
        let steps = recoverySteps(journal)
        guard !steps.isEmpty, let journal, nowMs >= journal.endsAt else { return nil }
        let endedAgoMs = max(0, nowMs - journal.endsAt)
        return AwakeRecoveryNotice(
            codes: steps, endedAgoMs: endedAgoMs, endedAgo: formatDuration(endedAgoMs / 1000))
    }

}
