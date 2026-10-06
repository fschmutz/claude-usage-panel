import ClaudeUsageCore
import Foundation

/// The `claudectl session` snapshot store as the Settings window shows it. The
/// CLI owns the store and the autosave agent (`./install.sh cli`); this reads
/// both and runs `claudectl session open` for the Reopen button and
/// `claudectl session autosave --force` for the Save button.
@MainActor
final class SavedSessions: ObservableObject {
    @Published private(set) var autosave = ""
    @Published private(set) var newestLine = ""
    @Published private(set) var canReopen = false
    @Published private(set) var canSave = false
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
        // A forced save with nothing open writes an empty snapshot on purpose:
        // the newest one then means "nothing to reopen", exactly as on GNOME.
        canReopen = Self.cli != nil && !(summary.newest?.names.isEmpty ?? true) && !busy
        canSave = Self.cli != nil && !busy
    }

    /// Run `claudectl session open` off the main actor and show the CLI's own
    /// last line: what it opened, or why it opened nothing.
    func reopen() {
        run(["session", "open"]) { $0.last }
    }

    /// What is open right now becomes the newest snapshot, none included,
    /// instead of at the next 30-minute autosave - which a lid shut in between
    /// never reaches, so threads closed since then came back on Reopen.
    /// Shows "saved auto-... (N sessions)", or the session it could not save.
    func save() {
        run(["session", "autosave", "--force"]) { lines in
            lines.last(where: { $0.hasPrefix("NOT SAVED") }) ?? lines.first
        }
    }

    private func run(_ args: [String], pick: @escaping @Sendable ([String]) -> String?) {
        guard let cli = Self.cli, !busy else { return }
        busy = true
        canReopen = false
        canSave = false
        Task {
            let line = await Task.detached(priority: .userInitiated) { () -> String in
                // A menu-bar app gets launchd's bare PATH; the CLI looks for
                // tmux on it, and Homebrew installs it outside that.
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
                let r = Shell.run(cli, args, env: env, mergeStderr: true)
                return pick(r.out.split(separator: "\n").map(String.init)) ?? ""
            }.value
            busy = false
            reload()
            if !line.isEmpty { newestLine = line }
        }
    }
}
