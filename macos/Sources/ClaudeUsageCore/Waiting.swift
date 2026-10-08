import Foundation

// Live Claude Code sessions that are blocked waiting for the user: a
// permission prompt, a question, or idle after Stop. Mirrors
// lib/pure/waiting.js; tests/fixtures/waiting.json pins both.
//
// Stop marks idle (the turn ended and the prompt is waiting), it does not
// clear. UserPromptSubmit / PreToolUse / SessionEnd clear. Notification
// marks with a more specific reason. Markers for a pid that is not live
// are ignored - the I/O layer hands only live registry rows in.

public enum WaitingReason: String, Sendable {
    case permission
    case question
    case idle
}

public struct WaitingMarker: Equatable, Sendable {
    public let sessionId: String
    public let pid: Int
    public let reason: WaitingReason
    public let at: Double

    public init(sessionId: String, pid: Int, reason: WaitingReason, at: Double) {
        self.sessionId = sessionId
        self.pid = pid
        self.reason = reason
        self.at = at
    }
}

public struct WaitingSession: Identifiable, Equatable, Sendable {
    public let pid: Int
    public let sessionId: String
    public let name: String
    public let cwd: String
    public let reason: WaitingReason
    public let at: Double
    public let age: String
    public let reasonLabel: String

    public var id: String { "\(pid):\(sessionId)" }

    public init(
        pid: Int, sessionId: String, name: String, cwd: String, reason: WaitingReason,
        at: Double, age: String, reasonLabel: String
    ) {
        self.pid = pid
        self.sessionId = sessionId
        self.name = name
        self.cwd = cwd
        self.reason = reason
        self.at = at
        self.age = age
        self.reasonLabel = reasonLabel
    }
}

public struct WaitingFocusPlan: Equatable, Sendable {
    public enum How: String, Sendable {
        case kitty, wezterm, tmux, iterm, terminal, pid, none
    }

    public let how: How
    public let id: String?
    public let session: String?
    public let tab: Int?
    public let pid: Int?

    public init(
        how: How, id: String? = nil, session: String? = nil, tab: Int? = nil, pid: Int? = nil
    ) {
        self.how = how
        self.id = id
        self.session = session
        self.tab = tab
        self.pid = pid
    }
}

public enum Waiting {
    public static let reasons = ["permission", "question", "idle"]
    public static let hookEvents = [
        "Notification", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd",
    ]
    public static let markerSuffix = ".waiting.json"
    public static let markerVersion = 1

    /// `<pid>.waiting.json` next to Claude Code's `<pid>.json` registry file.
    public static func markerName(_ pid: Int) -> String { "\(pid)\(markerSuffix)" }

    /// The pid a marker filename names, or nil when the name is not ours.
    public static func pid(fromMarkerName name: String) -> Int? {
        let pattern = #"^(\d+)\.waiting\.json$"#
        guard let re = try? NSRegularExpression(pattern: pattern),
            let m = re.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
            let r = Range(m.range(at: 1), in: name)
        else { return nil }
        return Int(name[r])
    }

