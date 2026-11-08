import ClaudeUsageCore
import Foundation

/// What the two launchd agents (session pings, daily update check) share: where
/// their plist lives and the bootout / bootstrap idiom - the same one install.sh's launchd branch uses.
enum LaunchAgent {
    static func plistURL(label: String) -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
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
