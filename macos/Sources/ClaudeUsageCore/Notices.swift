import Foundation

// Inline notices, button-local outcomes and the switch rotation - the macOS
// port. Mirrors the GNOME extension's lib/pure/notices.js 1:1, and
// claude-code/notices.js for the health and the notices (no Node client draws
// a button); tests/fixtures/notices.json pins every leg. Foundation only, so
// it unit-tests on Linux CI.
//
// The rule these three share: a problem with a saved login belongs next to
// that login, with the ONE thing that repairs it attached, and the answer to
// pressing that button belongs next to the button. Both used to live in a
// global error line at the bottom of the popup (or in Settings), which is
// where a message goes to be missed.
//
// Sentences and button labels are deliberately NOT here: they are the view's,
// and translated. What is pinned is which notice appears, in what order, how
// loud it is, and what its single repair action does.

/// How usable a saved login is right now.
public enum AccountHealth: String, Sendable, CaseIterable {
    /// The stored access token is good as it stands.
    case valid
    /// It is (about to be) expired, and the refresh token can mint a new one
    /// on next use. Not a problem; not worth a notice.
    case stale
    /// The refresh token is gone or spent: only a new `claude auth login` on
    /// that account helps.
    case expired
    /// The exchange was tried and refused, or the usage endpoint turned a
    /// STORED token down. The saved credentials are finished even though their dates
    /// say otherwise, so the UI must stop drawing that account's bars as if
    /// they were current.
    case refreshFailed = "refresh-failed"
    /// Nothing is known to be wrong with the login; the reading is simply
    /// missing (a 429, a 5xx, no network, a live login that could not be
    /// read, or a live token the endpoint turned down: that one is Claude
    /// Code's to refresh, not the profile's).
    case unreachable

    /// A state the user has to act on - the ones that earn a notice row.
    public var needsAttention: Bool { self == .expired || self == .refreshFailed }
}

/// One inline row: something needs saying, and one button fixes it.
public struct AccountNotice: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable {
        case pendingSwitch = "pending-switch"
        case tornLogin = "torn-login"
        case unsavedLogin = "unsaved-login"
        case loginExpired = "login-expired"
        case refreshFailed = "refresh-failed"
        case unreachable
    }

    /// The single repair the row offers. `relogin` is the one that cannot be
    /// done for the user - no client ever runs a login - so it only says how.
    public enum Action: String, Sendable {
        case finishSwitch = "finish-switch"
        case repairLogin = "repair"
        case save
        case relogin
        case retry
    }

    public let id: String
    public let kind: Kind
    public let severity: Severity
    public let action: Action
    /// The account name the action works on, or the live login's email for
    /// `save`. Nil when the action needs no argument.
    public let arg: String?

    public init(id: String, kind: Kind, severity: Severity, action: Action, arg: String?) {
        self.id = id
        self.kind = kind
        self.severity = severity
        self.action = action
        self.arg = arg
    }
}

public enum Notices {
    /// `errorCode` is the code the usage result carries ("refresh_failed",
    /// "login_expired", "auth_expired", "forbidden", "transient", "http_error",
    /// "network_error", "parse_error", "no_token"), or nil when the fetch
    /// worked. `live` is true when the token that was used is the live
    /// login's (AccountStore.TokenSource.live).
    public static func health(
        tokenState: TokenState, errorCode: String? = nil, live: Bool = false
    ) -> AccountHealth {
        if errorCode == "refresh_failed" || (errorCode == "auth_expired" && !live) {
            return .refreshFailed
        }
        if errorCode == "login_expired" || tokenState == .expired { return .expired }
        if errorCode != nil { return .unreachable }
        return tokenState == .valid ? .valid : .stale
    }

