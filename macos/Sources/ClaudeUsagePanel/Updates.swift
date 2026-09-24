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
    /// tags only".
    static func latestPublishedVersion() -> String? {
        let r = Shell.run(
            "/usr/bin/git", ["ls-remote", "--tags", "--refs", releasesURL + ".git", "v*"])
        guard r.ok else { return nil }
        let versions = r.out.split(separator: "\n").compactMap { line -> String? in
            guard
                let tag = line.split(separator: "\t").last?
                    .replacingOccurrences(of: "refs/tags/v", with: "")
            else { return nil }
            let parts = tag.split(separator: ".")
            guard parts.count == 3, parts.allSatisfy({ $0.allSatisfy(\.isNumber) }) else {
                return nil
            }
            return tag
        }
        return versions.max { UpdateStatus.isOlder($0, than: $1) }
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
