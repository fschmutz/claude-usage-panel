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