    /// Why a Notification hook is waiting. Type first, then the message.
    public static func reasonFromNotification(_ payload: [String: Any]) -> WaitingReason {
        let type = String(
            (payload["notification_type"] as? String)
                ?? (payload["notificationType"] as? String) ?? ""
        ).lowercased()
        let message = String(payload["message"] as? String ?? "").lowercased()
        let text = "\(type) \(message)"
        if type.contains("permission") || message.contains("permission") { return .permission }
        if type.contains("idle") || type.contains("timeout")
            || text.range(of: #"\bidle\b"#, options: .regularExpression) != nil
        {
            return .idle
        }
        return .question
    }

    public enum HookAction: Equatable, Sendable {
        case mark(reason: WaitingReason, at: Double)
        case clear
        case ignore
    }

    /// What a Claude Code hook event does to the waiting marker.
    /// Stop marks idle; UserPromptSubmit / PreToolUse / SessionEnd clear.
    public static func applyHookEvent(
        _ name: String, payload: [String: Any] = [:], nowMs: Double = 0
    ) -> HookAction {
        switch name {
        case "SessionEnd", "UserPromptSubmit", "PreToolUse":
            return .clear
        case "Stop":
            return .mark(reason: .idle, at: nowMs)
        case "Notification":
            return .mark(reason: reasonFromNotification(payload), at: nowMs)
        default:
            return .ignore
        }
    }

    /// A marker object, or nil when a field is the wrong JSON type.
    public static func parseMarker(_ raw: Any?) -> WaitingMarker? {
        guard let obj = raw as? [String: Any] else { return nil }
        guard let sessionId = obj["sessionId"] as? String, !sessionId.isEmpty else { return nil }
        // Integer pid only (JS Number.isInteger). JSONSerialization on Linux
        // often boxes a JSON integer as a float NSNumber, so do not use
        // CFNumberIsFloatType; require a whole positive number and reject bools.
        guard let pidNum = obj["pid"] as? NSNumber, !Accounts.isJSONBool(pidNum)
        else { return nil }
        let pid = pidNum.intValue
        guard pid > 0, pidNum.doubleValue == Double(pid) else { return nil }
        guard let reasonRaw = obj["reason"] as? String,
            let reason = WaitingReason(rawValue: reasonRaw)
        else { return nil }
        guard let atNum = obj["at"] as? NSNumber, !Accounts.isJSONBool(atNum),
            atNum.doubleValue.isFinite
        else { return nil }
        return WaitingMarker(
            sessionId: sessionId, pid: pidNum.intValue, reason: reason, at: atNum.doubleValue)
    }

    /// Compact age, two most significant units, whole seconds floored.
    public static func age(atMs: Double, nowMs: Double) -> String {
        guard atMs.isFinite, nowMs.isFinite else { return "" }
        let sec = max(0, Int(((nowMs - atMs) / 1000).rounded(.down)))
        let d = sec / 86400
        let h = (sec % 86400) / 3600
        let m = (sec % 3600) / 60
        let s = sec % 60
        if d > 0 { return h > 0 ? "\(d)d \(h)h" : "\(d)d" }
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        if m > 0 { return s > 0 ? "\(m)m \(s)s" : "\(m)m" }
        return "\(s)s"
    }

    public static func reasonLabel(_ reason: WaitingReason) -> String { reason.rawValue }

    public struct LiveSession: Equatable, Sendable {
        public let pid: Int
        public let sessionId: String
        public let name: String
        public let cwd: String

        public init(pid: Int, sessionId: String, name: String, cwd: String) {
            self.pid = pid
            self.sessionId = sessionId
            self.name = name
            self.cwd = cwd
        }
    }

    /// Live sessions that have a waiting marker, oldest wait first. A marker
    /// whose pid is not in `sessions` is ignored (dead process).
    public static func list(
        sessions: [LiveSession], markers: [WaitingMarker], nowMs: Double
    ) -> [WaitingSession] {
        let pairs = sessions.filter { $0.pid > 0 }.map { ($0.pid, $0) }
        let live = Dictionary(uniqueKeysWithValues: pairs)
        var out: [WaitingSession] = []
        for marker in markers {
            guard let session = live[marker.pid] else { continue }
            let trimmed = session.cwd.replacingOccurrences(
                of: "/+$", with: "", options: .regularExpression)
            let fallback = trimmed.split(separator: "/").last.map(String.init) ?? ""
            let name =
                !session.name.isEmpty
                ? session.name
                : (!fallback.isEmpty
                    ? fallback
                    : (session.sessionId.isEmpty
                        ? "session" : String(session.sessionId.prefix(8))))
            out.append(
                WaitingSession(
                    pid: marker.pid,
                    sessionId: session.sessionId.isEmpty ? marker.sessionId : session.sessionId,
                    name: name,
                    cwd: session.cwd,
                    reason: marker.reason,
                    at: marker.at,
                    age: age(atMs: marker.at, nowMs: nowMs),
                    reasonLabel: reasonLabel(marker.reason)))
        }
        return out.sorted { a, b in a.at != b.at ? a.at < b.at : a.pid < b.pid }
    }

    /// How to raise the terminal that holds a live session.
    public static func focusPlan(window: String?, tab: Int?, pid: Int?) -> WaitingFocusPlan {
        let w = window ?? ""
        if w.hasPrefix("kitty:") {
            return WaitingFocusPlan(how: .kitty, id: String(w.dropFirst(6)))
        }
        if w.hasPrefix("wezterm:") {
            return WaitingFocusPlan(how: .wezterm, id: String(w.dropFirst(8)))
        }
        if w.hasPrefix("tmux:") {
            return WaitingFocusPlan(how: .tmux, session: String(w.dropFirst(5)), tab: tab)
        }
        if w.hasPrefix("iterm:") {
            return WaitingFocusPlan(how: .iterm, id: String(w.dropFirst(6)), tab: tab)
        }
        if w.hasPrefix("terminal:") {
            return WaitingFocusPlan(how: .terminal, id: String(w.dropFirst(9)), tab: tab)
        }
        if let pid, pid > 0 { return WaitingFocusPlan(how: .pid, pid: pid) }
        return WaitingFocusPlan(how: .none)
    }

    /// argv that raises the session's terminal, or nil for AppleScript / none.
    public static func focusArgv(_ plan: WaitingFocusPlan) -> [String]? {
        switch plan.how {
        case .kitty:
            return ["kitty", "@", "focus-window", "--match", "id:\(plan.id ?? "")"]
        case .wezterm:
            return ["wezterm", "cli", "activate-pane", "--window-id", plan.id ?? ""]
        case .tmux:
            let target =
                plan.tab.map { "\(plan.session ?? ""):\($0)" } ?? (plan.session ?? "")
            return ["tmux", "select-window", "-t", target]
        case .pid:
            return ["kitty", "@", "focus-window", "--match", "pid:\(plan.pid ?? 0)"]
        case .iterm, .terminal, .none:
            return nil
        }
    }
}
