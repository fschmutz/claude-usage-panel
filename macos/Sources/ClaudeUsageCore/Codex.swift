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

/// `accountId` is the ChatGPT WORKSPACE: every member of a Team workspace
/// shares it, so it never identifies a login on its own. `userId` is the
/// person. A login is the pair (see `Codex.sameLogin`).
public struct CodexIdentity: Equatable, Sendable {
    public let email: String?
    public let accountId: String?
    public let userId: String?
    public let plan: String?
    public let planLabel: String

    public init(
        email: String?, accountId: String?, userId: String? = nil, plan: String?,
        planLabel: String
    ) {
        self.email = email
        self.accountId = accountId
        self.userId = userId
        self.plan = plan
        self.planLabel = planLabel
    }
}

/// Why there are no Codex figures. Never "0%".
public enum CodexUnavailable: String, Sendable {
    case noSessions = "no_sessions"
    case noSnapshot = "no_snapshot"
    case stale
}

/// The freshest usage Codex recorded, or the reason there is none.
public struct CodexRecordedUsage: Sendable {
    public let cards: [LimitCard]
    public let capturedAt: Date?
    public let reason: CodexUnavailable?

    public init(cards: [LimitCard], capturedAt: Date?, reason: CodexUnavailable?) {
        self.cards = cards
        self.capturedAt = capturedAt
        self.reason = reason
    }
}

/// One transcript tail, and its modification time as the fallback stamp.
public struct CodexTranscriptTail: Sendable {
    public let text: String
    public let mtimeMs: Double

    public init(text: String, mtimeMs: Double) {
        self.text = text
        self.mtimeMs = mtimeMs
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

    /// Who a Codex auth blob belongs to, from the token claims: the user id
    /// is chatgpt_user_id, else user_id, from the id token, else from the
    /// access token.
    public static func identity(_ auth: [String: Any]?) -> CodexIdentity {
        let tokens = auth?["tokens"] as? [String: Any] ?? [:]
        let claims = jwtClaims(tokens["id_token"] as? String) ?? [:]
        let ns = claims[authClaim] as? [String: Any] ?? [:]
        let accessNs =
            jwtClaims(tokens["access_token"] as? String)?[authClaim] as? [String: Any] ?? [:]
        let str = { (v: Any?) -> String? in
            guard let s = v as? String, !s.isEmpty else { return nil }
            return s
        }
        let plan = str(ns["chatgpt_plan_type"])
        return CodexIdentity(
            email: str(claims["email"]),
            accountId: str(tokens["account_id"]) ?? str(ns["chatgpt_account_id"]),
            userId: str(ns["chatgpt_user_id"]) ?? str(ns["user_id"])
                ?? str(accessNs["chatgpt_user_id"]) ?? str(accessNs["user_id"]),
            plan: plan, planLabel: planLabel(plan))
    }

    /// Whether two identities are the same login. Two different workspaces
    /// never are. Within one, the user id decides when both carry one; the
    /// email only when one of them has no user id. An account id alone
    /// matches nothing: it names a workspace, not a person.
    public static func sameLogin(_ a: CodexIdentity, _ b: CodexIdentity) -> Bool {
        if let x = a.accountId, let y = b.accountId, x != y { return false }
        if let x = a.userId, let y = b.userId { return x == y }
        guard let x = a.email, let y = b.email else { return false }
        return x.lowercased() == y.lowercased()
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
        if let exp = UsageNormalizer.number(jwtClaims(tokens["access_token"] as? String)?["exp"]),
            exp * 1000 - nowMs > leadMs
        {
            return .valid
        }
        return .stale
    }

    /// Which saved Codex profile a live auth blob is (see `sameLogin`).
    public static func activeName(profiles: [CodexProfile], live: [String: Any]?) -> String? {
        let id = identity(live)
        return profiles.first(where: { sameLogin(identity($0.auth), id) })?.name
    }

    public static func sortedByName(_ profiles: [CodexProfile]) -> [CodexProfile] {
        profiles.sorted { $0.name.unicodeScalars.lexicographicallyPrecedes($1.name.unicodeScalars) }
    }

    // MARK: usage, honestly

    /// A JSON number, or nil: strings, booleans and non-finite values are not.
    static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, !Accounts.isJSONBool(n), n.doubleValue.isFinite else {
            return nil
        }
        return n.doubleValue
    }

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

