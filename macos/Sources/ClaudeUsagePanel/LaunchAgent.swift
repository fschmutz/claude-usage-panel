import ClaudeUsageCore
import Foundation

/// What the two launchd agents (session pings, daily update check) share: where
/// their plist lives, how the script they run is read back out of it, and the
/// bootout / bootstrap idiom - the same one install.sh's launchd branch uses.
enum LaunchAgent {
    static func plistURL(label: String) -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    /// The script an installed agent runs, when its plist exists and the path
    /// is still executable.
    static func runner(label: String) -> String? {
        guard let data = try? Data(contentsOf: plistURL(label: label)),
            let obj = try? PropertyListSerialization.propertyList(
                from: data, options: [], format: nil) as? [String: Any],
            let args = obj["ProgramArguments"] as? [String],
            let path = SessionPingAgent.runner(in: args),
            FileManager.default.isExecutableFile(atPath: path)
        else { return nil }
        return path
    }

    static func bootout(label: String) {
        _ = Shell.run("/bin/launchctl", ["bootout", "gui/\(getuid())/\(label)"])
    }

    /// (Re)load the agent at `url`: bootstrap, with the `load -w` fallback for
    /// older macOS.
    static func bootstrap(_ url: URL) -> Bool {
        Shell.run("/bin/launchctl", ["bootstrap", "gui/\(getuid())", url.path]).ok
            || Shell.run("/bin/launchctl", ["load", "-w", url.path]).ok
    }
}
