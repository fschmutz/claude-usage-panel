import ClaudeUsageCore
import Combine
import Foundation

/// Whether this install is current, as `scripts/auto-update.sh --status`
/// reports it. The script does a `git ls-remote`, so a check is network I/O
/// on the model's own schedule (hourly, and on wake) - never something a view
/// triggers by appearing.
@MainActor
final class UpdateState: ObservableObject {
    @Published private(set) var status: UpdateStatus?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private var lastCheck: Date?

    static let checkInterval: TimeInterval = 3600

    /// Re-read the status if the last check is older than `checkInterval`.
    func checkIfDue(now: Date = Date()) async {
        if let last = lastCheck, now.timeIntervalSince(last) < Self.checkInterval { return }
        await reload()
    }

    /// Re-read the status now. Off the main actor: the git fetch inside the
    /// script can take seconds.
    func reload() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let s = await Task.detached(priority: .utility) { Updates.status() }.value
        lastCheck = Date()
        status = s
        error = s == nil ? "No git checkout found - this build cannot self-update." : nil
    }

    /// Install the available update, then re-read the status.
    func apply() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let (err, s) = await Task.detached(priority: .utility) {
            (Updates.applyUpdate(), Updates.status())
        }.value
        lastCheck = Date()
        error = err
        status = s
    }
}
