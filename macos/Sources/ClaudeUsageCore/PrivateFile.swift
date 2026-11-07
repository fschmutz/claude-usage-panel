import Foundation

/// The one private, atomic file write every credential store in the app uses
/// (the account store and the Codex vault), the twin of the Node port's
/// claude-code/private-fs.js `writePrivate`. One copy, so a hardening lands in
/// every store at once.
///
/// The tmp file is CREATED 0600 with open(O_CREAT | O_EXCL): the secret never
/// sits in a wider-moded file, not even for an instant (which is what
/// `createFile(attributes:)` does, applying the mode after the bytes), and a
/// tmp path someone planted, a symlink included, fails the write instead of
/// receiving it. Its name carries a random part, so it cannot be predicted
/// either. rename(2) then swaps the inode, so the result is 0600 even when
/// the file it replaces was not (`replaceItemAt` keeps the old mode).
public enum PrivateFile {
    public struct WriteError: LocalizedError, Equatable {
        public let path: String
        public var errorDescription: String? { "could not write \(path)" }
    }

    /// Write `data` to `url` atomically, owner-only. The directory is created
    /// 0700 when missing.
    public static func write(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        do {
            try fm.createDirectory(
                at: dir, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            throw WriteError(path: url.path)
        }
        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).\(token).tmp")
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw WriteError(path: url.path) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        do {
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            try? handle.close()
            unlink(tmp.path)
            throw WriteError(path: url.path)
        }
        guard rename(tmp.path, url.path) == 0 else {
            unlink(tmp.path)
            throw WriteError(path: url.path)
        }
    }

    /// Where a write to `url` should land: the file a symlink at `url` points
    /// to (the whole chain, like realpath(3)), else `url` itself. Renaming
    /// over a symlink replaces the LINK with a regular file, which silently
    /// detaches a dotfile manager's ~/.claude.json from the copy it tracks.
    public static func resolved(_ url: URL) -> URL {
        guard let real = realpath(url.path, nil) else { return url }
        defer { free(real) }
        return URL(fileURLWithPath: String(cString: real))
    }
}
