import AppKit
import ClaudeUsageCore
import Network
import SwiftUI

// MARK: - View model

@MainActor
final class UsageModel: ObservableObject {
    @Published var cards: [LimitCard] = []
    /// Prepaid credit spend, when the account has extra usage enabled.
    @Published var extraUsage: ExtraUsage?
    @Published var planLabel: String?
    @Published var errorText: String?
    @Published var costText: String?
    @Published var updated: String = ""

    @Published var refreshMinutes: Int {
        didSet {
            UserDefaults.standard.set(refreshMinutes, forKey: "refreshMinutes")
            restart()
        }
    }
    @Published var showCost: Bool {
        didSet {
            UserDefaults.standard.set(showCost, forKey: "showCost")
            Task { await refresh() }
        }
    }
    @Published var alertsEnabled: Bool {
        didSet { UserDefaults.standard.set(alertsEnabled, forKey: "alertsEnabled") }
    }
    /// Shell command run when a limit crosses 90/100 % or a window resets.
    /// Empty disables it.
    @Published var eventCommand: String {
        didSet { UserDefaults.standard.set(eventCommand, forKey: "eventCommand") }
    }
    @Published var launchAtLogin: Bool {
        didSet { LoginItem.setEnabled(launchAtLogin) }
    }
    @Published var cursorEnabled: Bool {
        didSet {
            UserDefaults.standard.set(cursorEnabled, forKey: "cursorEnabled")
            Task { await refresh() }
        }
    }
    @Published var cursorApiKey: String {
        didSet {
            // Secret → login Keychain, never UserDefaults (cleartext plist).
            KeychainStore.write("cursor-admin-api-key", cursorApiKey)
            Task { await refresh() }
        }
    }
    @Published var cursorSummary: CursorSummary?
    @Published var cursorError: String?

