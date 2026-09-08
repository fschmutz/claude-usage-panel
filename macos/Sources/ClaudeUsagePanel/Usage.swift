import ClaudeUsageCore
import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking  // URLSession lives here on Linux
#endif

// Networking + credential I/O. The pure model + normalization live in
// ClaudeUsageCore (unit-tested). Read-only - we never write the credentials.

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

    private static var credentialsURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/.credentials.json")
    }

    /// Read the OAuth access token. On Linux it lives in
    /// ~/.claude/.credentials.json; on macOS, Claude Code stores it in the
    /// login Keychain, so we fall back to that.
    static func readAccessToken() -> String? {
        if let data = try? Data(contentsOf: credentialsURL),
            let token = tokenFromJSON(data)
        {
            return token
        }
        #if os(macOS)
            return tokenFromKeychain()
        #else
            return nil
        #endif
    }

    /// Parse an access token out of the credentials JSON blob (file or Keychain).
    private static func tokenFromJSON(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        // Token may sit under `claudeAiOauth` or at the top level.
        let oauth = (json["claudeAiOauth"] as? [String: Any]) ?? json
        return (oauth["accessToken"] as? String)
            ?? (oauth["access_token"] as? String)
            ?? (oauth["token"] as? String)
    }

    #if os(macOS)
        /// Claude Code stores its credentials JSON as a generic-password Keychain
        /// item on macOS. `security find-generic-password -w` prints the secret.
        private static func tokenFromKeychain() -> String? {
            for service in ["Claude Code-credentials", "Claude Code", "claude"] {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/bin/security")
                proc.arguments = ["find-generic-password", "-s", service, "-w"]
                let out = Pipe()
                proc.standardOutput = out
                proc.standardError = Pipe()
                guard (try? proc.run()) != nil else { continue }
                let data = out.fileHandleForReading.readDataToEndOfFile()
                proc.waitUntilExit()
                guard proc.terminationStatus == 0 else { continue }
                let raw = String(decoding: data, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let token = tokenFromJSON(Data(raw.utf8)) { return token }
            }
            return nil
        }
    #endif

    /// Fetch usage from the endpoint.
    static func fetch() async throws -> UsageResult {
        guard let token = readAccessToken() else { throw UsageError.noToken }

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
