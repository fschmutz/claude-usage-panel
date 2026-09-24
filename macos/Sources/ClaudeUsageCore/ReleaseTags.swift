import Foundation

/// The newest released version in a git smart-HTTP ref advertisement, the body
/// of `GET <repo>.git/info/refs?service=git-upload-pack`. That is the same ref
/// list `git ls-remote` reads, fetched over HTTPS so the app never runs
/// /usr/bin/git: on a Mac without the Command Line Tools that path is the
/// xcode-select shim, which opens the "install developer tools" dialog on every
/// hourly check. Mirrors latest_remote_version in scripts/auto-update.sh:
/// released vX.Y.Z tags only, peeled `^{}` entries ignored.
public enum ReleaseTags {
    /// Each ref line is `<4 hex length><sha> <ref>`, the first one followed by
    /// NUL and the capability list, so the ref is the last space-separated
    /// token before any NUL.
    public static func versions(inAdvertisement body: String) -> [String] {
        body.split(whereSeparator: \.isNewline).compactMap { raw -> String? in
            let line =
                raw.split(separator: "\0", maxSplits: 1, omittingEmptySubsequences: false)
                .first ?? ""
            guard let ref = line.split(separator: " ").last,
                ref.hasPrefix("refs/tags/v")
            else { return nil }
            let tag = String(ref.dropFirst("refs/tags/v".count))
            let parts = tag.split(separator: ".", omittingEmptySubsequences: false)
            guard parts.count == 3,
                parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isASCII && $0.isNumber } })
            else { return nil }
            return tag
        }
    }

    public static func latest(inAdvertisement body: String) -> String? {
        versions(inAdvertisement: body).max { UpdateStatus.isOlder($0, than: $1) }
    }
}
