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

/// Seconds a Retry-After header asks for, or nil when it says nothing usable.
/// The header is either delta-seconds ("120") or an HTTP-date ("Wed, 21 Oct
/// 2015 07:28:00 GMT"); a date already past is 0, never negative. Mirrors
/// `parseRetryAfter()` in lib/pure/usage.js (GNOME + every Node client).
public enum RetryAfter {
    static let httpDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f
    }()

    public static func seconds(_ value: String?, now: Date = Date()) -> Int? {
        guard let v = value?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
        if v.allSatisfy({ $0.isASCII && $0.isNumber }) {
            return Int(v) ?? Int.max
        }
        guard let at = httpDate.date(from: v) else { return nil }
        return max(0, Int(at.timeIntervalSince(now).rounded(.up)))
    }
}

/// The whole non-2xx contract in one value, so no caller has to remember which
/// status means what. Mirrors `usageFailure()` in lib/pure/usage.js (GNOME +
/// every Node client); tests/fixtures/usage-endpoint.json pins both.
public struct UsageFailure: Equatable, Sendable {
    public enum Code: String, Sendable {
        /// 401: the credentials themselves are finished. Retrying cannot
        /// help, and the panels must stop drawing that account as current.
        case authExpired = "auth_expired"
        /// 403: the token is valid but not allowed this endpoint (a
        /// setup-token without the user:profile scope). No refresh cures it,
        /// so the server's words go on screen, not the refresh hint.
        case forbidden
        /// 408 / 424 / 425 / 429 / 5xx: not now. The last reading stays up.
        case transient
        case httpError = "http_error"
    }

    public let code: Code
    public let signInAgain: Bool
    public let retryable: Bool
    public let message: String
    /// What a transient answer's Retry-After asked for, when it was usable.
    public let retryAfterSeconds: Int?

    public init(
        code: Code, signInAgain: Bool, retryable: Bool, message: String,
        retryAfterSeconds: Int? = nil
    ) {
        self.code = code
        self.signInAgain = signInAgain
        self.retryable = retryable
        self.message = message
        self.retryAfterSeconds = retryAfterSeconds
    }

    /// What every client says when the endpoint refuses the LIVE login's
    /// token. Clients never write that token, so the only cure is Claude
    /// Code's own.
    public static let authExpiredMessage =
        "Claude session expired. Run any Claude Code command to refresh it."

    /// `label` names a saved account in the message; without one the message
    /// is the live login's and carries the refresh hint. `retryAfter` is the
    /// raw Retry-After header.
    public init(
        status: Int, body: Data?, label: String? = nil, retryAfter: String? = nil,
        now: Date = Date()
    ) {
        if status == 401 {
            self.init(
                code: .authExpired, signInAgain: true, retryable: false,
                message: label.map { "\($0): usage endpoint refused the token" }
                    ?? Self.authExpiredMessage)
            return
        }
        let failure = HttpFailure(status: status, body: body)
        self.init(
            code: status == 403 ? .forbidden : (failure.transient ? .transient : .httpError),
            signInAgain: false, retryable: failure.transient,
            message: label.map { "\($0): \(failure.message)" } ?? failure.message,
            retryAfterSeconds: failure.transient
                ? RetryAfter.seconds(retryAfter, now: now) : nil)
    }
}
