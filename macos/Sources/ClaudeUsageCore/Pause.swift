import Foundation

// Pause / resume every live Claude Code session, as the menu-bar app sees
// it. Mirrors the GNOME extension's lib/pure/pause.js for what the app
// reads: the request shape, the row states, the summary, the row names and
// the text cleaning; tests/fixtures/pause.json pins both. The app sends
// every request through claudectl and reads `claudectl session pause-status
// --json`, whose rows the Node pauseRows join already built: the delivery
// side (shouldDeliver, the binding, the backstop, the delivery and verdict
// records, the row join, the texts) is Node-only and not ported.

public enum PauseKind: String, Sendable, CaseIterable {
    case pause
    case resume
}

public enum PauseVerdict: String, Sendable, CaseIterable {
    case safe = "SAFE"
    case notSafe = "NOT_SAFE"
}

public enum PauseSource: String, Sendable, CaseIterable {
    case cli
    case gnome
    case macos
    /// set by claudectl when it runs inside a Claude Code session
    case session
}

public enum PauseVia: String, Sendable, CaseIterable {
    case rewake
    case pretooluse
}

/// Where one targeted session stands on the current request.
public enum PauseRowState: String, Sendable, CaseIterable {
    /// its verdict for this request (wins over liveness)
    case safe
    case notSafe = "not-safe"
    /// a resume request was delivered
    case resumed
    /// a newer request replaced this one before it answered
    case superseded
    /// delivered, verdict not in yet
    case delivered
    /// live, not delivered, a waiter is armed
    case pending
    /// live, not delivered, no waiter (the next tool call gets it)
    case unarmed
    /// delivered, then the session ended without a verdict
    case lost
    /// not live and never delivered
    case gone
    /// older than the TTL and never delivered
    case expired

    public var terminal: Bool {
        switch self {
        case .safe, .notSafe, .resumed, .superseded, .gone, .lost, .expired: return true
        case .delivered, .pending, .unarmed: return false
        }
    }
}

public struct PauseSessionMeta: Equatable, Sendable {
    public let sessionId: String
    public let name: String
    public let cwd: String

    public init(sessionId: String, name: String, cwd: String) {
        self.sessionId = sessionId
        self.name = name
        self.cwd = cwd
    }
}

public struct PauseRequest: Equatable, Sendable {
    public enum Targets: Equatable, Sendable {
        case all
        case sessions([String])
    }

    public let version: Int
    public let id: String
    public let kind: PauseKind
    public let at: Double
    public let targets: Targets
    public let from: PauseSource
    public let sessions: [PauseSessionMeta]
    /// The sending session's id when `from` is session.
    public let origin: String?

    public init(
        id: String, kind: PauseKind, at: Double, targets: Targets, from: PauseSource,
        sessions: [PauseSessionMeta], origin: String? = nil
    ) {
        self.version = Pause.version
        self.id = id
        self.kind = kind
        self.at = at
        self.targets = targets
        self.from = from
        self.sessions = sessions
        self.origin = origin
    }
}

public struct PauseRow: Equatable, Sendable {
    public let state: PauseRowState
    public let via: PauseVia?
    public let verdict: PauseVerdict?
    public let reason: String?
    public let checkpoint: String?

    public var terminal: Bool { state.terminal }

    public init(
        state: PauseRowState, via: PauseVia? = nil, verdict: PauseVerdict? = nil,
        reason: String? = nil, checkpoint: String? = nil
    ) {
        self.state = state
        self.via = via
        self.verdict = verdict
        self.reason = reason
        self.checkpoint = checkpoint
    }
}

public struct PauseSummary: Equatable, Sendable {
    public let total: Int
    public let delivered: Int
    public let safe: Int
    public let notSafe: Int
    public let resumed: Int
    public let pending: Int
    /// every row is terminal (an empty list is done)
    public let done: Bool
    /// every row reached the good end: all safe / all resumed
    public let ok: Bool
    /// "5/7 safe" or "3/3 resumed"
    public let label: String
}

public enum Pause {
    public static let version = 1
    public static let kinds = PauseKind.allCases.map(\.rawValue)
    public static let verdicts = PauseVerdict.allCases.map(\.rawValue)
    public static let sources = PauseSource.allCases.map(\.rawValue)
    public static let vias = PauseVia.allCases.map(\.rawValue)
    /// A request older than this is never delivered.
    public static let requestTtlMs: Double = 3_600_000
    /// The longest verdict reason kept (code points).
    public static let reasonMax = 300
    public static let textMax = 1024

    // ASCII only and anchored at the true end, like the JS regex without the
    // m flag (an ICU `$` would also accept a trailing newline).
    private static func matchesId(_ value: Any?, allowUnderscore: Bool) -> Bool {
        guard let s = value as? String else { return false }
        let scalars = Array(s.unicodeScalars)
        guard (1...64).contains(scalars.count) else { return false }
        func alnum(_ c: Unicode.Scalar) -> Bool {
            ("A"..."Z").contains(c) || ("a"..."z").contains(c) || ("0"..."9").contains(c)
        }
        guard alnum(scalars[0]) else { return false }
        return scalars.dropFirst().allSatisfy {
            alnum($0) || $0 == "-" || (allowUnderscore && $0 == "_")
        }
    }

