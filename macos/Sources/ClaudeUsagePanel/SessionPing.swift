import ClaudeUsageCore
import Foundation

// Session pings from the app: reads and writes the same launchd agent as
// `./install.sh sessionping`, so the CLI and the Settings UI stay two
// frontends over one schedule. The plist on disk is the source of truth
// (like LoginItem's SMAppService state) - nothing is kept in UserDefaults.
enum SessionPing {
    static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(SessionPingAgent.label).plist")
    }

    struct State {
        var enabled: Bool
        var schedule: SessionPingSchedule
        var runner: String?
    }

    static func read() -> State {
        guard let data = try? Data(contentsOf: plistURL),
            let parsed = SessionPingAgent.parse(plistData: data)
        else {
            return State(enabled: false, schedule: .default, runner: nil)
        }
        return State(enabled: true, schedule: parsed.schedule, runner: parsed.runner)
    }

    /// The ping worker script. Prefer the path an existing agent already uses
    /// (a git-checkout install), else the copy bundled in the app's Resources
    /// by `install.sh macos`. A bare `swift build` binary has no bundle copy -
    /// the returned nil surfaces as an error line in Settings.
    static func resolveRunner(existing: String?) -> String? {
        if let existing, FileManager.default.isExecutableFile(atPath: existing) {
            return existing
        }
        if let bundled = Bundle.main.url(forResource: "session-ping", withExtension: "sh") {
            // The exec bit can get lost in copies; restore it best-effort.
            try? FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: bundled.path)
            return bundled.path
        }
        return nil
    }

    /// Apply the desired state: write + (re)load the agent, or unload + remove
    /// it. Returns an error line for the Settings UI, nil on success. Same
    /// swallow-and-surface style as LoginItem: the UI just reflects `read()`.
    @discardableResult
    static func apply(enabled: Bool, schedule: SessionPingSchedule) -> String? {
        if !enabled {
            bootout()
            try? FileManager.default.removeItem(at: plistURL)
            return nil
        }
        guard schedule.isValid else {
            return "Invalid schedule: needs at least one HH:MM time and one weekday."
        }
        guard let runner = resolveRunner(existing: read().runner) else {
            return "session-ping.sh not found - reinstall the app (./install.sh macos)."
        }
        let xml = SessionPingAgent.plistXML(schedule: schedule, runner: runner)
        do {
            try FileManager.default.createDirectory(
                at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try xml.write(to: plistURL, atomically: true, encoding: .utf8)
        } catch {
            return "Could not write \(plistURL.path): \(error.localizedDescription)"
        }
        // Reload: bootout then bootstrap, `load -w` fallback for older macOS -
        // the same idiom as install.sh's launchd branch.
        bootout()
        if !launchctl(["bootstrap", "gui/\(getuid())", plistURL.path]) {
            if !launchctl(["load", "-w", plistURL.path]) {
                return "launchctl could not load the agent - see Console.app."
            }
        }
        return nil
    }

    private static func bootout() {
        _ = launchctl(["bootout", "gui/\(getuid())/\(SessionPingAgent.label)"])
    }

    private static func launchctl(_ args: [String]) -> Bool {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        proc.arguments = args
        proc.standardOutput = Pipe()
        proc.standardError = Pipe()
        guard (try? proc.run()) != nil else { return false }
        proc.waitUntilExit()
        return proc.terminationStatus == 0
    }
}
