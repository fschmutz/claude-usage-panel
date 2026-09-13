import AppKit
import ClaudeUsageCore
import Network
import SwiftUI

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
                TextField("Run on limit crossing or reset", text: $model.eventCommand)
                Text(
                    "%e event (threshold or reset) · %l label · %p percent · %t threshold · "
                        + "%k key · %% a literal %. Empty disables it. Values are shell-quoted "
                        + "when substituted."
                )
                .font(.footnote).foregroundColor(.secondary)
            }
            Section("Today's sessions") {
                Toggle("Show today's sessions in the dropdown", isOn: $model.showSessions)
                Picker("Open in", selection: $model.terminalChoice) {
                    ForEach(TerminalLauncher.Choice.allCases, id: \.self) { choice in
                        Text(choice.label).tag(choice)
                    }
                }
                .disabled(!model.showSessions)
                Text(
                    "Lists the sessions that spent the most tokens today, read from the local "
                        + "transcripts in ~/.claude/projects. Clicking one resumes it in a "
                        + "terminal, in its own project directory."
                )
                .font(.footnote).foregroundColor(.secondary)
            }
            Section("Session pings") {
                Toggle("Open the 5h session window on schedule", isOn: $model.sessionPingEnabled)
                if !model.lastPing.isEmpty {
                    LabeledContent("Last ping", value: model.lastPing)
                }
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
                    HStack {
                        Button {
                            model.sessionPingTimes.append("09:00")
                        } label: {
                            Label("Add a ping", systemImage: "plus.circle")
                        }
                        .buttonStyle(.borderless)
                        Spacer()
                        // Stop making the user guess: a 5h window is anchored to
                        // its first message, so the only real choice is where the
                        // chain starts. Compute it from the working day instead.
                        Button {
                            model.suggestSessionPingTimes()
                        } label: {
                            Label("Suggest times", systemImage: "wand.and.stars")
                        }
                        .buttonStyle(.borderless)
                    }
                    Text(model.sessionPingCoverage)
                        .font(.footnote).foregroundColor(.secondary)
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
            AccountsSettingsSection(model: model)
            Section("Updates") {
                if let u = model.updateStatus {
                    HStack {
                        Text(u.summary)
                            .foregroundColor(u.needsAttention ? .cuCritical : .secondary)
                        Spacer()
                        if model.updateBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            Button(u.updateAvailable ? "Update now" : "Check now") {
                                if u.updateAvailable {
                                    model.applyUpdate()
                                } else {
                                    model.reloadUpdateStatus()
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
                    Text(model.updateError ?? "Checking…")
                        .font(.footnote).foregroundColor(.secondary)
                }
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
        .onAppear {
            model.reloadSessionPing()
            model.reloadUpdateStatus()
        }
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
