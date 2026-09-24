import ClaudeUsageCore
import Foundation

// Update status for the Settings UI. Everything comes from
// `scripts/auto-update.sh --status --json` - the very script the daily
// scheduler runs - so the panel can never claim "up to date" while the
// scheduler is quietly refusing to touch the checkout.
enum Updates {
    static let label = "io.github.fschmutz.claude-usage-panel.update"

    /// The pointer `install.sh` writes on every run. The shell scripts keep
    /// their state under XDG on macOS too, so this is the one path both sides
    /// agree on - and unlike the launchd agent it exists even when the user
    /// opted out of the daily check.
    static var checkoutPointer: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state/claude-usage-panel/checkout-path")
    }

    /// Locate auto-update.sh. It only exists in a git checkout, so the honest
    /// answer is sometimes nil (a .app installed from a release zip has none) -
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
        // No schedule at all: the installer's pointer. Without it, an app built
        // from a checkout whose owner ran `--uninstall autoupdate` reported
        // "No git checkout found" while the checkout sat right there.
        if let root = try? String(contentsOf: checkoutPointer, encoding: .utf8) {
            return scriptInCheckout(root)
        }
        return nil
    }

    /// `<root>/scripts/auto-update.sh`, for a root UpdateStatus accepts and a
    /// file that is actually executable; nil otherwise. The script's name is a
    /// constant here - only the directory can come from the pointer file.
    static func scriptInCheckout(_ pointer: String) -> String? {
        guard let root = UpdateStatus.validatedCheckoutRoot(pointer) else { return nil }
        let candidate = URL(fileURLWithPath: root, isDirectory: true)
            .appendingPathComponent("scripts/auto-update.sh").standardizedFileURL.path
        guard FileManager.default.isExecutableFile(atPath: candidate) else { return nil }
        return candidate
    }

    /// The public repository, for the one install shape that has no checkout:
    /// the .app unzipped from a release asset. It cannot update itself, but it
    /// can at least know that a newer release exists instead of sitting on the
    /// version it was downloaded at forever.
    static let releasesURL = "https://github.com/fschmutz/claude-usage-panel"

    /// Installed by `brew install --cask claude-usage-panel`. Such a build has
    /// no checkout either, but it does have an updater - telling that user to
    /// download a zip by hand would fight Homebrew for the same bundle.
    static var caskRoot: String? {
        ["/opt/homebrew/Caskroom/claude-usage-panel", "/usr/local/Caskroom/claude-usage-panel"]
            .first { FileManager.default.fileExists(atPath: $0) }
    }

    /// Highest released vX.Y.Z tag on the public remote, or nil. Mirrors
    /// latest_remote_version in scripts/auto-update.sh, including "released
    /// tags only". Reads the ref advertisement over HTTPS rather than running
    /// `git ls-remote`: this only runs in the shapes with no checkout, where
    /// /usr/bin/git may be the xcode-select shim that prompts to install the
    /// Command Line Tools. Blocking; callers run it off the main actor.
    static func latestPublishedVersion() -> String? {
        guard let url = URL(string: releasesURL + ".git/info/refs?service=git-upload-pack")
        else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("git/2.0 claude-usage-panel", forHTTPHeaderField: "User-Agent")
        let box = ResponseBox()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let data {
                box.set(String(decoding: data, as: UTF8.self))
            }
            done.signal()
        }.resume()
        done.wait()
        return box.get().flatMap(ReleaseTags.latest(inAdvertisement:))
    }

    /// Hands the response body from URLSession's delegate queue to the waiting
    /// caller.
    private final class ResponseBox: @unchecked Sendable {
        private let lock = NSLock()
        private var body: String?
        func set(_ value: String) { lock.withLock { body = value } }
        func get() -> String? { lock.withLock { body } }
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
        let r = Shell.run("/bin/bash", [script], mergeStderr: true)
        // The script's own last line says what went wrong; "see Console.app"
        // was a dead end for a failure it had already explained.
        return r.ok
            ? nil
            : (r.out.split(separator: "\n").last.map(String.init)
                ?? "Could not run auto-update.sh.")
    }
}
