import AppKit
import ClaudeUsageCore
import SwiftUI

// MARK: - Palette (matches the GNOME extension)

extension Color {
    // Claude orange
    fileprivate static let cuAccent = Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
    fileprivate static let cuWarning = Color(red: 0xe0 / 255, green: 0xa4 / 255, blue: 0x58 / 255)
    fileprivate static let cuCritical = Color(red: 0xe5 / 255, green: 0x48 / 255, blue: 0x4d / 255)

    fileprivate static func severity(_ s: Severity) -> Color {
        switch s {
        case .normal: return .cuAccent
        case .warning: return .cuWarning
        case .critical: return .cuCritical
        }
    }
}

// MARK: - View model

@MainActor
final class UsageModel: ObservableObject {
    @Published var cards: [LimitCard] = []
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
    /// Init reads the plist back through these properties; only user edits
    /// (after init) may rewrite it.
    private var sessionPingReady = false
    /// Per-limit [epochMs, percent] samples - sparkline + burn-rate forecast.
    @Published private(set) var history: [String: [[Double]]] = [:]
    @Published private(set) var forecasts: [String: Forecast] = [:]
    private var alertFired: [String: Int] = [:]
    private var paceAlerted: Set<String> = []
    /// Enough for the forecast's 6 h window; ~15 h at the 10-minute default.
    private static let historyMax = 90

    private var loopTask: Task<Void, Never>?

    init() {
        refreshMinutes = UserDefaults.standard.object(forKey: "refreshMinutes") as? Int ?? 10
        showCost = UserDefaults.standard.bool(forKey: "showCost")
        alertsEnabled = UserDefaults.standard.object(forKey: "alertsEnabled") as? Bool ?? true
        cursorEnabled = UserDefaults.standard.bool(forKey: "cursorEnabled")
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

        restart()  // didSet does not fire from init, so start the loop explicitly
    }

    private func restart() {
        loopTask?.cancel()
        let minutes = max(1, refreshMinutes)
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64(minutes) * 60 * 1_000_000_000)
            }
        }
    }

    func refresh() async {
        do {
            let result = try await ClaudeUsage.fetch()
            cards = result.cards
            planLabel = result.planLabel
            errorText = nil
            updated = Self.timeFormatter.string(from: Date())
            recordHistory(result.cards)
            checkAlerts(result.cards)
        } catch {
            errorText = error.localizedDescription
        }

        guard showCost else {
            costText = nil
            return
        }
        costText = "computing…"
        if let cost = await Cost.fetchActiveCost() {
            costText = String(format: "$%.2f · %@ tokens", cost.costUSD, Self.compact(cost.tokens))
        } else {
            costText = "unavailable (install ccusage)"
        }

        await refreshCursor()
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

    private func applySessionPing() {
        guard sessionPingReady else { return }
        sessionPingError = SessionPing.apply(
            enabled: sessionPingEnabled,
            schedule: SessionPingSchedule(times: sessionPingTimes, days: sessionPingDays))
    }

    /// Re-read the agent plist into the model - the CLI installer edits the
    /// same file, so refresh before showing (and thus before any UI edit could
    /// rewrite the plist from a stale copy). Guarded so the read-back itself
    /// never triggers apply().
    func reloadSessionPing() {
        sessionPingReady = false
        let sp = SessionPing.read()
        sessionPingEnabled = sp.enabled
        sessionPingTimes = sp.schedule.times
        sessionPingDays = sp.schedule.days
        sessionPingReady = true
    }

    /// "06:00 11:00 · Mon-Fri" - the dropdown's one-line schedule summary.
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

    private func notify(_ title: String, _ body: String) {
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
        return "\(dot(sev)) \(short) \(worst.percent)%"
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

// MARK: - Reset-time helper

private func resetsText(_ date: Date?) -> String {
    guard let date else { return "" }
    let delta = Int(date.timeIntervalSinceNow)
    if delta <= 0 { return "Resetting…" }
    let d = delta / 86400
    let h = (delta % 86400) / 3600
    let m = (delta % 3600) / 60
    if d > 0 { return "Resets in \(d)d \(h)h" }
    if h > 0 { return String(format: "Resets in %dh %02dm", h, m) }
    return "Resets in \(m)m"
}

// MARK: - Views

private struct ProgressBar: View {
    let percent: Int
    let color: Color
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(color)
                    .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
            }
        }
        .frame(height: 8)
    }
}

