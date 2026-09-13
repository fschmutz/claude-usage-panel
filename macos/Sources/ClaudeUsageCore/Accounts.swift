import Foundation

// Named Claude Code accounts - the pure half. Mirrors claude-code/accounts.js
// (the Node implementation the CLI, the MCP server and the status line share)
// and lib/pure.js on GNOME; tests/fixtures/accounts.json pins the decisions all
// ports must agree on. Foundation only: no I/O, no networking, so it
// unit-tests on Linux CI. The I/O half (store, Keychain, switch, refresh) is
// AccountStore.swift in the app target.

/// One saved Claude Code login: the credentials blob plus the `oauthAccount`
/// block of ~/.claude.json. Both are kept raw so unknown fields round-trip.
public struct AccountProfile {
    public static let version = 1
    /// Refresh an access token this close to its expiry rather than use it.
    public static let refreshLeadMs = 300_000.0
    /// Profile names are file names: one path segment, no leading dot or dash.
    public static let nameRegex = #"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"#

    public let name: String
    public let savedAt: String?
    public let account: [String: Any]
    public let credentials: [String: Any]

    public init(name: String, savedAt: String?, account: [String: Any], credentials: [String: Any])
    {
        self.name = name
        self.savedAt = savedAt
        self.account = account
        self.credentials = credentials
    }

    /// A stored profile, validated; nil for anything that is not one.
    public static func parse(_ raw: Any?) -> AccountProfile? {
        guard let dict = raw as? [String: Any],
            let name = dict["name"] as? String, Accounts.isValidName(name),
            let credentials = dict["credentials"] as? [String: Any],
            let oauth = credentials["claudeAiOauth"] as? [String: Any],
            let token = oauth["accessToken"] as? String, !token.isEmpty
        else { return nil }
        return AccountProfile(
            name: name,
            savedAt: dict["savedAt"] as? String,
            account: dict["account"] as? [String: Any] ?? [:],
            credentials: credentials)
    }

    public func toJSON() -> [String: Any] {
        var out: [String: Any] = [
            "version": Self.version,
            "name": name,
            "account": account,
            "credentials": credentials,
        ]
        if let savedAt { out["savedAt"] = savedAt }
        return out
    }

    public var oauth: [String: Any] { credentials["claudeAiOauth"] as? [String: Any] ?? [:] }
    public var accessToken: String { oauth["accessToken"] as? String ?? "" }
    public var refreshToken: String? {
        guard let t = oauth["refreshToken"] as? String, !t.isEmpty else { return nil }
        return t
    }
    public var expiresAtMs: Double? { (oauth["expiresAt"] as? NSNumber)?.doubleValue }
    public var refreshExpiresAtMs: Double? {
        (oauth["refreshTokenExpiresAt"] as? NSNumber)?.doubleValue
    }
    public var subscriptionType: String? { oauth["subscriptionType"] as? String }
    public var rateLimitTier: String? {
        (oauth["rateLimitTier"] as? String) ?? (account["organizationRateLimitTier"] as? String)
    }
    public var accountUuid: String? { account["accountUuid"] as? String }
    public var email: String? { account["emailAddress"] as? String }

    /// valid   - the access token is good for at least refreshLeadMs
    /// stale   - the access token is (about to be) expired; the refresh token
    ///           can mint a new one. Also the answer when the dates are unknown.
    /// expired - the refresh token is gone too; only a new login helps.
    public func tokenState(nowMs: Double, leadMs: Double = AccountProfile.refreshLeadMs)
        -> TokenState
    {
        guard refreshToken != nil else { return .expired }
        if let until = refreshExpiresAtMs, until <= nowMs { return .expired }
        if let until = expiresAtMs, until - nowMs > leadMs { return .valid }
        return .stale
    }

    public func summary(nowMs: Double) -> AccountSummary {
        AccountSummary(
            name: name, email: email, accountUuid: accountUuid, plan: subscriptionType,
            tier: rateLimitTier, tokenState: tokenState(nowMs: nowMs))
    }

    /// The profile with a replacement credentials blob (after a refresh or a
    /// sync-back), stamped with the time it was written.
    public func with(credentials: [String: Any], account: [String: Any]? = nil, savedAt: String)
        -> AccountProfile
    {
        AccountProfile(
            name: name, savedAt: savedAt, account: account ?? self.account,
            credentials: credentials)
    }
}

