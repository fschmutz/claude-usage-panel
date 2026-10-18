import ClaudeUsageCore
import SwiftUI

// Awake in the popup: what is holding this Mac up and for how long, the
// presets that start a session, +30m / Off while one is running, and the
// warning a session that ended without giving sleep back leaves behind.
// Shown only when Settings ▸ Awake turns it on.
struct AwakeSectionView: View {
    @ObservedObject var awake: AwakeController

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Awake").font(.system(size: 13, weight: .bold))
                Spacer()
                if awake.state.active {
                    Button("+30m") { awake.extend(seconds: 1800) }
                        .help("Push the deadline out by 30 minutes, never past the cap")
                    Button("Off") { awake.stop() }
                        .help("End the session and give this Mac its sleep back")
                } else {
                    ForEach(AwakeController.presets, id: \.self) { minutes in
                        Button(Awake.formatDuration(Double(minutes * 60))) {
                            awake.start(seconds: minutes * 60)
                        }
                        .help("Keep this Mac awake for \(minutes) minutes")
                    }
                    Button("While sessions") { awake.start(seconds: nil, whileSessions: true) }
                        .help("Hold until the last Claude Code session ends or the 12h cap")
                }
            }
            .font(.system(size: 11))

            Text(Self.stateLine(awake.state))
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(awake.state.active ? .cuAccent : .secondary)

            if awake.state.lid {
                Text("Lid mode on. Keep this Mac on a hard, ventilated surface.")
                    .font(.system(size: 11)).foregroundColor(.cuWarning)
            }
            if let recovery = awake.state.recovery {
                HStack(spacing: 6) {
                    Text(Self.recoveryLine(recovery))
                        .font(.system(size: 11)).foregroundColor(.cuCritical)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Recover") { awake.recover() }.font(.system(size: 11))
                }
            }
            if let err = awake.actionError {
                Text(err).font(.system(size: 11)).foregroundColor(.cuCritical)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { await awake.refresh() }
    }

    /// The words for the state line. The GNOME port and the terminal have
    /// their own: labels are per-port on purpose.
    static func stateLine(_ state: AwakeState) -> String {
        guard state.active else {
            guard let reason = state.endReason else { return "Off" }
            return "Off (last session ended: \(reason.rawValue))"
        }
        let parts = state.holds.map { hold -> String in
            hold == .timer
                ? "timer \(state.countdown)"
                : "\(state.sessions) live session\(state.sessions == 1 ? "" : "s")"
        }
        return "Awake - \(parts.joined(separator: " + "))"
    }

    static func recoveryLine(_ recovery: AwakeRecoveryNotice) -> String {
        "Sleep was not given back (\(recovery.codes.joined(separator: ", "))), "
            + "\(recovery.endedAgo) ago."
    }
}

/// Settings ▸ Awake: the opt-in toggle, the experimental lid switch, and the
/// floors the holder reads from disk.
struct AwakeSettingsSection: View {
    @ObservedObject var awake: AwakeController

    var body: some View {
        Section("Awake") {
            Toggle("Keep this Mac awake while Claude Code works", isOn: $awake.enabled)
            Text(
                "Adds an Awake section to the dropdown and a countdown to the menu bar. The Mac "
                    + "is held by a caffeinate child process, so the assertion is released "
                    + "whatever happens to this app, and a recovery backstop undoes anything a "
                    + "crashed session left behind. Install it with ./install.sh awake."
            )
            .font(.footnote).foregroundColor(.secondary)

            Toggle("Keep running with the lid closed (experimental)", isOn: $awake.lidEnabled)
            Text(
                "Needs the narrow sudoers rule ./install.sh awakelid installs (four exact pmset "
                    + "commands). A Mac that cannot sleep with the lid shut must stay on a hard, "
                    + "ventilated surface - never in a closed bag."
            )
            .font(.footnote).foregroundColor(.cuWarning)

            Stepper(
                "Low-power floor: \(awake.lowPowerFloor)%", value: $awake.lowPowerFloor,
                in: 0...100)
            Stepper("End floor: \(awake.endFloor)%", value: $awake.endFloor, in: 0...100)
            Stepper("Longest session: \(awake.maxHours)h", value: $awake.maxHours, in: 1...12)
            Text(
                "Below the low-power floor on battery the session asks for Low Power Mode; below "
                    + "the end floor it ends itself (0 turns that off). A battery that cannot be "
                    + "read twice in a row ends it too, and so does a critical thermal state."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }
}
