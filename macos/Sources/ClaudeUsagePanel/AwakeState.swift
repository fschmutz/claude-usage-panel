import ClaudeUsageCore
import Foundation

/// Keep this Mac awake while Claude Code works, for a timer, or both.
///
/// The app is the holder: it owns a `caffeinate -i -w <us>` CHILD, so the
/// assertion is released the moment this process goes away, force-quit
/// included. Closed-lid mode is the only persistent change, and it is
/// journaled before it is made so scripts/awake-backstop.sh can undo it with
/// nothing of this app running.
///
/// Every decision - how long the session lasts, what still holds it, which
/// floor action is owed - is ClaudeUsageCore.Awake's, the same module the
/// GNOME extension and the Node clients read.
@MainActor
final class AwakeController: ObservableObject {
    /// Off by default, like the GNOME `awake-enabled`; with it off nothing is
    /// read. `./install.sh awake` turns it on.
    @Published var enabled: Bool {
        didSet {
            UserDefaults.standard.set(enabled, forKey: "awakeEnabled")
            Task { await refresh() }
        }
    }
    /// EXPERIMENTAL, and never implied by a click: it only ever rides along
    /// with a session the user starts while it is on.
    @Published var lidEnabled: Bool {
        didSet { UserDefaults.standard.set(lidEnabled, forKey: "awakeLidEnabled") }
    }
    @Published var lowPowerFloor: Int {
        didSet {
            UserDefaults.standard.set(lowPowerFloor, forKey: "awakeLowPowerFloor")
            syncConfig()
        }
    }
    @Published var endFloor: Int {
        didSet {
            UserDefaults.standard.set(endFloor, forKey: "awakeEndFloor")
            syncConfig()
        }
    }
    @Published var maxHours: Int {
        didSet {
            UserDefaults.standard.set(maxHours, forKey: "awakeMaxHours")
            syncConfig()
        }
    }

    @Published private(set) var state = Awake.state(session: nil, nowMs: 0)
    @Published private(set) var actionError: String?

    /// The child that actually holds the Mac awake.
    private var caffeinate: Process?
    private var lidHeld = false
    private var lowPowerSetByUs = false
    private var unreadableMisses = 0
    private var loop: Task<Void, Never>?

    /// The presets the popup offers, in minutes.
    static let presets = [30, 60, 120]

    init() {
        enabled = UserDefaults.standard.bool(forKey: "awakeEnabled")
        lidEnabled = UserDefaults.standard.bool(forKey: "awakeLidEnabled")
        lowPowerFloor =
            UserDefaults.standard.object(forKey: "awakeLowPowerFloor") as? Int
            ?? Awake.defaults.lowPowerFloor
        endFloor =
            UserDefaults.standard.object(forKey: "awakeEndFloor") as? Int ?? Awake.defaults.endFloor
        maxHours = UserDefaults.standard.object(forKey: "awakeMaxHours") as? Int ?? 12
    }

    var config: AwakeConfig {
        Awake.normalizeConfig(
            AwakeConfig(
                lowPowerFloor: lowPowerFloor, endFloor: endFloor, maxSeconds: maxHours * 3600))
    }

    /// The badge the menu bar shows: "" at rest, the countdown for a timer.
    var badge: String { Awake.badge(state) }

    /// Whether this process is the one holding the session.
    var isHolder: Bool { state.owner?.pid == Int(getpid()) }

    // MARK: reading

    func refresh() async {
        guard enabled else {
            state = Awake.state(session: nil, nowMs: Date().timeIntervalSince1970 * 1000)
            return
        }
        let now = Date().timeIntervalSince1970 * 1000
        let (session, journal, sessions) = await Task.detached(priority: .utility) {
            (AwakeStore.readSession(), AwakeStore.readJournal(), Self.liveSessionCount())
        }.value
        state = Awake.state(session: session, journal: journal, sessions: sessions, nowMs: now)
    }

    /// A session parked on a permission prompt counts: an unanswered prompt is
    /// exactly when the Mac must not drop off.
    nonisolated private static func liveSessionCount() -> Int {
        let live = WaitingStore.liveSessions().count
        return live > 0 ? live : WaitingStore.refresh().count
    }

    // MARK: acting

