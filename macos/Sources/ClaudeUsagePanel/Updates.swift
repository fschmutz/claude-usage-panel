import ClaudeUsageCore
import Foundation

// Update status for the Settings UI. Everything comes from
// `scripts/auto-update.sh --status --json` - the very script the daily
// scheduler runs - so the panel can never claim "up to date" while the
// scheduler is quietly refusing to touch the checkout.
enum Updates {
    static let label = "io.github.fschmutz.claude-usage-panel.update"

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    /// True when the daily check is actually scheduled.
    static var scheduled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    /// Locate auto-update.sh. It only exists in a git checkout, so the honest
    /// answer is often nil (a .app installed from a release zip has none) -
    /// the UI says so rather than pretending.
    static func resolveScript() -> String? {
        // The scheduled agent already records the path; trust it first.
        if let data = try? Data(contentsOf: plistURL),
            let obj = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil) as? [String: Any],
            let args = obj["ProgramArguments"] as? [String],
            let path = args.dropFirst().first(where: { !$0.hasPrefix("-") }),
            FileManager.default.isExecutableFile(atPath: path)
        {
            return path
        }
        // Otherwise the session-ping runner, if configured, points at the same
        // checkout's scripts/ directory.
        if let runner = SessionPing.read().runner {
            let candidate = (runner as NSString).deletingLastPathComponent + "/auto-update.sh"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Run a subcommand of auto-update.sh and return its stdout.
    /// `nullDevice` on stderr rather than an unread Pipe: an undrained pipe
    /// deadlocks waitUntilExit() if the child ever fills the buffer.
    private static func run(_ script: String, _ args: [String], timeout: TimeInterval = 90)
        -> String?
    {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [script] + args
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = FileHandle.nullDevice
        guard (try? proc.run()) != nil else { return nil }
        // Read before waiting - the child can block writing into a full pipe.
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return String(data: data, encoding: .utf8)
    }

    /// Current status, or nil when there is no checkout to inspect.
    static func status() -> UpdateStatus? {
        guard let script = resolveScript(),
            let out = run(script, ["--status", "--json"]),
            let s = UpdateStatus.parse(json: Data(out.utf8))
        else { return nil }
        return s
    }

    /// Apply an available update. Returns an error line, or nil on success.
    /// The script does the safety work (fast-forward only, never a dirty or
    /// diverged checkout); this only invokes it.
    static func applyUpdate() -> String? {
        guard let script = resolveScript() else {
            return "No git checkout found - update by re-running the install script."
        }
        guard run(script, [], timeout: 600) != nil else {
            return "Could not run auto-update.sh - see Console.app."
        }
        return nil
    }
}
