import ClaudeUsageCore
import Foundation

// Update status for the Settings UI. Everything comes from
// `scripts/auto-update.sh --status --json` - the very script the daily
// scheduler runs - so the panel can never claim "up to date" while the
// scheduler is quietly refusing to touch the checkout.
enum Updates {
    /// The link `install.sh` writes on every run, to the checkout's
    /// scripts/auto-update.sh. One fixed path: the app never reads a
    /// location out of a file, so nothing user-writable names what it runs.
    /// The shell scripts keep their state under XDG on macOS too.
    static var scriptLink: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state/claude-usage-panel/auto-update.sh").path
    }

    /// The update script, or nil: a .app installed from a release zip has no
    /// checkout, and the UI says so rather than pretending.
    static func resolveScript() -> String? {
        UpdateStatus.trustedScript(link: scriptLink)
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

    /// Run the update script (resolved by trustedScript) from its own
    /// directory, with a constant command line.
    private static func runScript(_ script: String, _ args: [String], mergeStderr: Bool = false)
        -> Shell.Result
    {
        let dir = (script as NSString).deletingLastPathComponent
        return Shell.run(
            "/bin/bash", ["./auto-update.sh"] + args, mergeStderr: mergeStderr, cwd: dir)
    }

    /// Current status, or nil when there is no checkout to inspect.
    static func status() -> UpdateStatus? {
        guard let script = resolveScript() else { return nil }
        let r = runScript(script, ["--status", "--json"])
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
        let r = runScript(script, [], mergeStderr: true)
        // The script's own last line says what went wrong; "see Console.app"
        // was a dead end for a failure it had already explained.
        return r.ok
            ? nil
            : (r.out.split(separator: "\n").last.map(String.init)
                ?? "Could not run auto-update.sh.")
    }
}