    /// Start a session. `seconds` nil with `whileSessions` means "no timer of
    /// its own": it then runs on the ceiling and ends when the last session
    /// does.
    func start(seconds: Int?, whileSessions: Bool = false) {
        actionError = nil
        guard enabled else { return }
        if let owner = state.owner, owner.pid != Int(getpid()), kill(pid_t(owner.pid), 0) == 0 {
            actionError = "already awake, held by pid \(owner.pid)"
            return
        }
        if let notice = Awake.recoveryNotice(
            AwakeStore.readJournal(), nowMs: Date().timeIntervalSince1970 * 1000)
        {
            actionError =
                "a previous session left \(notice.codes.joined(separator: ", ")) to give back"
            return
        }
        let wantLid = lidEnabled
        let session = Awake.newSession(
            nowMs: Date().timeIntervalSince1970 * 1000, seconds: seconds,
            whileSessions: whileSessions, lid: wantLid,
            owner: AwakeOwner(
                pid: Int(getpid()), host: ProcessInfo.processInfo.hostName, kind: "macos"),
            maxSeconds: config.maxSeconds)
        let taken = AwakeStore.withLock { () -> Bool in
            // The journal first, with nothing owned yet: a crash between here
            // and the first change leaves a clean journal, which is the truth.
            AwakeStore.write(
                journal: Awake.journalEntry(
                    nowMs: session.startedAt, endsAt: session.endsAt,
                    owner: session.owner ?? AwakeOwner()))
            AwakeStore.write(session: session)
            return true
        }
        guard taken == true else {
            actionError = "another process is changing the awake session right now"
            return
        }
        AwakeStore.write(config: config)
        startCaffeinate()
        AwakeStore.log("holding until \(Date(timeIntervalSince1970: session.endsAt / 1000))")
        startLoop()
        Task {
            // Off the main actor: the disable is read back after a settle, and
            // five seconds of a frozen menu bar is not a trade worth making.
            if wantLid { await enableLid() }
            await refresh()
        }
    }

    /// Push the deadline out, never past the ceiling measured from now.
    func extend(seconds: Int) {
        guard let current = AwakeStore.readSession(),
            let next = Awake.extend(
                current, by: seconds, nowMs: Date().timeIntervalSince1970 * 1000,
                maxSeconds: config.maxSeconds)
        else { return }
        _ = AwakeStore.withLock {
            AwakeStore.write(session: next)
            if let journal = AwakeStore.readJournal() {
                AwakeStore.write(
                    journal: AwakeJournal(
                        version: journal.version, at: journal.at, endsAt: next.endsAt,
                        owner: journal.owner, sleepDisabled: journal.sleepDisabled,
                        lowPower: journal.lowPower))
            }
        }
        Task { await refresh() }
    }

    /// End the session and give the Mac back everything that was owned. The
    /// undo runs off the main actor: it may wait on the lock and on two pmset
    /// calls, and the menu bar must not freeze while it does.
    func stop(reason: AwakeEndReason = .user) {
        letGoOfChildren()
        Task {
            let failed = await Task.detached(priority: .userInitiated) {
                AwakeStore.recover(force: true).failed
            }.value
            AwakeStore.log(
                "ended (\(reason.rawValue))"
                    + (failed.isEmpty
                        ? "" : " - COULD NOT UNDO \(failed.joined(separator: ", "))"))
            if !failed.isEmpty {
                actionError =
                    "could not give back \(failed.joined(separator: ", ")) - the backstop will retry"
            }
            await refresh()
        }
    }

    /// The Recover button: repair a session that ended without releasing.
    func recover() {
        Task {
            let failed = await Task.detached(priority: .userInitiated) {
                AwakeStore.recover(force: true).failed
            }.value
            actionError =
                failed.isEmpty ? nil : "could not undo \(failed.joined(separator: ", "))"
            await refresh()
        }
    }

    /// The Quit button's release, done SYNCHRONOUSLY: the app is about to go
    /// away, so there is no later for an async undo to run in. The caffeinate
    /// child dies with this process either way; this is for the closed-lid
    /// setting, which outlives it. (If the app is killed instead,
    /// scripts/awake-backstop.sh is what undoes it, within a few minutes.)
    func releaseNow() {
        guard isHolder else { return }
        letGoOfChildren()
        _ = AwakeStore.recover(force: true)
    }

    private func letGoOfChildren() {
        loop?.cancel()
        loop = nil
        caffeinate?.terminate()
        caffeinate = nil
        lidHeld = false
        lowPowerSetByUs = false
    }

    // MARK: the machine

