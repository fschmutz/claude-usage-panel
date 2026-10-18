import ClaudeUsageCore
import Darwin
import Foundation

// The Awake session's I/O on macOS: the two files under Application Support,
// the lock both this app and scripts/awake-backstop.sh take, and the
// privileged pmset calls. Every decision is ClaudeUsageCore.Awake's; this
// file only reads, writes and runs, exactly like claude-code/awake.js does
// for the Node clients - and writes the same files, so one machine has one
// holder whichever surface started the session.
enum AwakeStore {
    private static var home: URL { FileManager.default.homeDirectoryForCurrentUser }

    /// The same directory claude-code/paths.js derives for darwin.
    static var directory: URL {
        home.appendingPathComponent("Library/Application Support/claude-usage-panel/awake")
    }
    static var sessionURL: URL { directory.appendingPathComponent("session.json") }
    static var journalURL: URL { directory.appendingPathComponent("journal.json") }
    static var configURL: URL { directory.appendingPathComponent("config.json") }
    static var lockURL: URL { directory.appendingPathComponent(".hold.lock") }
    static var logURL: URL { directory.appendingPathComponent("awake.log") }

    /// A lock whose holder is gone, or that has sat untouched this long, is
    /// taken over: LOCK_STALE_MS in claude-code/awake.js.
    static let lockStale: TimeInterval = 60
    /// How long a waiter polls before giving up and doing nothing. Doing
    /// nothing is always safe here; acting unlocked is not.
    static let lockWait: TimeInterval = 5
    /// How long after `pmset -a disablesleep 1` the bit is read back. pmset
    /// can exit 0 while something else puts it straight back.
    static let settle: TimeInterval = 5

    // MARK: reading

    static func readSession() -> AwakeSession? { Awake.parseSession(readJSON(sessionURL)) }
    static func readJournal() -> AwakeJournal? { Awake.parseJournal(readJSON(journalURL)) }

    static func readConfig() -> AwakeConfig {
        guard let obj = readJSON(configURL) as? [String: Any] else { return Awake.defaults }
        return Awake.normalizeConfig(
            AwakeConfig(
                lowPowerFloor: (obj["lowPowerFloor"] as? NSNumber)?.intValue
                    ?? Awake.defaults.lowPowerFloor,
                endFloor: (obj["endFloor"] as? NSNumber)?.intValue ?? Awake.defaults.endFloor,
                maxSeconds: (obj["maxSeconds"] as? NSNumber)?.intValue
                    ?? Awake.defaults.maxSeconds,
                thermalRules: (obj["thermalRules"] as? Bool) ?? true))
    }

    private static func readJSON(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    // MARK: writing

    static func write(session: AwakeSession) {
        var owner: [String: Any] = [:]
        if let o = session.owner {
            owner = ["pid": o.pid, "host": o.host, "kind": o.kind]
        }
        writeJSON(
            [
                "version": session.version, "startedAt": session.startedAt,
                "endsAt": session.endsAt, "timed": session.timed,
                "whileSessions": session.whileSessions, "lid": session.lid, "owner": owner,
            ], to: sessionURL)
    }

    static func write(journal: AwakeJournal) {
        writeJSON(
            [
                "version": journal.version, "at": journal.at, "endsAt": journal.endsAt,
                "owner": [
                    "pid": journal.owner.pid, "host": journal.owner.host,
                    "kind": journal.owner.kind,
                ],
                "sleepDisabled": journal.sleepDisabled, "lowPower": journal.lowPower,
            ], to: journalURL)
    }

    static func write(config: AwakeConfig) {
        let c = Awake.normalizeConfig(config)
        writeJSON(
            [
                "lowPowerFloor": c.lowPowerFloor, "endFloor": c.endFloor,
                "maxSeconds": c.maxSeconds, "thermalRules": c.thermalRules,
            ], to: configURL)
    }

    static func removeSession() { unlink(sessionURL.path) }

    /// One line in the holder's log, shared with the Node holder and the
    /// backstop. Best effort: a log that cannot be written must never cost
    /// the machine its release.
    static func log(_ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
        ensureDirectory()
        if let handle = try? FileHandle(forWritingTo: logURL) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
            try? handle.close()
            return
        }
        FileManager.default.createFile(
            atPath: logURL.path, contents: data, attributes: [.posixPermissions: 0o600])
    }

    private static func ensureDirectory() {
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    }

