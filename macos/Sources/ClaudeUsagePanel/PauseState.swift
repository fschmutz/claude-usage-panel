import ClaudeUsageCore
import Foundation

/// Pause / resume the live Claude Code sessions from the popup. The CLI owns
/// the store and the hooks (`./install.sh pause`): every action runs the
/// installed `claudectl session pause | resume … --from macos`, and the rows
/// come from `claudectl session pause-status --json`, read through
/// ClaudeUsageCore.Pause. Every child runs off the main actor.
@MainActor
final class PauseState: ObservableObject {
    /// Off by default, like the GNOME `pause-enabled`; with it off nothing is
    /// read and no child is spawned. `./install.sh pause` turns it on.
    @Published var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "pauseEnabled")
            Task { await refresh() }
        }
    }
    @Published private(set) var status: PauseStatus?
    @Published private(set) var rows: [PausePanelRow] = []
    @Published private(set) var busy = false
    /// The CLI's complaint when the last action failed.
    @Published private(set) var actionError: String?
    /// Why the rows could not be read (claudectl missing or failing).
    @Published private(set) var readError: String?
    private var followTask: Task<Void, Never>?

    /// How long the popup follows a request it sent: the CLI's own default wait.
    private static let followSeconds = 180

    init() {
        enabled = UserDefaults.standard.bool(forKey: "pauseEnabled")
    }

    /// The shim `./install.sh cli` writes (`./install.sh pause` installs it).
    nonisolated private static var cli: String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/bin/claudectl").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    var canAct: Bool { enabled && !busy && Self.cli != nil }

    /// "pause 14:05 · 5/7 safe", or nil before the first request.
    var summaryLine: String? {
        guard let st = status, let request = st.request else { return nil }
        let at = Date(timeIntervalSince1970: request.at / 1000)
        let clock = DateFormatter.localizedString(from: at, dateStyle: .none, timeStyle: .short)
        let state = st.summary.done ? "" : " · in progress"
        return "\(request.kind.rawValue) \(clock) · \(st.summary.label)\(state)"
    }

    func refresh() async {
        guard enabled else {
            status = nil
            rows = []
            readError = nil
            actionError = nil
            return
        }
        guard let cli = Self.cli else {
            status = nil
            rows = []
            readError = "claudectl is not installed - run ./install.sh pause"
            return
        }
        let (st, live) = await Task.detached(priority: .utility) {
            () -> (PauseStatus?, [Waiting.LiveSession]) in
            let r = Shell.run(
                cli, ["session", "pause-status", "--json"], env: Shell.toolEnvironment)
            var raw: Any?
            if r.ok { raw = try? JSONSerialization.jsonObject(with: Data(r.out.utf8)) }
            return (Pause.parseStatus(raw), WaitingStore.liveSessions())
        }.value
        status = st
        rows = Pause.panelRows(status: st, live: live)
        readError = st == nil ? "claudectl session pause-status failed" : nil
    }

    func pauseAll() { send(["session", "pause", "--all"]) }

    /// By session id, never by name: two clones of one repo share a basename.
    func pause(_ row: PausePanelRow) { send(["session", "pause", row.sessionId]) }

    /// Running sessions get the resume protocol; closed ones with a pending
    /// checkpoint reopen in a terminal (the CLI's `session open` path).
    func resumeAll() { send(["session", "resume", "--all"]) }

    private func send(_ args: [String]) {
        guard canAct, let cli = Self.cli else { return }
        busy = true
        actionError = nil
        Task {
            let failure = await Task.detached(priority: .userInitiated) { () -> String? in
                let r = Shell.run(
                    cli, args + ["--no-wait", "--from", "macos"], env: Shell.toolEnvironment,
                    mergeStderr: true)
                if r.ok { return nil }
                let lines = r.out.split(separator: "\n").map(String.init)
                return lines.last(where: { !$0.isEmpty }) ?? "claudectl exited \(r.status)"
            }.value
            busy = false
            actionError = failure
            follow()
        }
    }

    /// Re-read every 2 s until every row is terminal or the CLI's wait is up,
    /// so the rows move from pending to delivered to SAFE while it is open.
    private func follow() {
        followTask?.cancel()
        followTask = Task { [weak self] in
            for _ in 0..<(Self.followSeconds / 2) {
                guard let self, !Task.isCancelled else { return }
                await self.refresh()
                if self.status?.summary.done ?? true { return }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }
}
