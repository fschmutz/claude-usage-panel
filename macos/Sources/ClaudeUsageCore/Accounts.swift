import Foundation

// Named Claude Code accounts - the pure half. Mirrors claude-code/accounts.js
// (the Node implementation the CLI, the MCP server and the status line share)
// and lib/pure.js on GNOME; tests/fixtures/accounts.json pins the decisions all
// ports must agree on. Foundation only: no I/O, no networking, so it
// unit-tests on Linux CI. The I/O half (store, Keychain, switch, refresh) is
// AccountStore.swift in the app target.

/// One saved Claude Code login: the credentials blob plus the `oauthAccount`
/// block of ~/.claude.json. Both are kept raw so unknown fields round-trip.
/// `@unchecked`: the two dictionaries are `let`, never mutated after init, and
/// hold only JSON scalars, arrays and dictionaries (JSONSerialization output).
public struct AccountProfile: @unchecked Sendable {
    public static let version = 1
    /// Refresh an access token this close to its expiry rather than use it.
    public static let refreshLeadMs = 300_000.0
    /// Profile names are file names: one path segment, no leading dot or dash.
    /// `\A` / `\z`, not `^` / `$`: ICU's `$` also matches before a final
    /// newline, so "PRO\n" would pass here and fail every JS port.
    public static let nameRegex = #"\A[A-Za-z0-9][A-Za-z0-9._-]{0,31}\z"#

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

/// What syncBack may do with the live login (see `Accounts.syncBackPlan`).
public struct SyncBackPlan: Equatable, Sendable {
    public let name: String?
    public let snapshot: Bool
    public let pendingDone: Bool

    public init(name: String?, snapshot: Bool, pendingDone: Bool) {
        self.name = name
        self.snapshot = snapshot
        self.pendingDone = pendingDone
    }
}

public enum Accounts {
    /// Claude Code's macOS Keychain item for its credentials, by default.
    public static let keychainService = "Claude Code-credentials"
    /// Names older Claude Code releases used for the default item.
    public static let legacyKeychainServices = ["Claude Code", "claude"]

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

    /// Which saved profile the live login is. The credentials decide first:
    /// when the live access token is exactly one a profile holds, that profile
    /// is live whatever the account block says (a switch that failed between
    /// its two writes leaves them disagreeing). Otherwise Claude Code has
    /// rotated the token, and the account block is the identity.
    public static func liveProfileName(
        profiles: [AccountProfile], token: String?, account: [String: Any]?
    ) -> String? {
        if let token, !token.isEmpty, let hit = profiles.first(where: { $0.accessToken == token }) {
            return hit.name
        }
        return activeName(profiles: profiles, live: account)
    }

    /// What syncBack may do with the live login, given the switch-in-progress
    /// marker `pendingTo` (the target of an unfinished switch, or nil).
    /// `snapshot` never when the two halves disagree (the account block names
    /// another profile), never without an account block (the profile would
    /// lose its identity), and never while a switch is unfinished: its
    /// credentials may still be the previous login's, rotated past any token
    /// match. `pendingDone`: the marked switch did complete (the target's
    /// token and account block are both live), so the marker is cleared.
    public static func syncBackPlan(
        profiles: [AccountProfile], token: String?, account: [String: Any]?, pendingTo: String?
    ) -> SyncBackPlan {
        guard let name = liveProfileName(profiles: profiles, token: token, account: account) else {
            return SyncBackPlan(name: nil, snapshot: false, pendingDone: false)
        }
        let byAccount = activeName(profiles: profiles, live: account)
        let torn = byAccount != nil && byAccount != name
        var pendingDone = false
        if let pendingTo, let target = profiles.first(where: { $0.name == pendingTo }) {
            pendingDone = target.name == name && byAccount == name && target.accessToken == token
        }
        let snapshot = account != nil && !torn && (pendingTo == nil || pendingDone)
        return SyncBackPlan(name: name, snapshot: snapshot, pendingDone: pendingDone)
    }

    /// Two profile names that would land on one file on a case-insensitive
    /// disk (APFS, the macOS default). Names are ASCII, so lowercasing is exact.
    public static func sameName(_ a: String, _ b: String) -> Bool {
        a.lowercased() == b.lowercased()
    }