    /// A tmp file created 0600 and renamed over the target, as the Node port
    /// does: the inode is swapped, so the result is 0600 whatever it replaces.
    private static func writeJSON(_ object: [String: Any], to url: URL) {
        ensureDirectory()
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else { return }
        let tmp = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        unlink(tmp.path)
        let fd = open(tmp.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard fd >= 0 else { return }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try? handle.write(contentsOf: data)
        try? handle.write(contentsOf: Data("\n".utf8))
        try? handle.close()
        if rename(tmp.path, url.path) != 0 { unlink(tmp.path) }
    }

    // MARK: the lock

    /// Hold the lock for `body`, or return nil without doing anything. A
    /// caller that cannot get the lock must NEVER proceed unlocked.
    static func withLock<T>(_ body: () -> T) -> T? {
        ensureDirectory()
        let deadline = Date().addingTimeInterval(lockWait)
        while true {
            let fd = open(lockURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            if fd >= 0 {
                let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
                try? handle.write(contentsOf: Data("\(getpid())\n".utf8))
                try? handle.close()
                defer { unlink(lockURL.path) }
                return body()
            }
            let held = (try? String(contentsOf: lockURL, encoding: .utf8))?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let pid = Int(held ?? "") ?? 0
            let attributes =
                (try? FileManager.default.attributesOfItem(atPath: lockURL.path)) ?? [:]
            let modified = attributes[.modificationDate] as? Date
            let stale = modified.map { Date().timeIntervalSince($0) > lockStale } ?? true
            if (pid > 0 && kill(pid_t(pid), 0) != 0 && errno == ESRCH) || stale {
                unlink(lockURL.path)
                continue
            }
            if Date() >= deadline { return nil }
            usleep(50_000)
        }
    }

    // MARK: the machine

    /// The battery as the floors need it. A Mac with no battery line is a
    /// desktop: no floor applies.
    static func readBattery() -> AwakeBattery {
        let r = Shell.run("/usr/bin/pmset", ["-g", "batt"])
        guard r.ok else { return AwakeBattery(percent: nil, charging: false, hasBattery: true) }
        return Awake.parsePmsetBattery(r.out)
    }

    /// What macOS reports about its own thermal state. `pmset -g therm` is the
    /// fallback for a Mac that does not answer through ProcessInfo.
    static func readThermal() -> AwakeThermal {
        let reported = Awake.thermal(processState: ProcessInfo.processInfo.thermalState)
        if reported != .nominal { return reported }
        return Awake.thermal(speedLimitOutput: Shell.run("/usr/bin/pmset", ["-g", "therm"]).out)
    }

    enum ChangeFailure: Equatable, Sendable {
        case commandFailed(String)
        case reverted
        case unreadable
    }

    /// `pmset -a disablesleep 1|0`, one of the four commands the sudoers rule
    /// grants. `sudo -n` NEVER prompts: without the rule it fails fast with a
    /// readable error instead of hanging the menu bar on a password prompt.
    ///
    /// A disable is READ BACK after a settle: pmset can exit 0 while something
    /// else puts the bit straight back, and a lid mode that cannot be proven
    /// on is reported as failed rather than trusted.
    static func setLidDisabled(_ on: Bool, settleSeconds: TimeInterval = AwakeStore.settle)
        -> ChangeFailure?
    {
        guard let argv = Awake.lidArgv(platform: "darwin", on: on), let exe = argv.first
        else { return .commandFailed("no command for this platform") }
        let r = Shell.run(exe, Array(argv.dropFirst()), mergeStderr: true)
        guard r.ok else {
            return .commandFailed(
                lastLine(r.out).isEmpty ? "pmset exited \(r.status)" : lastLine(r.out))
        }
        guard on else { return nil }
        if settleSeconds > 0 { Thread.sleep(forTimeInterval: settleSeconds) }
        switch Awake.parseSleepDisabled(Shell.run("/usr/bin/pmset", ["-g"]).out) {
        case true?: return nil
        case false?: return .reverted
        case nil: return .unreadable
        }
    }

    static func setLowPower(_ on: Bool) -> ChangeFailure? {
        guard let argv = Awake.lowPowerArgv(platform: "darwin", on: on), let exe = argv.first
        else { return .commandFailed("no command for this platform") }
        let r = Shell.run(exe, Array(argv.dropFirst()), mergeStderr: true)
        return r.ok ? nil : .commandFailed(lastLine(r.out))
    }

    private static func lastLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).last.map {
            $0.trimmingCharacters(in: .whitespaces)
        } ?? ""
    }

    /// Give the machine back everything the journal still owns, in the
    /// journal's own order, clearing each flag only after its undo succeeded.
    /// The one path a stop, an app quit and a repair all take.
    @discardableResult
    static func recover(force: Bool) -> (undone: [String], failed: [String]) {
        let result = withLock { () -> (undone: [String], failed: [String]) in
            let journal = readJournal()
            let steps = Awake.recoverySteps(journal)
            guard !steps.isEmpty, var next = journal else {
                removeSession()
                return ([], [])
            }
            guard force || Awake.backstopDue(journal, nowMs: Date().timeIntervalSince1970 * 1000)
            else { return ([], steps) }
            var undone: [String] = []
            var failed: [String] = []
            for step in steps {
                let outcome =
                    step == "sleepDisabled"
                    ? setLidDisabled(false, settleSeconds: 0) : setLowPower(false)
                if outcome == nil {
                    undone.append(step)
                    next = AwakeJournal(
                        version: next.version, at: next.at, endsAt: next.endsAt, owner: next.owner,
                        sleepDisabled: step == "sleepDisabled" ? false : next.sleepDisabled,
                        lowPower: step == "lowPower" ? false : next.lowPower)
                    write(journal: next)
                } else {
                    failed.append(step)
                }
            }
            if failed.isEmpty { removeSession() }
            return (undone, failed)
        }
        return result ?? ([], Awake.recoverySteps(readJournal()))
    }
}
