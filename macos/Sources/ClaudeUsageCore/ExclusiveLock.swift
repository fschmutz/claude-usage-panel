import Foundation

/// The decisions behind the lock-file mutex the Swift side shares with the
/// Node holders (claude-code/excl-lock.js) and scripts/awake-backstop.sh (the
/// Awake `.hold.lock`). The I/O is AwakeStore's; the three interoperate
/// because they follow one protocol:
///
///   - Acquire: create the lock exclusively (O_CREAT | O_EXCL, or a tmp
///     linked into place; EEXIST = held) with a body of exactly two lines:
///     the pid, then an owner token unique to this acquisition.
///   - Stale takeover: create `<lock>.takeover` exclusively (EEXIST = another
///     takeover runs, give up this round; one older than
///     `takeoverStaleSeconds` is a crash leftover, removed, and this round
///     still gives up). Holding it, stat and read the lock again and unlink
///     it only if inode, mtime and body are exactly what was judged stale;
///     then unlink `.takeover` and retry the exclusive create.
///   - Release: read the lock and unlink it only while the body is still
///     exactly ours.
public enum ExclusiveLock {
    /// A `.takeover` guard older than this is a crash leftover.
    public static let takeoverStaleSeconds: TimeInterval = 10

    /// The lock as a caller judged it.
    public struct Snapshot: Equatable, Sendable {
        public let text: String
        public let inode: UInt64
        public let mtimeMs: Double

        public init(text: String, inode: UInt64, mtimeMs: Double) {
            self.text = text
            self.inode = inode
            self.mtimeMs = mtimeMs
        }
    }

    /// The body a holder writes: the pid the backstop reads, then a token
    /// unique to this acquisition.
    public static func body(pid: Int32, token: String) -> String { "\(pid)\n\(token)\n" }

    /// A fresh owner token.
    public static func newToken() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16)).lowercased()
    }

    /// The pid on a lock body's first line, or nil.
    public static func holderPid(_ text: String) -> Int32? {
        let first = text.split(separator: "\n", omittingEmptySubsequences: false).first ?? ""
        guard let pid = Int32(first.trimmingCharacters(in: .whitespaces)), pid > 0 else {
            return nil
        }
        return pid
    }

    /// A holder is gone: its pid no longer exists, or the lock has not been
    /// touched for `staleMs`. `pidAlive` answers for the pid on the body.
    public static func isStale(
        _ snap: Snapshot, nowMs: Double, staleMs: Double, pidAlive: (Int32) -> Bool
    ) -> Bool {
        if let pid = holderPid(snap.text), !pidAlive(pid) { return true }
        return nowMs - snap.mtimeMs > staleMs
    }

    /// Under the takeover guard: the lock is still exactly the one judged
    /// stale (same inode, mtime and body), so unlinking it removes no newer
    /// holder's lock.
    public static func sameAsJudged(judged: Snapshot, now: Snapshot?) -> Bool {
        guard let now else { return false }
        return now.inode == judged.inode && now.mtimeMs == judged.mtimeMs
            && now.text == judged.text
    }

    /// Release only a lock whose body is still exactly ours.
    public static func isOurs(current: String?, mine: String) -> Bool { current == mine }

    /// A `.takeover` guard last modified at `mtimeMs` is a crash leftover.
    public static func takeoverGuardIsStale(mtimeMs: Double, nowMs: Double) -> Bool {
        nowMs - mtimeMs > takeoverStaleSeconds * 1000
    }
}
