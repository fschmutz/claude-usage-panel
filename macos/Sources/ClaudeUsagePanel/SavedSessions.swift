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
    /// The scheduled autosave is paused until the next boot
    /// (`claudectl session autosave pause`): the dropdown's banner and the
    /// menu-bar gauge's pause mark.
    @Published private(set) var paused = false
    @Published private(set) var pausedSince: Date?
    private var busy = false

    /// The launchd agent `./install.sh cli` loads (scripts/install/cli.sh).
    static let agentLabel = "io.github.fschmutz.claude-usage-panel.autosave"

    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    private static var store: URL {
        home.appendingPathComponent("Library/Application Support/claude-usage-panel/tabs")
    }
    /// `claudectl session autosave pause` writes it; only the CLI does.
    private static var pauseFile: URL {
        home.appendingPathComponent(
            "Library/Application Support/claude-usage-panel/autosave-paused.json")
    }
    /// This boot's start, epoch ms: `kern.boottime`, what the CLI reads too.
    private static let bootAtMs: Double? = {
        var tv = timeval()
        var size = MemoryLayout<timeval>.size
        guard sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0 else { return nil }
        return Double(tv.tv_sec) * 1000 + Double(tv.tv_usec / 1000)
    }()
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
        let pause = Snapshots.pauseState(
            (try? Data(contentsOf: Self.pauseFile)).flatMap {
                try? JSONSerialization.jsonObject(with: $0)
            }, bootAtMs: Self.bootAtMs)
        paused = pause.paused
        pausedSince = pause.sinceMs.map { Date(timeIntervalSince1970: $0 / 1000) }
        autosave = autosaveLine()
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

    // What the Settings row says: paused, not loaded (booted out by hand -
    // it comes back at the next login), not installed, or running.
    private func autosaveLine() -> String {
        if let since = pausedSince, paused {
            return "Paused since \(Self.clock.string(from: since)), until restart"
        }
        guard
            FileManager.default.fileExists(
                atPath: LaunchAgent.plistURL(label: Self.agentLabel).path)
        else { return "Not scheduled - run ./install.sh cli" }
        return LaunchAgent.isLoaded(label: Self.agentLabel)
            ? "Every 30 minutes" : "Not running until the next login"
    }

    /// Stop the scheduled autosave until the next boot, or start it again:
    /// the CLI writes the pause, this only reads it back.
    func setPaused(_ on: Bool) {
        run(["session", "autosave", on ? "pause" : "resume"]) { _ in nil }
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