public enum TokenState: String, Sendable {
    case valid, stale, expired
}

public struct AccountSummary: Equatable, Sendable {
    public let name: String
    public let email: String?
    public let accountUuid: String?
    public let plan: String?
    public let tier: String?
    public let tokenState: TokenState

    public init(
        name: String, email: String?, accountUuid: String?, plan: String?, tier: String?,
        tokenState: TokenState
    ) {
        self.name = name
        self.email = email
        self.accountUuid = accountUuid
        self.plan = plan
        self.tier = tier
        self.tokenState = tokenState
    }
}

/// Auto-switch contract - the same numbers in every port.
public enum AutoSwitch {
    public static let threshold = 90
    public static let margin = 15
    public static let cooldownMs = 300_000.0
}

public struct AutoSwitchDecision: Equatable, Sendable {
    public let from: String
    public let to: String
    public let activePercent: Int
    public let targetPercent: Int

    public init(from: String, to: String, activePercent: Int, targetPercent: Int) {
        self.from = from
        self.to = to
        self.activePercent = activePercent
        self.targetPercent = targetPercent
    }
}

public enum Accounts {
    public static func isValidName(_ name: String) -> Bool {
        name.range(of: AccountProfile.nameRegex, options: .regularExpression) != nil
    }

    /// Code-point order, like the auto-switch tie-break - identical in every port.
    public static func sortedByName(_ profiles: [AccountProfile]) -> [AccountProfile] {
        profiles.sorted { $0.name.unicodeScalars.lexicographicallyPrecedes($1.name.unicodeScalars) }
    }

    /// Which saved profile the live login is - by account id, else by email.
    public static func activeName(profiles: [AccountProfile], live: [String: Any]?) -> String? {
        guard let live else { return nil }
        if let uuid = live["accountUuid"] as? String,
            let hit = profiles.first(where: { $0.accountUuid == uuid })
        {
            return hit.name
        }
        if let email = (live["emailAddress"] as? String)?.lowercased(),
            let hit = profiles.first(where: { ($0.email ?? "").lowercased() == email })
        {
            return hit.name
        }
        return nil
    }

    /// The fullest limit of a set of cards.
    public static func worstPercent(_ cards: [LimitCard]) -> Int? {
        cards.map { max(0, min(100, $0.percent)) }.max()
    }

    /// The account to switch to, or nil to stay. `worst` maps each saved name
    /// to its worst limit percent (nil = usage unknown). Switch only when the
    /// active account is at/over the threshold, to the candidate with the most
    /// headroom, and only if that candidate sits at least `margin` points
    /// under the threshold (so two busy accounts do not ping-pong); never
    /// within the cooldown of the previous switch.
    public static func autoSwitchTarget(
        active: String?, worst: [String: Int?],
        threshold: Int = AutoSwitch.threshold, margin: Int = AutoSwitch.margin,
        cooldownMs: Double = AutoSwitch.cooldownMs, lastSwitchMs: Double? = nil, nowMs: Double
    ) -> AutoSwitchDecision? {
        guard let active, let activePercent = worst[active] ?? nil, activePercent >= threshold
        else { return nil }
        if let last = lastSwitchMs, nowMs - last < cooldownMs { return nil }
        var best: (name: String, percent: Int)?
        let names = worst.keys.sorted {
            $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars)
        }
        for name in names where name != active {
            guard let p = worst[name] ?? nil, p <= threshold - margin else { continue }
            if best == nil || p < best!.percent { best = (name, p) }
        }
        guard let best else { return nil }
        return AutoSwitchDecision(
            from: active, to: best.name, activePercent: activePercent, targetPercent: best.percent)
    }

    /// "S 42% · W 12%" from the session / weekly-all cards, for a compact row.
    public static func formatUsage(_ cards: [LimitCard]) -> String {
        let s = cards.first { $0.id == "session" }.map { "S \($0.percent)%" } ?? "S -"
        let w = cards.first { $0.id == "weekly_all" }.map { "W \($0.percent)%" } ?? "W -"
        return "\(s) · \(w)"
    }
}
