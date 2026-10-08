import ClaudeUsageCore
import Foundation

// Live-session registry + waiting markers on macOS. The join, age and
// reason live in ClaudeUsageCore.Waiting; this reads ~/.claude/sessions
// (or $CLAUDE_CONFIG_DIR/sessions) and raises a session's terminal through
// `claudectl waiting focus` - the same layout terminals.js already uses.

enum WaitingStore {
    private static var registryDir: String {
        SessionPaths.sessionRegistryDir(
            environment: ProcessInfo.processInfo.environment,
            home: FileManager.default.homeDirectoryForCurrentUser.path)
    }

    private static var cli: String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin/claudectl").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// The registry pids `ps` still shows with a claude command line: ONE
    /// `ps` for the whole registry, not one per entry.
    static func livePids(_ pids: [Int]) -> Set<Int> {
        guard !pids.isEmpty else { return [] }
        let r = Shell.run(
            "/bin/ps", ["-o", "pid=,command=", "-p", pids.map(String.init).joined(separator: ",")])
        // ps exits 1 when one of the pids is gone: the listing still holds the rest
        let pattern = #"(^|/)claude(\s|$)|(^|/)@anthropic-ai/claude-code/cli\.m?js(\s|$)"#
        var live = Set<Int>()
        for line in r.out.split(separator: "\n") {
            let parts = line.trimmingCharacters(in: .whitespaces)
                .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2, let pid = Int(parts[0]),
                parts[1].range(of: pattern, options: .regularExpression) != nil
            else { continue }
            live.insert(pid)
        }
        return live
    }

    static func refresh(now: Date = Date()) -> [WaitingSession] {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: registryDir)) ?? []
        var sessions: [Waiting.LiveSession] = []
        var markers: [WaitingMarker] = []
        for name in names {
            let file = (registryDir as NSString).appendingPathComponent(name)
            if Waiting.pid(fromMarkerName: name) != nil {
                if let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
                    let raw = try? JSONSerialization.jsonObject(with: data),
                    let marker = Waiting.parseMarker(raw)
                {
                    markers.append(marker)
                }
                continue
            }
            guard name.hasSuffix(".json"),
                let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["kind"] as? String == "interactive",
                let pid = (obj["pid"] as? NSNumber)?.intValue, pid > 0,
                let sessionId = obj["sessionId"] as? String, !sessionId.isEmpty,
                let cwd = obj["cwd"] as? String, !cwd.isEmpty
            else { continue }
            // The raw name: Waiting.list owns the cwd / session-id fallback.
            sessions.append(
                Waiting.LiveSession(
                    pid: pid, sessionId: sessionId, name: obj["name"] as? String ?? "", cwd: cwd))
        }
        let live = livePids(sessions.map(\.pid))
        return Waiting.list(
            sessions: sessions.filter { live.contains($0.pid) }, markers: markers,
            nowMs: now.timeIntervalSince1970 * 1000)
    }

    /// Raise the session's terminal. Prefers claudectl so the placement is
    /// the same as `claudectl session save`; without it, the kitty pid match.
    /// By pid, never by name: two clones of one repo share a basename.
    static func focus(_ row: WaitingSession) {
        if let cli {
            Shell.launch(cli, ["waiting", "focus", String(row.pid)])
            return
        }
        if let argv = Waiting.focusArgv(Waiting.focusPlan(window: nil, tab: nil, pid: row.pid)),
            let exe = argv.first
        {
            Shell.launch(exe, Array(argv.dropFirst()))
        }
    }
}