    /// The name an unsaved live login is parked under before a switch: the
    /// local part of its email made a valid profile name ("admin", then
    /// "admin-2" ...), free of every taken name ignoring case. One code point
    /// is one character, as in the JS ports.
    public static func parkName(email: String?, taken: [String]) -> String {
        let local =
            email.map { String($0.split(separator: "@", omittingEmptySubsequences: false)[0]) }
            ?? ""
        let isAlnum = { (c: Character) in c.isASCII && (c.isLetter || c.isNumber) }
        var chars: [Character] = local.unicodeScalars.map { scalar in
            let c = Character(scalar)
            return isAlnum(c) || "._-".contains(c) ? c : "-"
        }
        while let first = chars.first, !isAlnum(first) { chars.removeFirst() }
        var base = String(chars.prefix(28))
        if base.isEmpty { base = "account" }
        let used = Set(taken.map { $0.lowercased() })
        var name = base
        var n = 2
        while used.contains(name.lowercased()) {
            name = "\(base)-\(n)"
            n += 1
        }
        return name
    }

    /// The Keychain items to read, current first; writes go to the first.
    /// Claude Code suffixes its item with the first 8 hex digits of
    /// sha256(NFC config dir) whenever CLAUDE_CONFIG_DIR is set, so each config
    /// dir holds its own login; CLAUDE_SECURESTORAGE_CONFIG_DIR overrides the
    /// hashed dir, and set but empty it forces the plain name. A suffixed item
    /// has no legacy names. `sha256Hex` is the caller's hash (text -> hex).
    public static func keychainServices(
        env: [String: String], sha256Hex: (String) -> String
    ) -> [String] {
        let dir = env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] ?? env["CLAUDE_CONFIG_DIR"] ?? ""
        guard !dir.isEmpty else { return [keychainService] + legacyKeychainServices }
        let hash = sha256Hex(dir.precomposedStringWithCanonicalMapping)
        return ["\(keychainService)-\(hash.prefix(8))"]
    }

    /// The line fed to `security -i` on stdin that stores `secret` in the
    /// Keychain item (account, service). The secret never goes on the command
    /// line, where `ps` shows it: it travels hex-encoded (-X) on stdin. Account
    /// and service are double-quoted; one that cannot be quoted plainly (a
    /// quote, a backslash, a control character, or empty) gives nil, and the
    /// caller refuses the write. So does a line of `keychainLineMax` bytes or
    /// more: `security -i` reads each command into a buffer of that size and
    /// would run a truncated one.
    public static func keychainWriteLine(account: String, service: String, secret: String)
        -> String?
    {
        let plain = { (s: String) in
            !s.isEmpty
                && !s.unicodeScalars.contains {
                    $0 == "\"" || $0 == "\\" || $0.properties.generalCategory == .control
                }
        }
        guard plain(account), plain(service) else { return nil }
        let hex = secret.utf8.map { String(format: "%02x", $0) }.joined()
        let line = "add-generic-password -U -a \"\(account)\" -s \"\(service)\" -X \(hex)\n"
        return line.utf8.count < keychainLineMax ? line : nil
    }

    /// security(1)'s MAX_LINE_LEN: one `security -i` command, newline
    /// included, must be shorter.
    public static let keychainLineMax = 4096

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

    /// "S 42% · W 12%" from the session / weekly-all cards, for a compact
    /// row; a missing card is left out, and no card at all gives "".
    public static func formatUsage(_ cards: [LimitCard]) -> String {
        let part = { (key: String, tag: String) -> String? in
            cards.first { $0.id == key }.map { "\(tag) \(max(0, min(100, $0.percent)))%" }
        }
        return [part("session", "S"), part("weekly_all", "W")].compactMap { $0 }.joined(
            separator: " · ")
    }

    /// A fetch/refresh error as an account ROW shows it: the store prefixes
    /// its errors with the profile name for the CLI and the notifications,
    /// and a row already carries that name, so the prefix is dropped there.
    public static func rowError(name: String, message: String) -> String {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = "\(name): "
        return text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : text
    }
}
