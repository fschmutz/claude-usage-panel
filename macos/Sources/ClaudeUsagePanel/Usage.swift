import ClaudeUsageCore
import Foundation

// The usage fetch, behind one small protocol. The pure model + normalization +
// the whole status-to-meaning mapping live in ClaudeUsageCore (unit-tested on
// Linux CI, no network); the live login is read through AccountStore, the one
// reader of Claude Code's credentials in this app.
//
// Why a protocol for a single GET: everything above it - the poll loop, the
// per-account rows, the auto-switch - is decided by what this call answers,
// and none of that could be exercised without reaching api.anthropic.com with
// a real bearer token. A caller now injects an endpoint instead.

struct UsageResult: Sendable {
    let cards: [LimitCard]
    /// Prepaid credits charged beyond the plan; nil unless the account has
    /// extra usage enabled. Money, so it is not one of the cards.
    let extraUsage: ExtraUsage?
    /// The live login's plan ("Max 20x"), from its credentials: the usage
    /// endpoint names none. Nil for a saved account's token.
    let planLabel: String?
}

/// Why a usage fetch produced nothing. `code` is the same string the Node
/// store files its failures under, so `Notices.health` reads a broken login
/// identically in every port.
enum UsageError: LocalizedError {
    case noToken
    /// The endpoint answered, and said no (ClaudeUsageCore.UsageFailure).
    case endpoint(UsageFailure)
    /// The request never completed: DNS, offline, timeout.
    case network(String)
    /// A 2xx whose body was not the JSON object we asked for.
    case parse(String)

    var errorDescription: String? {
        switch self {
        case .noToken: return "No Claude credentials found. Sign in with Claude Code."
        case .endpoint(let f): return f.message
        case .network(let m): return m
        case .parse(let m): return m
        }
    }

    /// A "not now" answer (424, 429, 5xx) or a dropped connection: the last
    /// good reading stays up while the next poll retries.
    var isTransient: Bool {
        switch self {
        case .endpoint(let f): return f.retryable
        case .network: return true
        case .noToken, .parse: return false
        }
    }

    /// No amount of retrying fixes this one - the credentials are finished.
    var signInAgain: Bool {
        if case .endpoint(let f) = self { return f.signInAgain }
        return false
    }

    var code: String {
        switch self {
        case .noToken: return "no_token"
        case .endpoint(let f): return f.code.rawValue
        case .network: return "network_error"
        case .parse: return "parse_error"
        }
    }
}

/// The one thing the app needs from the usage endpoint. `label` names a saved
/// account in any failure message; nil means the live login, whose messages
/// carry the "run any Claude Code command" hint instead.
protocol UsageEndpoint: Sendable {
    func usage(token: String, label: String?) async throws -> UsageResult
}

/// The real one. The session is EPHEMERAL on purpose: the response carries an
/// OAuth bearer token in its request headers and a full account picture in its
/// body, and a default URLSession would put both in the shared on-disk URL
/// cache and the shared cookie store, outliving the process. Nothing about
/// this call benefits from either.
struct LiveUsageEndpoint: UsageEndpoint {
    static let url = URL(string: "https://api.anthropic.com/api/oauth/usage")!
    static let betaHeader = "oauth-2025-04-20"

    var timeout: TimeInterval = 20

    private var session: URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = timeout
        return URLSession(configuration: config)
    }

    func usage(token: String, label: String?) async throws -> UsageResult {
        var req = URLRequest(url: Self.url)
        req.httpMethod = "GET"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue(Self.betaHeader, forHTTPHeaderField: "anthropic-beta")
        req.timeoutInterval = timeout

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw UsageError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw UsageError.endpoint(UsageFailure(status: status, body: data, label: label))
        }
        guard let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw UsageError.parse("Usage endpoint returned invalid JSON")
        }
        return UsageResult(
            cards: UsageNormalizer.normalize(payload),
            extraUsage: ExtraUsage.normalize(payload),
            planLabel: nil)
    }
}

enum ClaudeUsage {
    /// The endpoint the app runs on. One value, immutable, so it is safe to
    /// share across actors; anything that wants a different one takes it as a
    /// parameter (UsageModel does).
    static let live: any UsageEndpoint = LiveUsageEndpoint()

    /// The live login's OAuth block (access token, plan) - the credentials
    /// file under the Claude config dir, else the login Keychain item, exactly
    /// as the account store reads them.
    static func readLiveOAuth() -> [String: Any]? {
        AccountStore.readLiveCredentials()?["claudeAiOauth"] as? [String: Any]
    }

    /// Usage for the live login: its own token, and the plan label only it can
    /// supply (the endpoint names no plan).
    static func fetchLive(_ endpoint: any UsageEndpoint = live) async throws -> UsageResult {
        let oauth = readLiveOAuth()
        guard let token = oauth?["accessToken"] as? String, !token.isEmpty else {
            throw UsageError.noToken
        }
        let result = try await endpoint.usage(token: token, label: nil)
        return UsageResult(
            cards: result.cards, extraUsage: result.extraUsage,
            planLabel: oauth.map { PlanLabel.label(oauth: $0) })
    }
}
