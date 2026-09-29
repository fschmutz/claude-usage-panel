import ClaudeUsageCore
import Foundation

// Named OpenAI Codex logins - the I/O half. Mirrors claude-code/codex.js: the
// same store (one 0600 file per saved login under Application Support), the
// same switch, the same refusal to invent a usage number.
//
// A Codex login is ONE file: `auth.json` under the Codex home ($CODEX_HOME,
// else ~/.codex). Switching replaces exactly that file and touches nothing
// else - config.toml, history, MCP servers and sessions stay.
//
// Three rules worth stating out loud, because this type sits next to the one
// that holds Claude credentials:
//   - it never touches a Claude login. Different live file, different store
//     directory, different type.
//   - it never mints a token. OpenAI's refresh grant is the codex CLI's to
//     use, so a stale profile is reported and handed to `codex login`.
//   - it never uploads anything. There is no network client in this file.

enum CodexStore {
    /// Tail of a session transcript read when looking for the last rate-limit
    /// snapshot; the newest events are at the end.
    static let sessionTailBytes = 256 * 1024
    /// How many recent transcripts to look through before giving up: the
    /// contract's, one rule for every port.
    static let sessionScanLimit = Codex.sessionScanLimit

    // MARK: paths

    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    /// The codex CLI's config dir - follows CODEX_HOME, as the Node port does.
    static var codexHome: URL {
        if let dir = ProcessInfo.processInfo.environment["CODEX_HOME"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return home.appendingPathComponent(".codex")
    }

    static var authURL: URL { codexHome.appendingPathComponent("auth.json") }
    static var sessionsURL: URL { codexHome.appendingPathComponent("sessions") }

    /// A directory of its own, next to (never inside) the Claude one.
    static var directory: URL {
        home.appendingPathComponent("Library/Application Support/claude-usage-panel/codex-accounts")
    }

    private static func profileURL(_ name: String) -> URL {
        directory.appendingPathComponent("\(name).json")
    }

    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }
    private static func stamp() -> String { ISO8601DateFormatter().string(from: Date()) }

    // MARK: private, atomic files