private struct CardView: View {
    let card: LimitCard
    let spark: String
    let forecast: Forecast?
    var body: some View {
        let color = Color.severity(card.severity)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(card.label).font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.primary.opacity(0.85))
                if card.active { Circle().fill(color).frame(width: 6, height: 6) }
                Spacer()
                Text("\(card.percent)%").font(.system(size: 15, weight: .heavy))
                    .foregroundColor(color).monospacedDigit()
            }
            ProgressBar(percent: card.percent, color: color)
            HStack {
                // A per-model card (Fable) caps a share of the weekly pool rather
                // than adding one, so its reset line carries that note - same
                // reset as the all-models card it draws from.
                Text(
                    [resetsText(card.resetsAt), UsageNormalizer.poolNote(card)]
                        .filter { !$0.isEmpty }.joined(separator: " · ")
                ).font(.system(size: 11))
                    .foregroundColor(.secondary)
                Spacer()
                if !spark.isEmpty {
                    Text(spark).font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }
            // Burn-rate projection: amber when the limit runs out before its
            // reset, quiet when the pace outlasts it, absent when idle.
            if let fc = forecast {
                Text(UsageForecast.format(fc)).font(.system(size: 11))
                    .foregroundColor(fc.exhaustsBeforeReset ? .cuWarning : .secondary)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.05)))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(
                    card.severity == .critical ? color.opacity(0.35) : Color.primary.opacity(0.08)))
    }
}

struct PopupView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Claude usage").font(.system(size: 15, weight: .bold))
                Spacer()
                if let plan = model.planLabel, !plan.isEmpty {
                    Text(plan).font(.system(size: 12, weight: .semibold)).foregroundColor(
                        .secondary)
                }
            }

            if let err = model.errorText, model.cards.isEmpty {
                Text(err).font(.system(size: 12)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(model.cards) {
                    CardView(
                        card: $0, spark: model.spark(for: $0.id),
                        forecast: model.forecasts[$0.id])
                }
            }

            if let cost = model.costText {
                Text("Session cost: \(cost)").font(.system(size: 12, weight: .semibold))
            }
            Text("Updated \(model.updated)").font(.system(size: 11)).foregroundColor(.secondary)
            if model.sessionPingEnabled {
                Text("Session pings: \(model.sessionPingSummary)")
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }

            if model.cursorEnabled {
                CursorSectionView(model: model)
            }

            Divider()

            HStack {
                Toggle("Cost", isOn: $model.showCost).toggleStyle(.checkbox).font(.system(size: 12))
                Toggle("Alerts", isOn: $model.alertsEnabled).toggleStyle(.checkbox).font(
                    .system(size: 12))
                Spacer()
                Text("Refresh").font(.system(size: 12)).foregroundColor(.secondary)
                Picker("", selection: $model.refreshMinutes) {
                    ForEach([1, 5, 10, 15, 30, 60], id: \.self) { Text("\($0)m").tag($0) }
                }.labelsHidden().frame(width: 70)
            }

            HStack {
                Button {
                    Task { await model.refresh() }
                } label: {
                    Label("Refresh now", systemImage: "arrow.clockwise")
                }
                if #available(macOS 14.0, *) {
                    OpenSettingsButton()
                } else {
                    Button {
                        // An .accessory app is not active when the popup is
                        // clicked - without activate the window opens behind
                        // everything (or seemingly not at all).
                        NSApp.activate(ignoringOtherApps: true)
                        // Renamed across versions; try both.
                        if !NSApp.sendAction(
                            Selector(("showSettingsWindow:")), to: nil, from: nil)
                        {
                            NSApp.sendAction(
                                Selector(("showPreferencesWindow:")), to: nil, from: nil)
                        }
                    } label: {
                        Label("Settings…", systemImage: "gearshape")
                    }
                }
                Spacer()
                Button(role: .destructive) {
                    NSApplication.shared.terminate(nil)
                } label: {
                    Label("Quit", systemImage: "power")
                }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 12))
        }
        .padding(14)
        .frame(width: 340)
        .onAppear { model.reloadSessionPing() }
    }
}

// Settings opener for macOS 14+. SettingsLink alone does not activate an
// .accessory (menu-bar only) app, so the window opens behind everything and
// looks like it never appeared; the openSettings environment action plus an
// explicit activate brings it to front reliably.
@available(macOS 14.0, *)
private struct OpenSettingsButton: View {
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        Button {
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        } label: {
            Label("Settings…", systemImage: "gearshape")
        }
    }
}