    /// When one window resets, in epoch ms: `resets_at` (epoch seconds)
    /// first, else the legacy `resets_in_seconds` from the capture.
    static func slotResetMs(_ slot: [String: Any], capturedAtMs: Double) -> Double? {
        if let at = number(slot["resets_at"]) { return at * 1000 }
        return number(slot["resets_in_seconds"]).map { capturedAtMs + $0 * 1000 }
    }

    /// The cards for one rate-limit snapshot the Codex CLI recorded. Empty
    /// when the snapshot carries nothing usable - there is no third option in
    /// which a number is made up. With `nowMs`, a window that has reset by
    /// then is dropped: its percent measured a window that no longer exists.
    public static func normalizeLimits(
        _ rateLimits: [String: Any]?, capturedAtMs: Double, nowMs: Double? = nil
    ) -> [LimitCard] {
        var out: [LimitCard] = []
        for (key, group) in [("primary", "session"), ("secondary", "weekly")] {
            guard let slot = rateLimits?[key] as? [String: Any],
                let used = number(slot["used_percent"])
            else { continue }
            let resetMs = slotResetMs(slot, capturedAtMs: capturedAtMs)
            if let nowMs, let resetMs, resetMs <= nowMs { continue }
            out.append(
                LimitCard(
                    id: "codex_\(key)",
                    label: windowLabel(number(slot["window_minutes"])),
                    percent: UsageNormalizer.clampPercent(used), severity: .normal,
                    resetsAt: resetMs.map { Date(timeIntervalSince1970: $0 / 1000) },
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

    /// The last `rate_limits` object in the tail of one transcript, and when
    /// its event was written. Lines are scanned from the end; one that is not
    /// JSON (the cut first line of a tail, a partial write) is skipped, and
    /// so is one whose `rate_limits` is not an object.
    public static func lastRateLimits(_ text: String) -> (
        limits: [String: Any], capturedAtMs: Double?
    )? {
        for line in text.split(separator: "\n", omittingEmptySubsequences: false).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("{"), trimmed.contains("rate_limits"),
                let event = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))
                    as? [String: Any]
            else { continue }
            let payload = event["payload"] as? [String: Any] ?? [:]
            let raw = payload["rate_limits"] ?? event["rate_limits"]
            guard let limits = raw as? [String: Any] else { continue }
            let stamp = event["timestamp"] as? String ?? payload["timestamp"] as? String
            let at = UsageNormalizer.parseDate(stamp).map { $0.timeIntervalSince1970 * 1000 }
            return (limits, at)
        }
        return nil
    }

    /// The freshest usage Codex has recorded, from the tails of its newest
    /// transcripts (newest first). `stale`: the newest reading is older than
    /// `snapshotMaxAgeMs`, or every window it measured has reset since.
    public static func pickRecorded(_ files: [CodexTranscriptTail], nowMs: Double)
        -> CodexRecordedUsage
    {
        guard !files.isEmpty else {
            return CodexRecordedUsage(cards: [], capturedAt: nil, reason: .noSessions)
        }
        for file in files {
            guard let found = lastRateLimits(file.text) else { continue }
            let capturedMs = found.capturedAtMs ?? file.mtimeMs
            let captured = Date(timeIntervalSince1970: capturedMs / 1000)
            guard snapshotIsFresh(capturedAtMs: capturedMs, nowMs: nowMs) else {
                return CodexRecordedUsage(cards: [], capturedAt: captured, reason: .stale)
            }
            // Nothing readable in it: an older transcript may still have one.
            if normalizeLimits(found.limits, capturedAtMs: capturedMs).isEmpty { continue }
            let cards = normalizeLimits(found.limits, capturedAtMs: capturedMs, nowMs: nowMs)
            return CodexRecordedUsage(
                cards: cards, capturedAt: captured, reason: cards.isEmpty ? .stale : nil)
        }
        return CodexRecordedUsage(cards: [], capturedAt: nil, reason: .noSnapshot)
    }
}

// MARK: switching without losing a rotated token

/// What `Codex.guardedSwitch` did. `busy`: the live auth.json changed on
/// every try, and nothing was written.
public enum CodexSwitchOutcome {
    case unsaved(live: [String: Any])
    case already(from: String)
    case switched(from: String?)
    case busy(from: String?)
}

/// One entry of a directory under sessions/, as `Codex.scanSessions` asks.
public struct CodexDirEntry: Sendable {
    public let name: String
    public let isDirectory: Bool
    public let mtimeMs: Double?

