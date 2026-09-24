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
    /// Set when there is no checkout to update from but the public repository
    /// has a newer release than this bundle - the .app unzipped from a release
    /// asset, which otherwise had no way of ever hearing about a new version.
    @Published private(set) var downloadable: String?
    private var lastCheck: Date?

    /// This bundle's version, the one a published release is compared against.
    static var bundleVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

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
        guard s == nil else {
            downloadable = nil
            error = nil
            return
        }
        // No checkout: ask the public remote directly, so the row can say
        // "2.3.0 is out" instead of only "this build cannot self-update".
        let mine = Self.bundleVersion
        if Updates.caskRoot != nil {
            let latest = await Task.detached(priority: .utility) {
                Updates.latestPublishedVersion()
            }.value
            downloadable = nil
            error =
                (latest.map { UpdateStatus.isOlder(mine, than: $0) } ?? false)
                ? "Version \(latest ?? "") is available - brew upgrade --cask claude-usage-panel"
                : "Installed with Homebrew - brew upgrade --cask claude-usage-panel keeps it current."
            return
        }
        let latest = await Task.detached(priority: .utility) { Updates.latestPublishedVersion() }
            .value
        downloadable =
            (latest.map { UpdateStatus.isOlder(mine, than: $0) } ?? false) ? latest : nil
        error =
            downloadable.map {
                "Version \($0) is available - download it (this build has no checkout to update from)."
            }
            ?? "No git checkout found - this build cannot self-update."
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