// Cursor spend block in the dropdown (shown when enabled).
private struct CursorSectionView: View {
    @ObservedObject var model: UsageModel
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Cursor").font(.system(size: 13, weight: .bold))
            if let s = model.cursorSummary {
                if let pct = s.percent {
                    Text(
                        String(
                            format: "This cycle: $%.2f / $%.0f (%d%%) · %d members",
                            s.cycleUSD, s.limitUSD, pct, s.members)
                    ).font(.system(size: 12, weight: .semibold))
                    ProgressBar(
                        percent: pct,
                        color: pct >= 100 ? .cuCritical : (pct >= 90 ? .cuWarning : .cuAccent))
                } else {
                    Text(String(format: "This cycle: $%.2f · %d members", s.cycleUSD, s.members))
                        .font(.system(size: 12, weight: .semibold))
                }
                if let today = s.todayUSD {
                    Text(String(format: "Today: $%.2f", today))
                        .font(.system(size: 11)).foregroundColor(.secondary)
                }
                if let top = s.top {
                    Text(String(format: "Top: %@ $%.2f", top.email, top.usd))
                        .font(.system(size: 11)).foregroundColor(.secondary)
                }
            } else if let err = model.cursorError {
                Text("Cursor: \(err)").font(.system(size: 12)).foregroundColor(.secondary)
            } else {
                Text("Loading…").font(.system(size: 12)).foregroundColor(.secondary)
            }
        }
    }
}

// MARK: - Settings window

struct SettingsView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        Form {
            Section("General") {
                Picker("Refresh interval", selection: $model.refreshMinutes) {
                    ForEach([1, 5, 10, 15, 30, 60], id: \.self) { Text("\($0) min").tag($0) }
                }
                Toggle("Limit-crossing alerts (90% / 100%)", isOn: $model.alertsEnabled)
                Toggle("Show session cost (ccusage)", isOn: $model.showCost)
                Toggle("Start at login", isOn: $model.launchAtLogin)
            }
            Section("Session pings") {
                Toggle("Open the 5h session window on schedule", isOn: $model.sessionPingEnabled)
                if model.sessionPingEnabled {
                    ForEach(model.sessionPingTimes.indices, id: \.self) { i in
                        HStack {
                            DatePicker(
                                "Ping \(i + 1)", selection: timeBinding(i),
                                displayedComponents: .hourAndMinute)
                            Button {
                                model.sessionPingTimes.remove(at: i)
                            } label: {
                                Image(systemName: "minus.circle")
                            }
                            .buttonStyle(.borderless)
                            .disabled(model.sessionPingTimes.count == 1)
                        }
                    }
                    Button {
                        model.sessionPingTimes.append("09:00")
                    } label: {
                        Label("Add a ping", systemImage: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    HStack(spacing: 4) {
                        ForEach(1...7, id: \.self) { d in
                            Toggle(Self.dayNames[d - 1], isOn: dayBinding(d))
                                .toggleStyle(.button)
                                .font(.system(size: 11))
                        }
                    }
                }
                if let err = model.sessionPingError {
                    Text(err).font(.footnote).foregroundColor(.cuCritical)
                }
                Text(
                    "Pings claude (haiku, one turn) at these times so the 5-hour session "
                        + "window opens on your schedule, not at your first message. "
                        + "Same schedule as ./install.sh sessionping."
                )
                .font(.footnote).foregroundColor(.secondary)
            }
            Section("Cursor (optional)") {
                Toggle("Show Cursor team spend", isOn: $model.cursorEnabled)
                SecureField("Cursor Admin API key", text: $model.cursorApiKey)
                    .disabled(!model.cursorEnabled)
                Text("Create a key at cursor.com → your team → Settings → Admin API.")
                    .font(.footnote).foregroundColor(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .padding()
        .onAppear { model.reloadSessionPing() }
    }

    private static let dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

    private static let hhmm: DateFormatter = {
        let f = DateFormatter()
        // POSIX locale: "HH:mm" is a machine format for the plist (parsed by
        // install.sh's sed and an ASCII regex). Without it the user's 12-hour
        // preference or a non-ASCII-digit locale breaks the round-trip; the
        // DatePicker still localizes its own display.
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()

    /// Date <-> "HH:MM" bridge for one time row. Guards the index: SwiftUI can
    /// re-evaluate a row while the array is shrinking after a remove.
    private func timeBinding(_ i: Int) -> Binding<Date> {
        Binding(
            get: {
                guard i < model.sessionPingTimes.count,
                    let d = Self.hhmm.date(from: model.sessionPingTimes[i])
                else { return Self.hhmm.date(from: "09:00")! }
                return d
            },
            set: { d in
                guard i < model.sessionPingTimes.count else { return }
                model.sessionPingTimes[i] = Self.hhmm.string(from: d)
            })
    }

    /// Membership toggle for one weekday; the last remaining day can't be
    /// removed (an empty schedule would be invalid).
    private func dayBinding(_ d: Int) -> Binding<Bool> {
        Binding(
            get: { model.sessionPingDays.contains(d) },
            set: { on in
                if on {
                    model.sessionPingDays.insert(d)
                } else if model.sessionPingDays.count > 1 {
                    model.sessionPingDays.remove(d)
                }
            })
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)  // menu-bar only, no Dock icon
    }
}

@main
struct ClaudeUsagePanelApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = UsageModel()

    var body: some Scene {
        MenuBarExtra {
            PopupView(model: model)
        } label: {
            Text(model.titleText)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}