    /// `^[A-Za-z0-9][A-Za-z0-9-]{0,63}$`: a uuid in practice, never a path.
    public static func isSessionId(_ value: Any?) -> Bool {
        matchesId(value, allowUnderscore: false)
    }

    static func isRequestId(_ value: Any?) -> Bool {
        matchesId(value, allowUnderscore: true)
    }

    /// A finite JSON number >= 0 (a bool is not a number).
    static func stamp(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, !Accounts.isJSONBool(n) else { return nil }
        let d = n.doubleValue
        return d.isFinite && d >= 0 ? d : nil
    }

    /// Text safe to show: every control character (C0, DEL, C1) becomes a
    /// space, and at most `max` code points (unicode scalars) are kept. nil
    /// for a non-string or an empty string. Like JS cleanPauseText.
    public static func cleanText(_ value: Any?, max: Int = textMax) -> String? {
        guard let s = value as? String, !s.isEmpty else { return nil }
        var out = String.UnicodeScalarView()
        for scalar in s.unicodeScalars.prefix(max) {
            let v = scalar.value
            out.append(v < 0x20 || (0x7F...0x9F).contains(v) ? " " : scalar)
        }
        return String(out)
    }

    private static func optText(_ value: Any?) -> String? { cleanText(value) }

    /// A request, or nil when a field has the wrong JSON type. `targets` is
    /// "all" or a non-empty list of session ids (invalid ids dropped,
    /// duplicates removed; none left is nil). An unknown `from` is cli.
    public static func parseRequest(_ raw: Any?) -> PauseRequest? {
        guard let obj = raw as? [String: Any] else { return nil }
        guard let v = obj["version"] as? NSNumber, !Accounts.isJSONBool(v),
            v.doubleValue == Double(version),
            isRequestId(obj["id"]), let id = obj["id"] as? String,
            let kind = (obj["kind"] as? String).flatMap(PauseKind.init(rawValue:)),
            let at = stamp(obj["at"])
        else { return nil }
        let targets: PauseRequest.Targets
        if obj["targets"] as? String == "all" {
            targets = .all
        } else if let list = obj["targets"] as? [Any] {
            var seen = Set<String>()
            var ids: [String] = []
            for item in list where isSessionId(item) {
                let sid = item as! String
                if seen.insert(sid).inserted { ids.append(sid) }
            }
            guard !ids.isEmpty else { return nil }
            targets = .sessions(ids)
        } else {
            return nil
        }
        let sessions = (obj["sessions"] as? [Any] ?? []).compactMap { item -> PauseSessionMeta? in
            guard let s = item as? [String: Any], isSessionId(s["sessionId"]),
                let sid = s["sessionId"] as? String
            else { return nil }
            return PauseSessionMeta(
                sessionId: sid, name: optText(s["name"]) ?? "", cwd: optText(s["cwd"]) ?? "")
        }
        let from = (obj["from"] as? String).flatMap(PauseSource.init(rawValue:)) ?? .cli
        let origin = isSessionId(obj["origin"]) ? obj["origin"] as? String : nil
        return PauseRequest(
            id: id, kind: kind, at: at, targets: targets, from: from, sessions: sessions,
            origin: origin)
    }

    /// Counts and the one-line label: "5/7 safe" for a pause, "3/3 resumed"
    /// for a resume. A state this port does not know counts as not terminal.
    public static func summary(states: [String], kind: PauseKind) -> PauseSummary {
        let typed = states.map(PauseRowState.init(rawValue:))
        func count(_ set: Set<PauseRowState>) -> Int {
            typed.filter { $0.map(set.contains) ?? false }.count
        }
        let total = typed.count
        let safe = count([.safe])
        let resumed = count([.resumed])
        let good = kind == .resume ? resumed : safe
        return PauseSummary(
            total: total,
            delivered: count([.safe, .notSafe, .resumed, .delivered, .lost]),
            safe: safe,
            notSafe: count([.notSafe]),
            resumed: resumed,
            pending: count([.pending, .unarmed, .delivered]),
            done: typed.allSatisfy { $0?.terminal ?? false },
            ok: total > 0 && good == total,
            label: "\(good)/\(total) \(kind == .resume ? "resumed" : "safe")")
    }

    public static func summary(_ rows: [PauseRowState], kind: PauseKind) -> PauseSummary {
        summary(states: rows.map(\.rawValue), kind: kind)
    }

