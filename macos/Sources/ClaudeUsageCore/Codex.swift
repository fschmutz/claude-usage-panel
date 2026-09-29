import Foundation

// Named OpenAI Codex logins - the pure half. Mirrors
// claude-code/codex-contract.js and the GNOME extension's lib/pure/codex.js
// 1:1; tests/fixtures/codex.json pins every decision below across the three.
// Foundation only, so it unit-tests on Linux CI.
//
// Codex is a SIBLING of the Claude accounts, never a replacement: it is off by
// default in both panels, it has its own store directory, and nothing here can
// touch a Claude login. What it reads is `auth.json` under the Codex home
// ($CODEX_HOME, else ~/.codex) - the same file the `codex` CLI writes when you
// sign in with ChatGPT - and the credentials never leave the machine.
//
// What it does NOT do: invent usage numbers. OpenAI publishes no plan-limit
// endpoint of the kind Anthropic's /api/oauth/usage is, so there is nothing to
// poll. The only honest figures available are the ones the Codex CLI itself
// recorded when the API last told it, and those are reported as ESTIMATED,
// with the instant they were captured, or not at all.

/// One saved Codex login: the `auth.json` blob, kept raw so unknown fields
/// round-trip. `@unchecked`: the dictionary is `let`, never mutated after
/// init, and holds only JSONSerialization output.
public struct CodexProfile: @unchecked Sendable {
    public static let version = 1

    public let name: String
    public let savedAt: String?
    public let auth: [String: Any]

    public init(name: String, savedAt: String?, auth: [String: Any]) {
        self.name = name
        self.savedAt = savedAt
        self.auth = auth
    }

    public static func parse(_ raw: Any?) -> CodexProfile? {
        guard let dict = raw as? [String: Any],
            let name = dict["name"] as? String, Accounts.isValidName(name),
            let auth = dict["auth"] as? [String: Any],
            let tokens = auth["tokens"] as? [String: Any],
            // An API-key-only auth.json is a valid Codex login, but not one
            // this store can switch between accounts with: no identity in it.
            let access = tokens["access_token"] as? String, !access.isEmpty
        else { return nil }
        return CodexProfile(name: name, savedAt: dict["savedAt"] as? String, auth: auth)
    }

    public func toJSON() -> [String: Any] {
        var out: [String: Any] = ["version": Self.version, "name": name, "auth": auth]
        if let savedAt { out["savedAt"] = savedAt }
        return out
    }

    public var tokens: [String: Any] { auth["tokens"] as? [String: Any] ?? [:] }
    public var accessToken: String { tokens["access_token"] as? String ?? "" }
    public var refreshToken: String? {
        guard let t = tokens["refresh_token"] as? String, !t.isEmpty else { return nil }
        return t
    }

    public func tokenState(nowMs: Double, leadMs: Double = Codex.refreshLeadMs) -> TokenState {
        Codex.tokenState(auth: auth, nowMs: nowMs, leadMs: leadMs)
    }

    public func summary(nowMs: Double) -> CodexSummary {
        let id = Codex.identity(auth)
        return CodexSummary(
            name: name, email: id.email, accountId: id.accountId, plan: id.plan,
            planLabel: id.planLabel, tokenState: tokenState(nowMs: nowMs))
    }
}

public struct CodexIdentity: Equatable, Sendable {
    public let email: String?
    public let accountId: String?
    public let plan: String?
    public let planLabel: String

    public init(email: String?, accountId: String?, plan: String?, planLabel: String) {
        self.email = email
        self.accountId = accountId
        self.plan = plan
        self.planLabel = planLabel
    }
}

public struct CodexSummary: Equatable, Sendable {
    public let name: String
    public let email: String?
    public let accountId: String?
    public let plan: String?
    public let planLabel: String
    public let tokenState: TokenState

    public init(
        name: String, email: String?, accountId: String?, plan: String?, planLabel: String,
        tokenState: TokenState
    ) {
        self.name = name
        self.email = email
        self.accountId = accountId
        self.plan = plan
        self.planLabel = planLabel
        self.tokenState = tokenState
    }
}

public enum Codex {
    /// Refresh lead, matching the Claude store: a token this close to expiry
    /// is stale rather than usable.
    public static let refreshLeadMs = 300_000.0
    /// Codex re-authenticates when its tokens have not been refreshed in this
    /// long; a stored profile older than that needs the CLI to sign in again.
    public static let refreshMaxAgeMs = 28 * 86_400_000.0
    /// The claim namespace ChatGPT tokens carry their plan in.
    public static let authClaim = "https://api.openai.com/auth"
    /// How long a recorded rate-limit snapshot is worth showing at all.
    public static let snapshotMaxAgeMs = 12 * 3_600_000.0