    // Named accounts: saved logins, the active one, and the opt-in auto-switch.
    // Behavior lives in Accounts.swift (extension UsageModel); only the stored
    // properties are here because extensions cannot declare them.
    /// The master switch - off by default, so nothing account-related shows
    /// until the user asks for it.
    @Published var accountsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(accountsEnabled, forKey: "accountsEnabled")
            Task { await refreshAccounts() }
        }
    }
    @Published var accounts: [AccountRow] = []
    @Published var activeAccount: String?
    @Published var accountsError: String?
    @Published var accountsAutoSwitch: Bool {
        didSet { UserDefaults.standard.set(accountsAutoSwitch, forKey: "accountsAutoSwitch") }
    }
    @Published var accountsSwitchThreshold: Int {
        didSet {
            UserDefaults.standard.set(accountsSwitchThreshold, forKey: "accountsSwitchThreshold")
        }
    }
    @Published var showAccountInMenuBar: Bool {
        didSet { UserDefaults.standard.set(showAccountInMenuBar, forKey: "showAccountInMenuBar") }
    }

    // Today's sessions: the work the plan was actually spent on, ranked by the
    // tokens each one burned, each resumable in a terminal with one click.
    @Published var showSessions: Bool {
        didSet {
            UserDefaults.standard.set(showSessions, forKey: "showSessions")
            Task { await refreshSessions() }
        }
    }
    @Published var terminalChoice: TerminalLauncher.Choice {
        didSet { UserDefaults.standard.set(terminalChoice.rawValue, forKey: "terminalChoice") }
    }
    @Published var sessions: [RankedSession] = []
    /// The index is still catching up, so the token numbers are a floor.
    @Published var sessionsPending = false
    @Published var sessionError: String?
    /// When a scheduled ping last opened a 5-hour window ("" when never).
    @Published var lastPing: String = ""

    // Session pings: the launchd agent plist is the source of truth (shared
    // with `./install.sh sessionping`), not UserDefaults - see SessionPing.
    @Published var sessionPingEnabled: Bool {
        didSet { applySessionPing() }
    }
    @Published var sessionPingTimes: [String] {
        didSet { applySessionPing() }
    }
    @Published var sessionPingDays: Set<Int> {
        didSet { applySessionPing() }
    }
    @Published var sessionPingError: String?

    // Updates: read from auto-update.sh, never cached across a Settings open -
    // the scheduler can change the answer behind our back.
    @Published var updateStatus: UpdateStatus?
    @Published var updateBusy = false
    @Published var updateError: String?
    /// Init reads the plist back through these properties; only user edits
    /// (after init) may rewrite it.
    private var sessionPingReady = false
    /// In-flight (delayed) agent rewrite - see applySessionPing().
    private var sessionPingApplyTask: Task<Void, Never>?
    /// How long an edit must settle before the agent is rewritten. Long enough
    /// to swallow a spinner drag, short enough that closing Settings right
    /// after an edit still lands it.
    private static let sessionPingApplyDelayNs: UInt64 = 600_000_000
    /// Per-limit [epochMs, percent] samples - sparkline + burn-rate forecast.
    @Published private(set) var history: [String: [[Double]]] = [:]
    @Published private(set) var forecasts: [String: Forecast] = [:]
    private var alertFired: [String: Int] = [:]
    private var paceAlerted: Set<String> = []
    /// Enough for the forecast's 6 h window; ~15 h at the 10-minute default.
    private static let historyMax = 90

    private var loopTask: Task<Void, Never>?
    private var wakeTask: Task<Void, Never>?
    /// Consecutive polls in which no limit moved - drives the backoff.
    private var idleStreak = 0

    /// Week-over-week peak for one card, from the durable history.
    func trend(for id: String) -> WeekOverWeek? {
        Warehouse.weekOverWeek(warehouse, key: id, nowMs: Date().timeIntervalSince1970 * 1000)
    }
    /// 90 days of poll samples for the week-over-week line. Loaded once; every
    /// later poll that moved appends to both the file and this list.
    private var warehouse: [WarehouseEntry] = []
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "claude-usage-panel.network")

    init() {
        workDayStart = UserDefaults.standard.string(forKey: "workDayStart") ?? "09:00"
        workDayEnd = UserDefaults.standard.string(forKey: "workDayEnd") ?? "18:00"
        refreshMinutes = UserDefaults.standard.object(forKey: "refreshMinutes") as? Int ?? 10
        showCost = UserDefaults.standard.bool(forKey: "showCost")
        alertsEnabled = UserDefaults.standard.object(forKey: "alertsEnabled") as? Bool ?? true
        eventCommand = UserDefaults.standard.string(forKey: "eventCommand") ?? ""
        cursorEnabled = UserDefaults.standard.bool(forKey: "cursorEnabled")
        accountsEnabled = UserDefaults.standard.bool(forKey: "accountsEnabled")
        accountsAutoSwitch = UserDefaults.standard.bool(forKey: "accountsAutoSwitch")
        accountsSwitchThreshold =
            UserDefaults.standard.object(forKey: "accountsSwitchThreshold") as? Int
            ?? AutoSwitch.threshold
        showAccountInMenuBar =
            UserDefaults.standard.object(forKey: "showAccountInMenuBar") as? Bool ?? true
        // Key lives in the Keychain. Migrate a value stored in UserDefaults by
        // pre-Keychain versions once, then scrub it from the plist.
        if let legacy = UserDefaults.standard.string(forKey: "cursorApiKey"), !legacy.isEmpty {
            KeychainStore.write("cursor-admin-api-key", legacy)
            UserDefaults.standard.removeObject(forKey: "cursorApiKey")
        }
        cursorApiKey = KeychainStore.read("cursor-admin-api-key") ?? ""
        // Pair-form [epochMs, percent] history; bare-percent entries written by
        // older versions migrate as [0, p] - sparkline keeps working, the
        // forecast simply ignores the timestampless samples.
        let stored = UserDefaults.standard.dictionary(forKey: "history") ?? [:]
        history = stored.mapValues { v in
            if let pairs = v as? [[Double]] { return pairs }
            if let bare = v as? [Int] { return bare.map { [0, Double($0)] } }
            return []
        }
        launchAtLogin = LoginItem.isEnabled
        showSessions = UserDefaults.standard.object(forKey: "showSessions") as? Bool ?? true
        terminalChoice =
            TerminalLauncher.Choice(
                rawValue: UserDefaults.standard.string(forKey: "terminalChoice") ?? "")
            ?? .auto
        let sp = SessionPing.read()
        sessionPingEnabled = sp.enabled
        sessionPingTimes = sp.schedule.times
        sessionPingDays = sp.schedule.days
        sessionPingReady = true

        // First launch: register the login item by default, matching the GNOME
        // extension's auto-enable. Only once - a later user opt-out is respected.
        // (didSet does not fire from init, so register explicitly.)
        if !UserDefaults.standard.bool(forKey: "didAutoRegisterLogin") {
            UserDefaults.standard.set(true, forKey: "didAutoRegisterLogin")
            if !launchAtLogin {
                LoginItem.setEnabled(true)
                launchAtLogin = LoginItem.isEnabled
            }
        }

        warehouse = Warehouse.load(nowMs: Date().timeIntervalSince1970 * 1000)
        watchWakeAndNetwork()
        restart()  // didSet does not fire from init, so start the loop explicitly
    }

    private func restart() {
        loopTask?.cancel()
        let base = max(1, refreshMinutes) * 60
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                guard let self else { return }
                // A fixed interval polls hardest exactly when nothing moves,
                // and lands late on the one tick that matters - the reset.
                let delay = await MainActor.run {
                    PollSchedule.nextPollSeconds(
                        baseSeconds: base, idleStreak: self.idleStreak,
                        nextReset: PollSchedule.nextReset(self.cards))
                }
                try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000_000)
            }
        }
    }

    /// A wake from sleep leaves every countdown on screen stale by however long
    /// the lid was shut, and the polls during a network outage all failed. Both
    /// are worth one immediate poll, coalesced so a burst of notifications does
    /// not become a burst of requests.
    private func watchWakeAndNetwork() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.refreshSoon()
        }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.refreshSoon() }
        }
        networkMonitor.start(queue: networkQueue)
    }

    @MainActor
    private func refreshSoon() {
        wakeTask?.cancel()
        wakeTask = Task { [weak self] in
            // Let it settle: DNS and the Keychain are not necessarily ready the
            // instant macOS says the machine is awake.
            try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    func refresh() async {
        do {
            let result = try await ClaudeUsage.fetch()
            let moved = !PollSchedule.sameUsage(cards, result.cards)
            idleStreak = moved ? 0 : idleStreak + 1
            // Only record what moved: a flat afternoon would otherwise write an
            // identical line every poll for 90 days.
            if moved {
                let nowMs = Date().timeIntervalSince1970 * 1000
                warehouse.append(
                    WarehouseEntry(
                        t: nowMs,
                        limits: Dictionary(
                            result.cards.map { ($0.id, $0.percent) },
                            uniquingKeysWith: { a, _ in a })))
                Warehouse.append(result.cards, nowMs: nowMs)
            }
            runEventCommand(EventHooks.detect(previous: cards, current: result.cards))
            cards = result.cards
            extraUsage = result.extraUsage
            planLabel = result.planLabel
            errorText = nil
            updated = Self.timeFormatter.string(from: Date())
            recordHistory(result.cards)
            checkAlerts(result.cards)
        } catch {
            errorText = error.localizedDescription
        }

        // Not a `guard … else { return }`: everything below is independent of
        // the cost line, and returning early here used to skip it all whenever
        // cost was switched off.
        if showCost {
            costText = "computing…"
            if let cost = await Cost.fetchActiveCost() {
                costText = String(
                    format: "$%.2f · %@ tokens", cost.costUSD, Self.compact(cost.tokens))
            } else {
                costText = "unavailable (install ccusage)"
            }
        } else {
            costText = nil
        }

        lastPing = SessionPingStatus.formatLastPing(SessionStore.readLastPing(), now: Date())
        await refreshSessions()
        await refreshCursor()
        await refreshAccounts()
    }

    /// Fold whatever the transcripts appended since last time and re-rank.
    /// Off the main actor: a cold index folds tens of megabytes, which must
    /// never block the menu bar.
    func refreshSessions() async {
        guard showSessions else {
            sessions = []
            sessionsPending = false
            return
        }
        let result = await Task.detached(priority: .utility) {
            SessionStore.refresh()
        }.value
        sessions = result.sessions
        sessionsPending = result.pending
    }

    /// Open one session's project in a terminal, resuming that exact session.
    func resume(_ session: RankedSession) {
        sessionError = TerminalLauncher.open(session: session, choice: terminalChoice)
    }

    /// The next scheduled ping, for the dropdown's ping line.
    var nextPing: String {
        guard sessionPingEnabled else { return "" }
        return SessionPingStatus.nextPing(
            times: sessionPingTimes, days: sessionPingDays, now: Date())
    }

    private func refreshCursor() async {
        guard cursorEnabled, !cursorApiKey.isEmpty else {
            cursorSummary = nil
            cursorError = nil
            return
        }
        do {
            cursorSummary = try await CursorAPI.fetch(key: cursorApiKey)
            cursorError = nil
        } catch {
            cursorSummary = nil
            cursorError = error.localizedDescription
        }
    }

    private func recordHistory(_ cards: [LimitCard]) {
        let now = Date().timeIntervalSince1970 * 1000
        for c in cards {
            var h = history[c.id] ?? []
            h.append([now, Double(c.percent)])
            if h.count > Self.historyMax { h.removeFirst(h.count - Self.historyMax) }
            history[c.id] = h
            let samples = h.compactMap { p -> (t: Double, p: Double)? in
                p.count == 2 ? (t: p[0], p: p[1]) : nil
            }
            forecasts[c.id] = UsageForecast.forecast(
                samples: samples, resetsAt: c.resetsAt, nowMs: now)
        }
        UserDefaults.standard.set(history, forKey: "history")  // survive restarts
    }

    /// The user's own command for the two moments worth acting on: a limit
    /// crossing 90/100 %, and a window rolling over. Run through bash -lc so a
    /// one-liner with a pipe works; every substituted value is shell-quoted,
    /// because the label comes from the API.
    private func runEventCommand(_ events: [UsageEvent]) {
        let template = eventCommand.trimmingCharacters(in: .whitespaces)
        guard !template.isEmpty, !events.isEmpty else { return }
        for event in events {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-lc", EventHooks.expand(template, event)]
            // Nothing reads the output, and an undrained pipe would deadlock
            // the child once it fills.
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
        }
    }

    // Notify on first crossing of 90% / 100%, with hysteresis to re-arm.
    private func checkAlerts(_ cards: [LimitCard]) {
        guard alertsEnabled else { return }
        for c in cards {
            let prev = alertFired[c.id] ?? 0
            let threshold = c.percent >= 100 ? 100 : (c.percent >= 90 ? 90 : 0)
            if threshold > prev {
                alertFired[c.id] = threshold
                notify("Claude usage", "\(c.label) reached \(threshold)%")
            } else if threshold < prev && c.percent < 85 {
                alertFired[c.id] = threshold
            }

            // Predictive: warn ONCE per window when the pace first projects the
            // limit running dry at least 1 h before its reset; re-arm only when
            // the projection clears by 2 h (or goes away) so an edge-hovering
            // pace can't ping-pong notifications.
            if let fc = forecasts[c.id], fc.exhaustsBeforeReset, (fc.marginHours ?? 0) <= -1 {
                if !paceAlerted.contains(c.id) {
                    paceAlerted.insert(c.id)
                    notify(
                        "Claude usage",
                        "\(c.label) is on pace to run out before it resets - "
                            + UsageForecast.format(forecasts[c.id]))
                }
            } else if forecasts[c.id] == nil
                || (!forecasts[c.id]!.exhaustsBeforeReset
                    && (forecasts[c.id]!.marginHours ?? 99) >= 2)
            {
                paceAlerted.remove(c.id)
            }
        }
    }

    /// Rewrite the launchd agent, coalescing bursts of edits into one write.
    /// A DatePicker fires `didSet` on every spinner tick and each apply() is a
    /// full `bootout` + `bootstrap`, so dragging the minute field would tear
    /// the agent down and reload it once per increment. Waiting for the edit
    /// to settle collapses that into a single reload.
    private func applySessionPing() {
        guard sessionPingReady else { return }
        sessionPingApplyTask?.cancel()
        sessionPingApplyTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.sessionPingApplyDelayNs)
            guard !Task.isCancelled, let self else { return }
            self.sessionPingError = SessionPing.apply(
                enabled: self.sessionPingEnabled,
                schedule: SessionPingSchedule(
                    times: self.sessionPingTimes, days: self.sessionPingDays))
        }
    }

    /// Re-read the agent plist into the model - the CLI installer edits the
    /// same file, so refresh before showing (and thus before any UI edit could
    /// rewrite the plist from a stale copy). Guarded so the read-back itself
    /// never triggers apply().
    func reloadSessionPing() {
        sessionPingApplyTask?.cancel()
        sessionPingReady = false
        let sp = SessionPing.read()
        sessionPingEnabled = sp.enabled
        sessionPingTimes = sp.schedule.times
        sessionPingDays = sp.schedule.days
        sessionPingReady = true
    }

    /// Re-read update status. Cheap enough to run on every Settings appear;
    /// the git fetch inside the script is the slow part, so it runs off-main.
    func reloadUpdateStatus() {
        DispatchQueue.global(qos: .utility).async {
            let s = Updates.status()
            DispatchQueue.main.async {
                self.updateStatus = s
                if s == nil {
                    self.updateError =
                        "No git checkout found - this build cannot self-update."
                }
            }
        }
    }

    /// Install the available update, then refresh.
    func applyUpdate() {
        guard !updateBusy else { return }
        updateBusy = true
        updateError = nil
        DispatchQueue.global(qos: .utility).async {
            let err = Updates.applyUpdate()
            let s = Updates.status()
            DispatchQueue.main.async {
                self.updateError = err
                self.updateStatus = s
                self.updateBusy = false
            }
        }
    }

    /// Working day used to plan pings. Same @Published + UserDefaults idiom as
    /// every other persisted setting here - @AppStorage does not publish from an
    /// ObservableObject.
    @Published var workDayStart: String {
        didSet { UserDefaults.standard.set(workDayStart, forKey: "workDayStart") }
    }
    @Published var workDayEnd: String {
        didSet { UserDefaults.standard.set(workDayEnd, forKey: "workDayEnd") }
    }

    private var workDay: WorkDay {
        WorkDay(start: workDayStart, end: workDayEnd) ?? .default
    }

    /// Replace the schedule with the one that covers the working day best.
    func suggestSessionPingTimes() {
        sessionPingTimes = WindowPlanner.plan(day: workDay, pings: 2).pingTimes
    }

    /// "56% of 09:00-18:00 covered" for the current schedule.
    var sessionPingCoverage: String {
        guard let p = WindowPlanner.evaluate(pingTimes: sessionPingTimes, day: workDay) else {
            return "No valid ping times."
        }
        let best = WindowPlanner.plan(day: workDay, pings: 2)
        if p.coveragePercent >= best.coveragePercent { return p.summary }
        return p.summary + " · \(best.pingTimes.joined(separator: " ")) would cover "
            + "\(best.coveragePercent)%"
    }

    /// "06:00 11:00 · Mon-Fri" - the dropdown's one-line schedule summary.
    /// "last 05:30 · next 10:35" for the dropdown - what the schedule actually
    /// did, and what it will do next, rather than only what is configured.
    var pingStatusLine: String {
        var parts = ["last \(lastPing.isEmpty ? "never" : lastPing)"]
        let next = nextPing
        if !next.isEmpty { parts.append("next \(next)") }
        return parts.joined(separator: " · ")
    }

    var sessionPingSummary: String {
        let names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        let days: String
        switch sessionPingDays.sorted() {
        case [1, 2, 3, 4, 5]: days = "Mon-Fri"
        case [1, 2, 3, 4, 5, 6, 7]: days = "every day"
        case let d: days = d.map { names[$0 - 1] }.joined(separator: " ")
        }
        return "\(sessionPingTimes.joined(separator: " ")) · \(days)"
    }

    func notify(_ title: String, _ body: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "\"", with: "\\\"") }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = [
            "-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\"",
        ]
        try? proc.run()
    }

    func spark(for id: String) -> String {
        let h = (history[id] ?? []).suffix(12).compactMap { $0.count == 2 ? $0[1] : nil }
        guard h.count >= 2 else { return "" }
        let blocks = Array(" ▁▂▃▄▅▆▇█")
        return String(h.map { blocks[max(0, min(8, Int(($0 / 100 * 8).rounded())))] })
    }

    /// Severity dot for the menu-bar title (renders in color as an emoji).
    private func dot(_ s: Severity) -> String {
        switch s {
        case .critical: return "🔴"
        case .warning: return "🟠"
        case .normal: return "🟢"
        }
    }

    /// Worst (highest %) limit, for the menu-bar title. A limit reading normal
    /// but on pace to run out before its reset shows the warning dot -
    /// trouble at 50%, not at 90%.
    var titleText: String {
        guard let worst = cards.max(by: { $0.percent < $1.percent }) else {
            return errorText == nil ? "⚪️ …" : "⚪️ ?"
        }
        let short =
            worst.label.components(separatedBy: "·").last?.trimmingCharacters(in: .whitespaces)
            ?? worst.label
        var sev = worst.severity
        if sev == .normal, forecasts[worst.id]?.exhaustsBeforeReset == true {
            sev = .warning
        }
        // "PRO · Session 42%" once the login is a saved, named account.
        let prefix = showAccountInMenuBar ? activeAccount.map { "\($0) · " } ?? "" : ""
        return "\(dot(sev)) \(prefix)\(short) \(worst.percent)%"
    }

    static func compact(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))k" }
        return "\(n)"
    }

    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
}
