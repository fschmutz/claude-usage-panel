import ClaudeUsageCore
import Foundation

// Update status for the Settings UI. Everything comes from
// `scripts/auto-update.sh --status --json` - the very script the daily
// scheduler runs - so the panel can never claim "up to date" while the
// scheduler is quietly refusing to touch the checkout.
enum Updates {
    static let label = "io.github.fschmutz.claude-usage-panel.update"

    /// Locate auto-update.sh. It only exists in a git checkout, so the honest
    /// answer is often nil (a .app installed from a release zip has none) -
    /// the UI says so rather than pretending.
    static func resolveScript() -> String? {
        // The scheduled agent already records the path; trust it first.
        if let path = LaunchAgent.runner(label: label) { return path }
        // Otherwise the session-ping runner, if configured, points at the same
        // checkout's scripts/ directory.
        if let runner = SessionPing.read().runner {
            let candidate = (runner as NSString).deletingLastPathComponent + "/auto-update.sh"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }

    /// Current status, or nil when there is no checkout to inspect.
    static func status() -> UpdateStatus? {
        guard let script = resolveScript() else { return nil }
        let r = Shell.run("/bin/bash", [script, "--status", "--json"])
        guard r.ok else { return nil }
        return UpdateStatus.parse(json: Data(r.out.utf8))
    }

    /// Apply an available update. Returns an error line, or nil on success.
    /// The script does the safety work (fast-forward only, never a dirty or
    /// diverged checkout); this only invokes it.
    static func applyUpdate() -> String? {
        guard let script = resolveScript() else {
            return "No git checkout found - update by re-running the install script."
        }
        return Shell.run("/bin/bash", [script]).ok
            ? nil : "Could not run auto-update.sh - see Console.app."
    }
}