    /// The claims of a JWT, WITHOUT verifying its signature. Deliberate and
    /// safe here: the token is read from a file only this user can write, it
    /// is never used as proof of anything, and the claims are used for exactly
    /// two things - naming the account in a list and saying which plan it is
    /// on. A client that verified it would need OpenAI's keys and would still
    /// be reading the same file.
    public static func jwtClaims(_ token: String?) -> [String: Any]? {
        guard let token else { return nil }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var b64 =
            String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64),
            let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return claims
    }

    /// "Plus" / "Pro" / "Business" - the plan as the panels print it; "" unknown.
    public static func planLabel(_ plan: String?) -> String {
        let p = (plan ?? "").trimmingCharacters(in: .whitespaces)
        guard let first = p.first else { return "" }
        return String(first).uppercased()
            + p.dropFirst().replacingOccurrences(of: "_", with: " ")
    }

    /// Who a Codex auth blob belongs to, from the id token's claims.
    public static func identity(_ auth: [String: Any]?) -> CodexIdentity {
        let tokens = auth?["tokens"] as? [String: Any] ?? [:]
        let claims = jwtClaims(tokens["id_token"] as? String) ?? [:]
        let ns = claims[authClaim] as? [String: Any] ?? [:]
        let str = { (v: Any?) -> String? in
            guard let s = v as? String, !s.isEmpty else { return nil }
            return s
        }
        let plan = str(ns["chatgpt_plan_type"])
        return CodexIdentity(
            email: str(claims["email"]),
            accountId: str(tokens["account_id"]) ?? str(ns["chatgpt_account_id"]),
            plan: plan, planLabel: planLabel(plan))
    }

    /// valid / stale / expired, as in the Claude store. Note what this does
    /// NOT do: exchange anything. The Claude store refreshes a parked login
    /// because Anthropic documents that grant; nothing here mints a Codex
    /// token, so a stale one is reported and handed to the CLI, which owns
    /// the exchange.
    public static func tokenState(
        auth: [String: Any]?, nowMs: Double, leadMs: Double = Codex.refreshLeadMs
    ) -> TokenState {
        let tokens = auth?["tokens"] as? [String: Any] ?? [:]
        guard let refresh = tokens["refresh_token"] as? String, !refresh.isEmpty else {
            return .expired
        }
        if let last = auth?["last_refresh"] as? String,
            let at = UsageNormalizer.parseDate(last),
            nowMs - at.timeIntervalSince1970 * 1000 > refreshMaxAgeMs
        {
            return .expired
        }
        if let exp = (jwtClaims(tokens["access_token"] as? String)?["exp"] as? NSNumber)?
            .doubleValue, exp * 1000 - nowMs > leadMs
        {
            return .valid
        }
        return .stale
    }

    /// Which saved Codex profile a live auth blob is - by account id, else email.
    public static func activeName(profiles: [CodexProfile], live: [String: Any]?) -> String? {
        let id = identity(live)
        if let accountId = id.accountId,
            let hit = profiles.first(where: { identity($0.auth).accountId == accountId })
        {
            return hit.name
        }
        if let email = id.email?.lowercased(),
            let hit = profiles.first(where: {
                (identity($0.auth).email ?? "").lowercased() == email
            })
        {
            return hit.name
        }
        return nil
    }

    public static func sortedByName(_ profiles: [CodexProfile]) -> [CodexProfile] {
        profiles.sorted { $0.name.unicodeScalars.lexicographicallyPrecedes($1.name.unicodeScalars) }
    }

    // MARK: usage, honestly

    /// Label for a limit window of `minutes`: "5h limit", "Weekly limit".
    public static func windowLabel(_ minutes: Double?) -> String {
        guard let m = minutes, m.isFinite, m > 0 else { return "Codex limit" }
        let mins = Int(m)
        if Double(mins) == m, mins % 10080 == 0 {
            let weeks = mins / 10080
            return weeks == 1 ? "Weekly limit" : "\(weeks)-week limit"
        }
        if Double(mins) == m, mins % 1440 == 0 {
            let days = mins / 1440
            return days == 1 ? "Daily limit" : "\(days)-day limit"
        }
        if Double(mins) == m, mins % 60 == 0 { return "\(mins / 60)h limit" }
        return Double(mins) == m ? "\(mins)m limit" : "\(m)m limit"
    }

    /// The cards for one rate-limit snapshot the Codex CLI recorded. Empty
    /// when the snapshot carries nothing usable - there is no third option in
    /// which a number is made up.
    public static func normalizeLimits(_ rateLimits: [String: Any]?, capturedAtMs: Double)
        -> [LimitCard]
    {
        var out: [LimitCard] = []
        for (key, group) in [("primary", "session"), ("secondary", "weekly")] {
            guard let slot = rateLimits?[key] as? [String: Any],
                let used = (slot["used_percent"] as? NSNumber), !Accounts.isJSONBool(used)
            else { continue }
            let resets = (slot["resets_in_seconds"] as? NSNumber)?.doubleValue
            out.append(
                LimitCard(
                    id: "codex_\(key)",
                    label: windowLabel((slot["window_minutes"] as? NSNumber)?.doubleValue),
                    percent: UsageNormalizer.clampPercent(used.doubleValue), severity: .normal,
                    resetsAt: resets.map {
                        Date(timeIntervalSince1970: (capturedAtMs + $0 * 1000) / 1000)
                    },
                    active: key == "primary", group: group, scoped: false, percentKnown: true))
        }
        return out
    }

    /// Whether a recorded snapshot is still worth showing.
    public static func snapshotIsFresh(
        capturedAtMs: Double, nowMs: Double, maxAgeMs: Double = Codex.snapshotMaxAgeMs
    ) -> Bool {
        let age = nowMs - capturedAtMs
        return age >= 0 && age <= maxAgeMs
    }
}
