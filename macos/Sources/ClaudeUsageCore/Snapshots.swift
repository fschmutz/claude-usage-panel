import Foundation

// The session snapshots `claudectl session` keeps (claude-code/tabs.js), as the
// Settings window shows them. The CLI owns the store - one JSON file per label,
// {version, savedAt, sessions: [{name, cwd, session_id, window?, tab?}]} - and
// this only reads it (the placement keys are the CLI's, ignored here). Mirrors the GNOME extension's lib/pure/snapshots.js and is pinned
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

    /// How far apart two reads of the boot time may be and still be the same
    /// boot: it is derived from the wall clock, so a clock adjustment moves it
    /// a little; a reboot moves it by at least the previous boot's uptime.
    public static let bootToleranceMs: Double = 60_000

    /// The scheduled autosave's pause, as `claudectl session autosave pause`
    /// wrote it. `expired`: a file from an earlier boot, for the CLI to remove.
    public struct PauseState: Equatable, Sendable {
        public let paused: Bool
        /// When it was paused, epoch ms; nil when not paused.
        public let sinceMs: Double?
        public let expired: Bool
    }

    /// Is the scheduled autosave paused? `json` is the parsed pause file
    /// ({version, at, bootAt}, epoch ms), nil when there is none; `bootAtMs`
    /// this boot's start, nil when unknown. A missing or broken file, or an
    /// unknown boot time, is not paused: a pause that never expires would
    /// silently stop the backups. Mirrors lib/pure/snapshots.js autosavePauseState.
    public static func pauseState(_ json: Any?, bootAtMs: Double?) -> PauseState {
        guard let obj = json as? [String: Any],
            let at = UsageNormalizer.number(obj["at"]),
            let bootAt = UsageNormalizer.number(obj["bootAt"]),
            let bootAtMs, bootAtMs.isFinite
        else { return PauseState(paused: false, sinceMs: nil, expired: false) }
        if abs(bootAt - bootAtMs) > bootToleranceMs {
            return PauseState(paused: false, sinceMs: nil, expired: true)
        }
        return PauseState(paused: true, sinceMs: at, expired: false)
    }
}