    private func startCaffeinate() {
        guard let argv = Awake.inhibitArgv(platform: "darwin", pid: Int(getpid())),
            let exe = argv.first
        else { return }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = Array(argv.dropFirst())
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            caffeinate = proc
        } catch {
            AwakeStore.log("caffeinate could not start: \(error.localizedDescription)")
            actionError = "caffeinate could not start: \(error.localizedDescription)"
        }
    }

    /// Journal the claim, make the change, read it back. A bit that does not
    /// stick drops the claim again rather than leaving one nothing owns.
    private func enableLid() async {
        let outcome = await Task.detached(priority: .userInitiated) {
            () -> AwakeStore.ChangeFailure?? in
            AwakeStore.withLock { () -> AwakeStore.ChangeFailure? in
                guard let journal = AwakeStore.readJournal() else {
                    return .commandFailed("no journal")
                }
                AwakeStore.write(
                    journal: AwakeJournal(
                        version: journal.version, at: journal.at, endsAt: journal.endsAt,
                        owner: journal.owner, sleepDisabled: true, lowPower: journal.lowPower))
                let failure = AwakeStore.setLidDisabled(true)
                if failure != nil {
                    _ = AwakeStore.setLidDisabled(false, settleSeconds: 0)
                    AwakeStore.write(journal: journal)
                }
                return failure
            }
        }.value
        switch outcome {
        case .some(nil):
            lidHeld = true
            AwakeStore.log("lid mode on")
        case .some(.some(let failure)):
            actionError = Self.describe(failure)
            AwakeStore.log("lid mode NOT on: \(Self.describe(failure))")
        case nil:
            actionError = "another process is changing the awake session right now"
        }
    }

    static func describe(_ failure: AwakeStore.ChangeFailure) -> String {
        switch failure {
        case .commandFailed(let message):
            return
                "\(message) - closed-lid mode needs the sudoers rule ./install.sh awakelid installs"
        case .reverted:
            return
                "SleepDisabled read 0 again after the settle; something else is resetting it, so a "
                + "closed lid would still sleep this Mac"
        case .unreadable:
            return "pmset printed no SleepDisabled value, so the change could not be read back"
        }
    }

    // MARK: the loop

    /// Re-read the sessions, the battery and the thermal state, then do
    /// exactly what the floors say. The same loop claude-code/awake-worker.js
    /// runs, at the same interval.
    private func startLoop() {
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Awake.pollSeconds) * 1_000_000_000)
                guard let self, !Task.isCancelled else { return }
                await self.tick()
            }
        }
    }

    private func tick() async {
        await refresh()
        guard isHolder else {
            // Someone else owns the files now: let go without undoing what
            // the new owner owns.
            loop?.cancel()
            loop = nil
            caffeinate?.terminate()
            caffeinate = nil
            return
        }
        if let reason = state.endReason {
            stop(reason: reason)
            return
        }
        let (battery, thermal) = await Task.detached(priority: .utility) {
            (AwakeStore.readBattery(), AwakeStore.readThermal())
        }.value
        unreadableMisses =
            battery.percent == nil && battery.hasBattery ? unreadableMisses + 1 : 0
        for action in Awake.floorActions(
            battery: battery, unreadableMisses: unreadableMisses, thermal: thermal,
            lidClosed: lidHeld, lowPowerSetByUs: lowPowerSetByUs, config: config)
        {
            switch action {
            case .end(let reason):
                stop(reason: reason)
                return
            case .lowPowerOn(let cause):
                await setLowPower(true, cause: cause.rawValue)
            case .lowPowerOff:
                await setLowPower(false, cause: nil)
            }
        }
    }

    private func setLowPower(_ on: Bool, cause: String?) async {
        let outcome = await Task.detached(priority: .utility) { () -> AwakeStore.ChangeFailure?? in
            AwakeStore.withLock { () -> AwakeStore.ChangeFailure? in
                guard let journal = AwakeStore.readJournal() else {
                    return .commandFailed("no journal")
                }
                let claim = { (owned: Bool) in
                    AwakeStore.write(
                        journal: AwakeJournal(
                            version: journal.version, at: journal.at, endsAt: journal.endsAt,
                            owner: journal.owner, sleepDisabled: journal.sleepDisabled,
                            lowPower: owned))
                }
                if on { claim(true) }
                let failure = AwakeStore.setLowPower(on)
                if failure != nil || !on { claim(failure == nil && on) }
                return failure
            }
        }.value
        guard case .some(nil) = outcome else { return }
        lowPowerSetByUs = on
        AwakeStore.log("low power \(on ? "on" : "off")\(cause.map { " (\($0))" } ?? "")")
    }

    private func syncConfig() {
        // The CLI, the MCP tool and the backstop read the floors from disk, so
        // a change here has to reach them.
        AwakeStore.write(config: config)
    }
}
