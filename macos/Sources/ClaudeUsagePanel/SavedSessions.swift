import ClaudeUsageCore
import Foundation

/// The `claudectl session` snapshot store as the Settings window shows it. The
/// CLI owns the store and the autosave agent (`./install.sh cli`); this reads
/// both and runs `claudectl session open` for the Reopen button.
@MainActor
final class SavedSessions: ObservableObject {
    @Published private(set) var autosave = ""
    @Published private(set) var newestLine = ""
    @Published private(set) var canReopen = false
    private var busy = false

    /// The launchd agent `./install.sh cli` loads (scripts/install/cli.sh).
    static let agentLabel = "io.github.fschmutz.claude-usage-panel.autosave"

    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    private static var store: URL {
        home.appendingPathComponent("Library/Application Support/claude-usage-panel/tabs")
    }
    /// The shim `./install.sh cli` writes.
    private static var cli: String? {
        let path = home.appendingPathComponent(".local/bin/claudectl").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }
    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    func reload() {
        let fm = FileManager.default
        let names = (try? fm.contentsOfDirectory(atPath: Self.store.path)) ?? []
        let files = names.filter { $0.hasSuffix(".json") }.map {
            name -> (label: String, json: Any?) in
            let data = try? Data(contentsOf: Self.store.appendingPathComponent(name))
            return (
                String(name.dropLast(5)),
                data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            )
        }
        let summary = Snapshots.summarize(files)
        autosave =
            fm.fileExists(atPath: LaunchAgent.plistURL(label: Self.agentLabel).path)
            ? "Every 30 minutes" : "Not scheduled - run ./install.sh cli"
        if Self.cli == nil {
            newestLine = "claudectl is not installed - run ./install.sh cli"
        } else if let newest = summary.newest {
            newestLine = [
                newest.label,
                Self.clock.string(from: Date(timeIntervalSince1970: newest.savedAtMs / 1000)),
                newest.names.joined(separator: ", "),
            ].joined(separator: " · ")
        } else {
            newestLine = "None yet - run claudectl session save, or wait for the autosave"
        }
        canReopen = Self.cli != nil && summary.newest != nil && !busy
    }

    /// Run `claudectl session open` off the main actor and show the CLI's own
    /// last line: what it opened, or why it opened nothing.
    func reopen() {
        guard let cli = Self.cli, !busy else { return }
        busy = true
        canReopen = false
        Task {
            let line = await Task.detached(priority: .userInitiated) { () -> String in
                // A menu-bar app gets launchd's bare PATH; the CLI looks for
                // tmux on it, and Homebrew installs it outside that.
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
                let r = Shell.run(cli, ["session", "open"], env: env, mergeStderr: true)
                return r.out.split(separator: "\n").last.map(String.init) ?? ""
            }.value
            busy = false
            reload()
            if !line.isEmpty { newestLine = line }
        }
    }
}
