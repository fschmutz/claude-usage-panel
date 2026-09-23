import ClaudeUsageCore
import SwiftUI

// MARK: - Settings window

struct SettingsView: View {
    @ObservedObject var model: UsageModel

    // One tab per area, the same four as the GNOME preferences.
    var body: some View {
        TabView {
            SettingsTab {
                general
                UpdatesSection(updates: model.updates)
            }
            .tabItem { Label("General", systemImage: "slider.horizontal.3") }
            SettingsTab { AccountsSettingsSection(model: model) }
                .tabItem { Label("Accounts", systemImage: "person.2") }
            SettingsTab {
                todaysSessions
                SavedSessionsSection()
                SessionPingSection(pings: model.sessionPing)
            }
            .tabItem { Label("Sessions", systemImage: "terminal") }
            SettingsTab {
                Section("Cost") {
                    Toggle("Show session cost (ccusage)", isOn: $model.showCost)
                }
                CursorSection(model: model)
            }
            .tabItem { Label("Integrations", systemImage: "puzzlepiece.extension") }
        }
        .frame(width: 480, height: 560)
        .onAppear { model.sessionPing.reload() }
    }

    private var general: some View {
        Section("General") {
            Picker("Refresh interval", selection: $model.refreshMinutes) {
                ForEach([1, 5, 10, 15, 30, 60], id: \.self) { Text("\($0) min").tag($0) }
            }
            Toggle("Limit-crossing alerts (90% / 100%)", isOn: $model.alertsEnabled)
            Toggle("Start at login", isOn: $model.launchAtLogin)
            TextField("Run on limit crossing or reset", text: $model.eventCommand)
            Text(
                "%e event (threshold or reset) · %l label · %p percent · %t threshold · "
                    + "%k key · %% a literal %. Empty disables it. Values are shell-quoted "
                    + "when substituted."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }

    private var todaysSessions: some View {
        Section("Today's sessions") {
            Toggle("Show today's sessions in the dropdown", isOn: $model.showSessions)
            Picker("Open in", selection: $model.terminalChoice) {
                ForEach(TerminalLauncher.Choice.allCases, id: \.self) { choice in
                    Text(choice.label).tag(choice)
                }
            }
            Text(
                "Lists the sessions that spent the most tokens today, read from the local "
                    + "transcripts in ~/.claude/projects. Clicking one resumes it in a "
                    + "terminal, in its own project directory. claudectl session open uses "
                    + "the same terminal."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }
}

/// A scrolling grouped form: the body of one Settings tab.
private struct SettingsTab<Content: View>: View {
    private let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        Form { content }.formStyle(.grouped)
    }
}

// MARK: - Saved sessions

/// What `claudectl session` keeps: is the autosave scheduled, the newest
/// snapshot, and Reopen to bring it back as tabs.
private struct SavedSessionsSection: View {
    @StateObject private var saved = SavedSessions()

    var body: some View {
        Section("Saved sessions") {
            LabeledContent("Autosave", value: saved.autosave)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Newest snapshot")
                    Text(saved.newestLine).font(.footnote).foregroundColor(.secondary)
                }
                Spacer()
                Button("Reopen") { saved.reopen() }.disabled(!saved.canReopen)
            }
            Text(
                "claudectl session keeps the running Claude Code sessions in snapshots and "
                    + "reopens them as tabs of one terminal window."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
        .onAppear { saved.reload() }
    }
}

// MARK: - Session pings

private struct SessionPingSection: View {
    @ObservedObject var pings: SessionPingSettings

    var body: some View {
        Section("Session pings") {
            Toggle("Open the 5h session window on schedule", isOn: $pings.enabled)
            if !pings.lastPing.isEmpty {
                LabeledContent("Last ping", value: pings.lastPing)
            }
            if pings.enabled {
                ForEach(pings.times.indices, id: \.self) { i in
                    HStack {
                        DatePicker(
                            "Ping \(i + 1)", selection: timeBinding(i),
                            displayedComponents: .hourAndMinute)
                        Button {
                            pings.times.remove(at: i)
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(pings.times.count == 1)
                    }
                }
                HStack {
                    Button {
                        pings.times.append("09:00")
                    } label: {
                        Label("Add a ping", systemImage: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    Spacer()
                    // Stop making the user guess: a 5h window is anchored to
                    // its first message, so the only real choice is where the
                    // chain starts. Compute it from the working day instead.
                    Button {
                        pings.suggestTimes()
                    } label: {
                        Label("Suggest times", systemImage: "wand.and.stars")
                    }
                    .buttonStyle(.borderless)
                }
                Text(pings.coverage)
                    .font(.footnote).foregroundColor(.secondary)
                HStack(spacing: 4) {
                    ForEach(1...7, id: \.self) { d in
                        Toggle(SessionPingStatus.dayNames[d - 1], isOn: dayBinding(d))
                            .toggleStyle(.button)
                            .font(.system(size: 11))
                    }
                }
            }
            if let err = pings.error {
                Text(err).font(.footnote).foregroundColor(.cuCritical)
            }
            Text(
                "Pings claude (haiku, one turn) at these times so the 5-hour session "
                    + "window opens on your schedule, not at your first message. "
                    + "Same schedule as ./install.sh sessionping."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }

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
                guard i < pings.times.count, let d = Self.hhmm.date(from: pings.times[i])
                else { return Self.hhmm.date(from: "09:00")! }
                return d
            },
            set: { d in
                guard i < pings.times.count else { return }
                pings.times[i] = Self.hhmm.string(from: d)
            })
    }

    /// Membership toggle for one weekday; the last remaining day can't be
    /// removed (an empty schedule would be invalid).
    private func dayBinding(_ d: Int) -> Binding<Bool> {
        Binding(
            get: { pings.days.contains(d) },
            set: { on in
                if on {
                    pings.days.insert(d)
                } else if pings.days.count > 1 {
                    pings.days.remove(d)
                }
            })
    }
}

// MARK: - Updates

private struct UpdatesSection: View {
    @ObservedObject var updates: UpdateState

    var body: some View {
        Section("Updates") {
            if let u = updates.status {
                HStack {
                    Text(u.summary)
                        .foregroundColor(u.needsAttention ? .cuCritical : .secondary)
                    Spacer()
                    if updates.busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(u.updateAvailable ? "Update now" : "Check now") {
                            Task {
                                if u.updateAvailable {
                                    await updates.apply()
                                } else {
                                    await updates.reload()
                                }
                            }
                        }
                    }
                }
                // The reason auto-update is not acting is the whole point of
                // this section: without it a paused checkout is
                // indistinguishable from a current one.
                if u.blocked {
                    Text(
                        "The daily check will not touch this checkout until that is "
                            + "resolved. It only ever fast-forwards a clean checkout."
                    )
                    .font(.footnote).foregroundColor(.secondary)
                }
                Text("Last checked \(u.lastCheck)   ·   \(u.checkout)")
                    .font(.footnote).foregroundColor(.secondary)
            } else {
                HStack {
                    Text(updates.error ?? "Not checked yet")
                        .font(.footnote).foregroundColor(.secondary)
                    Spacer()
                    if updates.busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Button("Check now") { Task { await updates.reload() } }
                    }
                }
            }
        }
    }
}

// MARK: - Cursor

/// The key is committed on Save / return, not per keystroke: each commit is a
/// Keychain write and a Cursor API round-trip.
private struct CursorSection: View {
    @ObservedObject var model: UsageModel
    @State private var draft = ""

    var body: some View {
        Section("Cursor (optional)") {
            Toggle("Show Cursor team spend", isOn: $model.cursorEnabled)
            HStack {
                SecureField("Cursor Admin API key", text: $draft)
                    .onSubmit(commit)
                Button("Save") { commit() }.disabled(draft == model.cursorApiKey)
            }
            .disabled(!model.cursorEnabled)
            Text("Create a key at cursor.com → your team → Settings → Admin API.")
                .font(.footnote).foregroundColor(.secondary)
        }
        .onAppear { draft = model.cursorApiKey }
    }

    private func commit() {
        guard draft != model.cursorApiKey else { return }
        model.cursorApiKey = draft
    }
}
