import Foundation

// The session snapshots `claudectl session` keeps (claude-code/tabs.js), as the
// Settings window shows them. The CLI owns the store - one JSON file per label,
// {version, savedAt, sessions: [{name, cwd, session_id}]} - and this only
// reads it. Mirrors the GNOME extension's lib/pure/snapshots.js and is pinned
// to it by tests/fixtures/snapshots.json.

public enum Snapshots {
    /// Autosaves are the ones the 30-minute schedule writes.
    public static let autoPrefix = "auto-"

    public struct Entry: Equatable, Sendable {
        public let label: String
        /// Milliseconds since the epoch, 0 when the file has none.
        public let savedAtMs: Double
        public let names: [String]
    }

    public struct Summary: Equatable, Sendable {
        public let count: Int
        public let autos: Int
        public let newest: Entry?
    }

    /// Summarise parsed snapshot files, newest first by savedAt, then label in
    /// reverse code-point order. `json` is the parsed file, nil when unreadable.
    public static func summarize(_ files: [(label: String, json: Any?)]) -> Summary {
        let valid: [Entry] = files.compactMap { file in
            guard let obj = file.json as? [String: Any],
                let sessions = obj["sessions"] as? [[String: Any]]
            else { return nil }
            let savedAt = (obj["savedAt"] as? NSNumber)?.doubleValue ?? 0
            return Entry(
                label: file.label, savedAtMs: savedAt,
                names: sessions.map { $0["name"] as? String ?? "" })
        }
        .sorted {
            $0.savedAtMs != $1.savedAtMs
                ? $0.savedAtMs > $1.savedAtMs
                : $1.label.unicodeScalars.lexicographicallyPrecedes($0.label.unicodeScalars)
        }
        return Summary(
            count: valid.count,
            autos: valid.filter { $0.label.hasPrefix(autoPrefix) }.count,
            newest: valid.first)
    }
}
