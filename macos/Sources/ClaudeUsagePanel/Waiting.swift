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

    /// A registry pid is live when `ps` still shows a claude command line.
    static func isAlive(pid: Int) -> Bool {
        let r = Shell.run("/bin/ps", ["-o", "command=", "-p", String(pid)])
        guard r.ok else { return false }
        let cmd = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        return cmd.range(of: #"(^|/)claude(\s|$)|(^|/)@anthropic-ai/claude-code/cli\.m?js(\s|$)"#,
            options: .regularExpression) != nil
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
                let cwd = obj["cwd"] as? String, !cwd.isEmpty,
                isAlive(pid: pid)
            else { continue }
            let fallback = (cwd as NSString).lastPathComponent
            sessions.append(
                Waiting.LiveSession(
                    pid: pid, sessionId: sessionId,
                    name: (obj["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallback,
                    cwd: cwd))
        }
        return Waiting.list(
            sessions: sessions, markers: markers, nowMs: now.timeIntervalSince1970 * 1000)
    }

    /// Raise the session's terminal. Prefers claudectl so the placement is
    /// the same as `claudectl session save`; without it, the kitty pid match.
    static func focus(_ row: WaitingSession) {
        if let cli {
            Shell.launch(cli, ["waiting", "focus", row.name])
            return
        }
        if let argv = Waiting.focusArgv(Waiting.focusPlan(window: nil, tab: nil, pid: row.pid)),
            let exe = argv.first
        {
            Shell.launch(exe, Array(argv.dropFirst()))
        }
    }
}