    /// A tmp file renamed over `url` with rename(2), as the Node port does:
    /// the inode is swapped, so the result is 0600 even when the file it
    /// replaces (an auth.json the codex CLI wrote 0644) was not.
    /// `replaceItemAt` would keep the replaced file's permissions. The tmp is
    /// CREATED 0600 with open(O_CREAT | O_EXCL): `createFile(attributes:)`
    /// applies the mode after writing, leaving the token in a wider-moded file
    /// for an instant in ~/.codex, and O_EXCL fails on a planted tmp or symlink
    /// instead of writing through it.
    private static func writePrivate(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try fm.createDirectory(
            at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        unlink(tmp.path)
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { throw AccountError.message("could not write \(url.path)") }
        // Through FileHandle: plain write(2) is shadowed by this type's own
        // `write(_:)`.
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        do {
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            try? handle.close()
            unlink(tmp.path)
            throw AccountError.message("could not write \(url.path)")
        }
        guard rename(tmp.path, url.path) == 0 else {
            unlink(tmp.path)
            throw AccountError.message("could not replace \(url.path)")
        }
    }

    private static func readJSON(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func pretty(_ obj: Any) throws -> Data {
        var data = try JSONSerialization.data(
            withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        data.append(0x0a)
        return data
    }

    // MARK: store

    static func list() -> [CodexProfile] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
        else { return [] }
        var out: [CodexProfile] = []
        for file in names where file.hasSuffix(".json") && !file.hasPrefix(".") {
            guard let p = CodexProfile.parse(readJSON(directory.appendingPathComponent(file))),
                "\(p.name).json" == file
            else { continue }
            out.append(p)
        }
        return Codex.sortedByName(out)
    }

    static func read(_ name: String) -> CodexProfile? {
        guard Accounts.isValidName(name),
            let p = CodexProfile.parse(readJSON(profileURL(name))), p.name == name
        else { return nil }
        return p
    }

    @discardableResult
    static func write(_ profile: CodexProfile) throws -> CodexProfile {
        try writePrivate(pretty(profile.toJSON()), to: profileURL(profile.name))
        return profile
    }

    static func remove(_ name: String) throws {
        guard read(name) != nil else {
            throw AccountError.message("no saved Codex account named \(name)")
        }
        try FileManager.default.removeItem(at: profileURL(name))
    }

    // MARK: the live login

    /// The auth.json the codex CLI holds right now, or nil.
    static func readLiveAuth() -> [String: Any]? {
        readJSON(authURL) as? [String: Any]
    }

    static func liveName() -> String? {
        Codex.activeName(profiles: list(), live: readLiveAuth())
    }

    /// Save `auth` (the live login, as read once) under `name`; nil reads it.
    @discardableResult
    private static func snapshotLive(_ name: String, auth given: [String: Any]? = nil) throws
        -> CodexProfile
    {
        guard let auth = given ?? readLiveAuth() else {
            throw AccountError.message("no Codex login to save - run `codex login` first")
        }
        return try write(CodexProfile(name: name, savedAt: stamp(), auth: auth))
    }

    /// `syncBack`, also returning the auth.json it read (and saved).
    private static func syncBackLive() throws -> (name: String?, auth: [String: Any]?) {
        guard let auth = readLiveAuth() else { return (nil, nil) }
        let profiles = list()
        guard let name = Codex.activeName(profiles: profiles, live: auth) else {
            return (nil, auth)
        }
        let stored = profiles.first { $0.name == name }
        // The blob read above, never a second read: the CLI may rotate between.
        if stored == nil || !Accounts.sameJSON(stored!.auth, auth) {
            try snapshotLive(name, auth: auth)
        }
        return (name, auth)
    }

    /// Write the live login back into its own profile, so the tokens the codex
    /// CLI rotated since the last switch are the ones we keep.
    @discardableResult
    static func syncBack() throws -> String? {
        try syncBackLive().name
    }

    @discardableResult
    static func saveCurrent(_ name: String, force: Bool = false) throws -> CodexProfile {
        guard Accounts.isValidName(name) else {
            throw AccountError.message(
                "invalid name \"\(name)\": letters, digits, . _ - only, up to 32 characters")
        }
        guard let auth = readLiveAuth() else {
            throw AccountError.message("no Codex login to save - run `codex login` first")
        }
        let profiles = list()
        if let variant = profiles.first(where: {
            $0.name != name && Accounts.sameName($0.name, name)
        }) {
            throw AccountError.message(
                "\(variant.name) already exists - names ignore case, use \(variant.name)")
        }
        let live = Codex.identity(auth)
        if !force, let existing = profiles.first(where: { $0.name == name }) {
            let held = Codex.identity(existing.auth)
            if !Codex.sameLogin(held, live) {
                throw AccountError.message(
                    "\(name) is already \(held.email ?? "another account") - pick another name")
            }
        }
        if let twin = Codex.activeName(profiles: profiles.filter { $0.name != name }, live: auth) {
            throw AccountError.message(
                "this login (\(live.email ?? "no email")) is already saved as \(twin) - "
                    + "remove \(twin) first if you meant to rename it")
        }
        return try snapshotLive(name)
    }

    struct SwitchResult: Sendable {
        let from: String?
        let to: String
        let changed: Bool
        let tokenState: TokenState
    }

    /// Make `name` the live Codex login. The live one is written back into its
    /// own profile first; an unsaved live login is refused rather than
    /// silently overwritten, and a token the codex CLI rotates mid-switch is
    /// synced, not lost (`Codex.guardedSwitch`).
    @discardableResult
    static func switchTo(_ name: String) throws -> SwitchResult {
        guard let target = read(name) else {
            throw AccountError.message("no saved Codex account named \(name)")
        }
        let body = try pretty(target.auth)
        let outcome = try Codex.guardedSwitch(
            to: name, syncBack: syncBackLive, readLive: readLiveAuth,
            write: { try writePrivate(body, to: authURL) })
        let state = target.tokenState(nowMs: nowMs())
        switch outcome {
        case .unsaved(let live):
            let id = Codex.identity(live)
            throw AccountError.message(
                "the current Codex login (\(id.email ?? "unknown account")) is not saved - "
                    + "save it first, or it would be lost")
        case .busy:
            throw AccountError.message(
                "the codex CLI kept rewriting auth.json during the switch - "
                    + "nothing was changed, try again")
        case .already(let from):
            return SwitchResult(from: from, to: name, changed: false, tokenState: state)
        case .switched(let from):
            return SwitchResult(from: from, to: name, changed: true, tokenState: state)
        }
    }

    // MARK: usage, honestly

    typealias Unavailable = CodexUnavailable
    typealias RecordedUsage = CodexRecordedUsage

    /// The last `sessionTailBytes` of a file, as text.
    private static func readTail(_ url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let length = UInt64(min(Int(size), sessionTailBytes))
        try? handle.seek(toOffset: size - length)
        let data = (try? handle.read(upToCount: Int(length))) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }

    /// One directory under sessions/, as `Codex.scanSessions` asks for it.
    private static func listSessionDir(_ segments: [String]) -> [CodexDirEntry] {
        let dir = segments.reduce(sessionsURL) { $0.appendingPathComponent($1) }
        let keys: [URLResourceKey] = [
            .isDirectoryKey, .isRegularFileKey, .contentModificationDateKey,
        ]
        guard
            let urls = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: keys)
        else { return [] }
        return urls.map { url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            let isDir = values?.isDirectory ?? false
            let mtime =
                values?.isRegularFile == true
                ? values?.contentModificationDate.map { $0.timeIntervalSince1970 * 1000 } : nil
            return CodexDirEntry(name: url.lastPathComponent, isDirectory: isDir, mtimeMs: mtime)
        }
    }

    /// The newest session transcripts, newest first, capped: the contract's
    /// newest-day-first walk (`Codex.scanSessions`), never the whole tree.
    private static func recentSessions() -> [(url: URL, modified: Date)] {
        Codex.scanSessions(limit: sessionScanLimit, list: listSessionDir).map { file in
            let url = file.path.split(separator: "/").reduce(sessionsURL) {
                $0.appendingPathComponent(String($1))
            }
            return (url, Date(timeIntervalSince1970: file.mtimeMs / 1000))
        }
    }

    /// The freshest usage Codex has recorded locally: the tails of the newest
    /// transcripts, handed to `Codex.pickRecorded` (ClaudeUsageCore), which
    /// owns every decision. OpenAI publishes no plan-limit endpoint, so this
    /// is the whole story.
    static func recordedUsage(now: Date = Date()) -> RecordedUsage {
        let tails = recentSessions().map {
            CodexTranscriptTail(
                text: readTail($0.url), mtimeMs: $0.modified.timeIntervalSince1970 * 1000)
        }
        return Codex.pickRecorded(tails, nowMs: now.timeIntervalSince1970 * 1000)
    }
}
