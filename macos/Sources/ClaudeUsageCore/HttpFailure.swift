import Foundation

// HTTP failures from the usage endpoint. A bare "HTTP 424" on the card told
// nobody what the server said; the body carries `{error: {type, message}}` and
// that goes on screen. Statuses that mean "not now" (424 Failed Dependency -
// an upstream of the endpoint failed - 408, 425, 429, 5xx) are transient: the
// last good cards stay up instead of the whole popup blanking on one bad poll.
// Mirrors the GNOME extension's lib/pure.js (httpFailure / isTransientStatus).

public struct HttpFailure: Equatable, Sendable {
    public let status: Int
    public let transient: Bool
    /// "HTTP 424 failed_dependency: <server message>" - the server's words
    /// when it gave any, the code alone otherwise.
    public let message: String

    /// True when the status is worth retrying as-is, with the last data kept.
    public static func isTransient(_ status: Int) -> Bool {
        [408, 424, 425, 429].contains(status) || (500...599).contains(status)
    }

    public init(status: Int, body: Data?) {
        self.status = status
        self.transient = Self.isTransient(status)
        let err =
            body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["error"]
            as? [String: Any]
        let type = (err?["type"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let text = (err?["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let detail = [type, text.flatMap { $0.isEmpty ? nil : $0 }].compactMap { $0 }
            .joined(separator: ": ")
        self.message = detail.isEmpty ? "HTTP \(status)" : "HTTP \(status) \(detail)"
    }
}

/// The whole non-2xx contract in one value, so no caller has to remember which
/// status means what. Mirrors `usageFailure()` in lib/pure/usage.js and
/// claude-code/normalize.js; tests/fixtures/usage-endpoint.json pins all three.
public struct UsageFailure: Equatable, Sendable {
    public enum Code: String, Sendable {
        /// 401 / 403: the credentials themselves are finished. Retrying cannot
        /// help, and the panels must stop drawing that account as current.
        case authExpired = "auth_expired"
        /// 408 / 424 / 425 / 429 / 5xx: not now. The last reading stays up.
        case transient
        case httpError = "http_error"
    }

    public let code: Code
    public let signInAgain: Bool
    public let retryable: Bool
    public let message: String

    public init(code: Code, signInAgain: Bool, retryable: Bool, message: String) {
        self.code = code
        self.signInAgain = signInAgain
        self.retryable = retryable
        self.message = message
    }

    /// What every client says when the endpoint refuses the LIVE login's
    /// token. Clients never write that token, so the only cure is Claude
    /// Code's own.
    public static let authExpiredMessage =
        "Claude session expired. Run any Claude Code command to refresh it."

    /// `label` names a saved account in the message; without one the message
    /// is the live login's and carries the refresh hint.
    public init(status: Int, body: Data?, label: String? = nil) {
        if status == 401 || status == 403 {
            self.init(
                code: .authExpired, signInAgain: true, retryable: false,
                message: label.map { "\($0): usage endpoint refused the token" }
                    ?? Self.authExpiredMessage)
            return
        }
        let failure = HttpFailure(status: status, body: body)
        self.init(
            code: failure.transient ? .transient : .httpError,
            signInAgain: false, retryable: failure.transient,
            message: label.map { "\($0): \(failure.message)" } ?? failure.message)
    }
}
