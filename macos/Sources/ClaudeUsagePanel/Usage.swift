import ClaudeUsageCore
import Foundation

// The usage fetch. The pure model + normalization live in ClaudeUsageCore
// (unit-tested); the live login is read through AccountStore, the one reader
// of Claude Code's credentials in this app.

struct UsageResult {
    let cards: [LimitCard]
    /// Prepaid credits charged beyond the plan; nil unless the account has
    /// extra usage enabled. Money, so it is not one of the cards.
    let extraUsage: ExtraUsage?
    let planLabel: String?
}

enum UsageError: LocalizedError {
    case noToken
    case authExpired
    case http(Int)
    case parse(String)

    var errorDescription: String? {
        switch self {
        case .noToken: return "No Claude credentials found. Sign in with Claude Code."
        case .authExpired: return "Claude session expired. Run any Claude Code command to refresh."
        case .http(let s): return "HTTP \(s)"
        case .parse(let m): return m
        }
    }
}

enum ClaudeUsage {
    private static let endpoint = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    private static let betaHeader = "oauth-2025-04-20"

    /// The live login's access token - the credentials file under the Claude
    /// config dir, else the login Keychain item, exactly as the account store
    /// reads them.
    static func readAccessToken() -> String? {
        let oauth = AccountStore.readLiveCredentials()?["claudeAiOauth"] as? [String: Any]
        return oauth?["accessToken"] as? String
    }

    /// Fetch usage from the endpoint - for the live login by default, or for
    /// any saved account when its token is passed (AccountStore.accessTokenFor).
    static func fetch(token explicit: String? = nil) async throws -> UsageResult {
        guard let token = explicit ?? readAccessToken() else { throw UsageError.noToken }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(betaHeader, forHTTPHeaderField: "anthropic-beta")
        req.timeoutInterval = 20

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 403 { throw UsageError.authExpired }
        guard (200..<300).contains(status) else { throw UsageError.http(status) }

        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw UsageError.parse("Usage endpoint returned invalid JSON")
        }
        return UsageResult(
            cards: UsageNormalizer.normalize(payload),
            extraUsage: ExtraUsage.normalize(payload),
            planLabel: payload["plan_label"] as? String)
    }
}