    /// What the accounts list must say out loud, each with one repair button.
    /// - Parameters:
    ///   - rows: saved accounts in store order, with the health of each
    ///   - liveEmail: the live login's email, when it has one
    ///   - activeName: the saved profile the live login is, or nil
    ///   - pending: the target of an unfinished switch
    ///   - torn: the live login's two halves name different profiles
    public static func accountNotices(
        rows: [(name: String, health: AccountHealth)], liveEmail: String? = nil,
        activeName: String? = nil, pendingTo: String? = nil, torn: Bool = false
    ) -> [AccountNotice] {
        var out: [AccountNotice] = []
        // Loudest first, and the two that describe the LIVE login before the
        // saved ones: a half-installed switch explains every row under it.
        if let pendingTo {
            out.append(
                AccountNotice(
                    id: "pending-switch", kind: .pendingSwitch, severity: .critical,
                    action: .finishSwitch, arg: pendingTo))
        }
        if torn, let activeName {
            out.append(
                AccountNotice(
                    id: "torn-login", kind: .tornLogin, severity: .warning,
                    action: .repairLogin, arg: activeName))
        }
        // A login nobody named survives a switch only because we park it under
        // its email. Saying so beats discovering the parked name afterwards.
        if activeName == nil, let liveEmail {
            out.append(
                AccountNotice(
                    id: "unsaved-login", kind: .unsavedLogin, severity: .warning,
                    action: .save, arg: liveEmail))
        }
        for row in rows {
            switch row.health {
            case .expired:
                out.append(
                    AccountNotice(
                        id: "login-expired:\(row.name)", kind: .loginExpired,
                        severity: .critical, action: .relogin, arg: row.name))
            case .refreshFailed:
                out.append(
                    AccountNotice(
                        id: "refresh-failed:\(row.name)", kind: .refreshFailed,
                        severity: .critical, action: .relogin, arg: row.name))
            case .unreachable:
                out.append(
                    AccountNotice(
                        id: "unreachable:\(row.name)", kind: .unreachable,
                        severity: .warning, action: .retry, arg: row.name))
            case .valid, .stale:
                continue
            }
        }
        return out
    }
}

// MARK: - Button-local outcomes

/// The answer to "did that work?" beside the control that asked, and only
/// briefly: a success that never clears becomes furniture, and a failure still
/// on screen two actions later is a lie.
public struct ControlOutcome: Equatable, Sendable {
    /// How long an outcome stays beside its control.
    public static let ttlMs: Double = 6000

    public let control: String
    public let ok: Bool
    public let text: String
    public let atMs: Double

    public init(control: String, ok: Bool, text: String, atMs: Double) {
        self.control = control
        self.ok = ok
        self.text = text
        self.atMs = atMs
    }

    /// Still worth showing: it has something to say and it is inside the TTL.
    /// A view clears on the next action as well - this is only the clock.
    public func visible(nowMs: Double, ttlMs: Double = ControlOutcome.ttlMs) -> Bool {
        guard !text.isEmpty else { return false }
        let age = nowMs - atMs
        return age >= 0 && age < ttlMs
    }
}

// MARK: - Switch rotation

/// "Next account" walks the saved list in order and wraps. That order is the
/// one every port already lists accounts in (code points), so the quiet line
/// under the switch control describes exactly what the button does - and the
/// line is only shown when there is a rotation to describe.
public enum Rotation {
    /// Fewer saved logins than this and there is no rotation to speak of.
    public static let minimum = 2

    /// The saved names in the order a rotation walks them.
    public static func order(_ names: [String]) -> [String] {
        names.sorted { $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars) }
    }

    /// The account "Next" moves to: the one after `active`, wrapping at the
    /// end. The first name when the live login is not a saved one (there is
    /// nowhere to be "after"). Nil below `minimum` names.
    public static func next(_ names: [String], active: String?) -> String? {
        let ordered = order(names)
        guard ordered.count >= minimum else { return nil }
        guard let active, let i = ordered.firstIndex(of: active) else { return ordered[0] }
        return ordered[(i + 1) % ordered.count]
    }
}