    /// Short words for a row in the menu-bar popup (labels are per port).
    public static func rowLabel(_ row: PauseRow) -> String {
        let via = row.via.map { $0 == .rewake ? " (woken)" : " (next tool call)" } ?? ""
        switch row.state {
        case .safe: return "SAFE"
        case .notSafe: return row.reason.map { "NOT SAFE: \($0)" } ?? "NOT SAFE"
        case .resumed: return "resumed\(via)"
        case .superseded: return "superseded by a newer request"
        case .delivered: return "delivered\(via), working"
        case .pending: return "waiter armed, delivering"
        case .unarmed: return "no waiter yet: gets it on its next tool call or turn"
        case .lost: return "delivered\(via), ended without a verdict"
        case .expired:
            return row.via == nil ? "expired before delivery" : "no verdict within the hour"
        case .gone: return "not running"
        }
    }
}

// MARK: - `claudectl session pause-status --json`, as the menu-bar app reads it

/// One target of the current request, as `pause-status --json` lists it.
/// `state` keeps the raw word so a state this port does not know still
/// counts in the summary (as not terminal) instead of vanishing.
public struct PauseStatusRow: Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let name: String
    public let cwd: String
    public let pid: Int?
    public let state: String
    public let row: PauseRow?

    public var id: String { sessionId }
}

public struct PauseStatus: Equatable, Sendable {
    public let request: PauseRequest?
    public let rows: [PauseStatusRow]
    public let summary: PauseSummary
}

/// A popup row: a live session, a target of the current request, or both.
public struct PausePanelRow: Equatable, Sendable, Identifiable {
    public let sessionId: String
    public let name: String
    public let cwd: String
    public let live: Bool
    /// Where it stands on the current request; nil when it is not a target.
    public let row: PauseRow?
    public let label: String

    public var id: String { sessionId }
}

extension Pause {
    /// The status object, or nil when it is not one. The summary is
    /// recomputed here from the row states, so it follows this port's rules.
    public static func parseStatus(_ raw: Any?) -> PauseStatus? {
        guard let obj = raw as? [String: Any] else { return nil }
        let request = parseRequest(obj["request"])
        var rows: [PauseStatusRow] = []
        if request != nil {
            for item in obj["rows"] as? [Any] ?? [] {
                guard let r = item as? [String: Any], isSessionId(r["sessionId"]),
                    let sid = r["sessionId"] as? String, let state = r["state"] as? String
                else { continue }
                let pid = (r["pid"] as? NSNumber).flatMap { Accounts.isJSONBool($0) ? nil : $0 }
                let row = PauseRowState(rawValue: state).map {
                    PauseRow(
                        state: $0,
                        via: (r["via"] as? String).flatMap(PauseVia.init(rawValue:)),
                        verdict: (r["verdict"] as? String).flatMap(PauseVerdict.init(rawValue:)),
                        reason: cleanText(r["reason"], max: reasonMax),
                        checkpoint: optText(r["checkpoint"]))
                }
                rows.append(
                    PauseStatusRow(
                        sessionId: sid, name: rowName(sid, name: r["name"], cwd: r["cwd"]),
                        cwd: optText(r["cwd"]) ?? "", pid: pid?.intValue, state: state, row: row))
            }
        }
        return PauseStatus(
            request: request, rows: rows,
            summary: summary(states: rows.map(\.state), kind: request?.kind ?? .pause))
    }

    /// The request's targets first (in its order, named as the CLI's
    /// pauseRows named them), then every other live session in live order
    /// - each one can still be paused on its own. The JS twin of this half
    /// is pauseRows' `others`.
    public static func panelRows(
        status: PauseStatus?, live: [Waiting.LiveSession]
    ) -> [PausePanelRow] {
        let liveById = Dictionary(live.map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<String>()
        var out: [PausePanelRow] = []
        for r in status?.rows ?? [] where seen.insert(r.sessionId).inserted {
            let l = liveById[r.sessionId]
            out.append(
                PausePanelRow(
                    sessionId: r.sessionId, name: r.name,
                    cwd: r.cwd, live: l != nil, row: r.row,
                    label: r.row.map(rowLabel) ?? r.state))
        }
        for l in live where isSessionId(l.sessionId) && seen.insert(l.sessionId).inserted {
            out.append(
                PausePanelRow(
                    sessionId: l.sessionId, name: rowName(l.sessionId, name: l.name, cwd: l.cwd),
                    cwd: cleanText(l.cwd) ?? "", live: true,
                    row: nil, label: "running"))
        }
        return out
    }

    /// A row's name: the live session's, else the one the request recorded,
    /// else the cwd basename (live, else recorded), else the id prefix.
    /// Control characters blanked. Twin of JS pauseRowName.
    public static func rowName(
        _ sessionId: String, name: Any?, cwd: Any?, metaName: Any? = nil, metaCwd: Any? = nil
    ) -> String {
        if let n = cleanText(name) { return n }
        if let n = cleanText(metaName) { return n }
        let liveCwd = (cwd as? String) ?? ""
        let path = liveCwd.isEmpty ? ((metaCwd as? String) ?? "") : liveCwd
        var trimmed = Substring(path)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        let base =
            trimmed.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init)
            ?? ""
        return cleanText(base) ?? String(sessionId.prefix(8))
    }
}