    public init(name: String, isDirectory: Bool, mtimeMs: Double?) {
        self.name = name
        self.isDirectory = isDirectory
        self.mtimeMs = mtimeMs
    }
}

extension Codex {
    /// How many times a switch re-syncs a live login that keeps changing
    /// before it gives up rather than overwrite a token it has not kept.
    public static let switchSyncTries = 3

    /// The switch sequence, over the store's own I/O. The codex CLI refreshes
    /// its tokens in place, without a lock: a refresh landing between the
    /// sync-back and the write would leave the rotated refresh token only in
    /// the file being overwritten. So the live file is read again right before
    /// the write, and when it moved the new one is synced first.
    /// `syncBack` writes the live login into its profile and returns which one
    /// it was and the blob it read; `write` installs the target.
    public static func guardedSwitch(
        to target: String, tries: Int = switchSyncTries,
        syncBack: () throws -> (name: String?, auth: [String: Any]?),
        readLive: () -> [String: Any]?, write: () throws -> Void
    ) rethrows -> CodexSwitchOutcome {
        var from: String?
        for _ in 0..<tries {
            let synced = try syncBack()
            from = synced.name
            if let live = synced.auth, from == nil { return .unsaved(live: live) }
            if let from, from == target { return .already(from: from) }
            let now = readLive()
            let unchanged =
                now == nil && synced.auth == nil
                || now.map { n in synced.auth.map { Accounts.sameJSON(n, $0) } ?? false } ?? false
            if !unchanged { continue }
            try write()
            return .switched(from: from)
        }
        return .busy(from: from)
    }

    // MARK: which transcripts to read

    /// How many recent transcripts to look through before giving up.
    public static let sessionScanLimit = 8
    /// How many directories below sessions/ a transcript may sit: the three
    /// date levels (YYYY/MM/DD) plus one spare.
    public static let sessionsMaxDepth = 4

    /// The newest transcripts under sessions/, newest mtime first (ties by
    /// path), at most `limit`. Directories are descended in descending name
    /// order (the newest day first), descent stops once `limit` files are in
    /// hand, and never goes more than `maxDepth` directories deep. `list` is
    /// handed the path segments below sessions/ and returns that directory's
    /// entries ([] when unreadable). Paths come back '/'-joined, relative.
    public static func scanSessions(
        limit: Int = sessionScanLimit, maxDepth: Int = sessionsMaxDepth,
        list: ([String]) -> [CodexDirEntry]
    ) -> [(path: String, mtimeMs: Double)] {
        var found: [(path: String, mtimeMs: Double)] = []
        func codePoint(_ a: String, _ b: String) -> Bool {
            a.unicodeScalars.lexicographicallyPrecedes(b.unicodeScalars)
        }
        func visit(_ segments: [String]) {
            let entries = list(segments).filter { !$0.name.isEmpty }
            for e in entries where !e.isDirectory && e.name.hasSuffix(".jsonl") {
                guard let m = e.mtimeMs, m.isFinite else { continue }
                found.append(((segments + [e.name]).joined(separator: "/"), m))
            }
            guard segments.count < maxDepth else { return }
            let dirs = entries.filter(\.isDirectory).map(\.name).sorted(by: codePoint)
            for name in dirs.reversed() {
                if found.count >= limit { return }
                visit(segments + [name])
            }
        }
        visit([])
        let sorted = found.sorted {
            $0.mtimeMs != $1.mtimeMs ? $0.mtimeMs > $1.mtimeMs : codePoint($0.path, $1.path)
        }
        return Array(sorted.prefix(limit))
    }
}
