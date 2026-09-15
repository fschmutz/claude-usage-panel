import AppKit
import ClaudeUsageCore
import Combine
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
            Task { await refreshCost() }
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
            Task { await refreshCursor() }
        }
    }
    /// Committed by the Settings field on submit / Save, never per keystroke:
    /// each write is a Keychain delete + add and a Cursor API round-trip.
    @Published var cursorApiKey: String {
        didSet {
            // Secret → login Keychain, never UserDefaults (cleartext plist).
            KeychainStore.write("cursor-admin-api-key", cursorApiKey)
            Task { await refreshCursor() }
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
    /// The live login's email, for the Settings "save as" row.
    @Published var liveLoginEmail: String?
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

    /// Session pings and update status: their own observables, owned here and
    /// re-published so a view holding only the model still re-renders.
    let sessionPing = SessionPingSettings()
    let updates = UpdateState()
    private var forwarders: [AnyCancellable] = []

    /// Per-limit [epochMs, percent] samples - sparkline + burn-rate forecast.
    @Published private(set) var history: [String: [[Double]]] = [:]
    @Published private(set) var forecasts: [String: Forecast] = [:]
    /// Week-over-week peak per card, from the durable history; recomputed per
    /// poll rather than per view render.
    @Published private(set) var trends: [String: WeekOverWeek] = [:]
    private var alerts = AlertLatch()
    private var paceAlerted: Set<String> = []
    /// Enough for the forecast's 6 h window; ~15 h at the 10-minute default.
    private static let historyMax = 90

    private var loopTask: Task<Void, Never>?
    private var wakeTask: Task<Void, Never>?
    /// The poll in flight, if any: a second caller joins it instead of racing
    /// it on `cards` / `idleStreak` (and firing the event hook twice).
    private var refreshTask: Task<Void, Never>?
    /// Consecutive polls in which no limit moved - drives the backoff.
    private var idleStreak = 0

    /// 90 days of poll samples for the week-over-week line. Loaded once; every
    /// later poll that moved appends to both the file and this list.
    private var warehouse: [WarehouseEntry] = []
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "claude-usage-panel.network")

    init() {
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

        // Both children publish on the main thread (they are @MainActor), so
        // re-publishing from their sink is main-actor work the compiler cannot
        // see; assumeIsolated says so, and traps if it ever were not.
        for child in [sessionPing.objectWillChange, updates.objectWillChange] {
            forwarders.append(
                child.sink { [weak self] _ in
                    MainActor.assumeIsolated { self?.objectWillChange.send() }
                })
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
                await self?.updates.checkIfDue()
                guard let self else { return }
                // A fixed interval polls hardest exactly when nothing moves,
                // and lands late on the one tick that matters - the reset.
                let delay = PollSchedule.nextPollSeconds(
                    baseSeconds: base, idleStreak: self.idleStreak,
                    nextReset: PollSchedule.nextReset(self.cards))
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
            Task { @MainActor in self?.refreshSoon() }
        }
        networkMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.refreshSoon() }
        }
        networkMonitor.start(queue: networkQueue)
    }

    /// One poll after `seconds`, coalescing whatever else asks in the meantime.
    /// The default lets a wake settle: DNS and the Keychain are not necessarily
    /// ready the instant macOS says the machine is awake.
    func refreshSoon(after seconds: Double = 5) {
        wakeTask?.cancel()
        wakeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.refresh()
            await self?.updates.checkIfDue()
        }
    }

    /// Poll everything. Re-entrant callers join the poll in flight.
    func refresh() async {
        if let running = refreshTask {
            await running.value
            return
        }
        let task = Task { await poll() }
        refreshTask = task
        await task.value
        refreshTask = nil
    }

    private func poll() async {
        do {
            let result = try await ClaudeUsage.fetch()
            let nowMs = Date().timeIntervalSince1970 * 1000
            let moved = !PollSchedule.sameUsage(cards, result.cards)
            idleStreak = moved ? 0 : idleStreak + 1
            // Only record what moved: a flat afternoon would otherwise write an
            // identical line every poll for 90 days.
            if moved { warehouse.append(Warehouse.append(result.cards, nowMs: nowMs)) }
            trends = Dictionary(
                result.cards.compactMap { card in
                    Warehouse.weekOverWeek(warehouse, key: card.id, nowMs: nowMs).map {
                        (card.id, $0)
                    }
                }, uniquingKeysWith: { a, _ in a })
            runEventCommand(EventHooks.detect(previous: cards, current: result.cards))
            cards = result.cards
            extraUsage = result.extraUsage
            planLabel = result.planLabel
            errorText = nil
            updated = Self.timeFormatter.string(from: Date())
            recordHistory(result.cards, nowMs: nowMs)
            checkAlerts(result.cards)
        } catch {
            errorText = error.localizedDescription
        }
        await refreshCost()
        sessionPing.refreshLastPing()
        await refreshSessions()
        await refreshCursor()
        await refreshAccounts()
    }

    private func refreshCost() async {
        guard showCost else {
            costText = nil
            return
        }
        costText = "computing…"
        if let cost = await Cost.fetchActiveCost() {
            costText = String(
                format: "$%.2f · %@ tokens", cost.costUSD,
                SessionFormat.compactTokens(cost.tokens))
        } else {
            costText = "unavailable (install ccusage)"
        }
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

    private func recordHistory(_ cards: [LimitCard], nowMs: Double) {
        for c in cards {
            var h = history[c.id] ?? []
            h.append([nowMs, Double(c.percent)])
            if h.count > Self.historyMax { h.removeFirst(h.count - Self.historyMax) }
            history[c.id] = h
            let samples = h.compactMap { p -> (t: Double, p: Double)? in
                p.count == 2 ? (t: p[0], p: p[1]) : nil
            }
            forecasts[c.id] = UsageForecast.forecast(
                samples: samples, resetsAt: c.resetsAt, nowMs: nowMs)
        }
        UserDefaults.standard.set(history, forKey: "history")  // survive restarts
    }

    /// The user's own command for the two moments worth acting on: a limit
    /// crossing 90/100 %, and a window rolling over. Run through bash -lc so a
    /// one-liner with a pipe works; every substituted value is shell-quoted,
    /// because the label comes from the API.
    private func runEventCommand(_ events: [UsageEvent]) {
        let template = eventCommand.trimmingCharacters(in: .whitespaces)
        guard !template.isEmpty else { return }
        for event in events {
            Shell.launch("/bin/bash", ["-lc", EventHooks.expand(template, event)])
        }
    }

    /// Notify on the first crossing of 90% / 100% per window (the latch holds
    /// the hysteresis), and once per window when the pace projects the limit
    /// running dry at least 1 h before its reset.
    private func checkAlerts(_ cards: [LimitCard]) {
        guard alertsEnabled else { return }
        for (card, threshold) in alerts.crossings(cards) {
            notify("Claude usage", "\(card.label) reached \(threshold)%")
        }
        for c in cards {
            // Re-arm only when the projection clears by 2 h (or goes away) so
            // an edge-hovering pace can't ping-pong notifications.
            switch forecasts[c.id] {
            case let fc? where fc.exhaustsBeforeReset && (fc.marginHours ?? 0) <= -1:
                guard !paceAlerted.contains(c.id) else { continue }
                paceAlerted.insert(c.id)
                notify(
                    "Claude usage",
                    "\(c.label) is on pace to run out before it resets - "
                        + UsageForecast.format(fc))
            case let fc? where fc.exhaustsBeforeReset || (fc.marginHours ?? 99) < 2:
                continue
            default:
                paceAlerted.remove(c.id)
            }
        }
    }

    func notify(_ title: String, _ body: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "\"", with: "\\\"") }
        Shell.launch(
            "/usr/bin/osascript",
            ["-e", "display notification \"\(esc(body))\" with title \"\(esc(title))\""])
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
        var sev = worst.severity
        if sev == .normal, forecasts[worst.id]?.exhaustsBeforeReset == true {
            sev = .warning
        }
        // "PRO · Session 42%" once there is more than one saved account to tell
        // apart - and only while the name fits the bar's character budget.
        let showAccount = showAccountInMenuBar && accounts.count > 1
        let name = showAccount ? activeAccount ?? "" : ""
        let text = PanelReadout.text(account: name, label: worst.label, percent: worst.percent)
        return "\(dot(sev)) \(text)"
    }

    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()
}
