import ClaudeUsageCore
import SwiftUI

// Pause / resume in the popup: Pause all, Resume all, the summary of the
// last request ("5/7 safe") and one row per session with where it stands
// and its own Pause button. Shown only when Settings ▸ Sessions turns it on.
struct PauseSectionView: View {
    @ObservedObject var pause: PauseState

    var body: some View {
        CollapsibleSection("pause", title: "Pause sessions", count: pause.rows.count) {
            HStack {
                Button("Pause all") { pause.pauseAll() }
                    .disabled(!pause.canAct || !pause.rows.contains(where: \.live))
                    .help("Send the pause protocol to every running Claude Code session")
                Button("Resume all") { pause.resumeAll() }
                    .disabled(!pause.canAct)
                    .help(
                        "Running sessions get the resume protocol; closed ones with a "
                            + "checkpoint reopen in a terminal")
            }
            .font(.system(size: 11))
        } content: {
            if let line = pause.summaryLine {
                Text(line)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(summaryColor)
            }
            ForEach(pause.rows) { row in
                HStack(spacing: 6) {
                    Text(row.name).font(.system(size: 12, weight: .semibold))
                    Text(row.label)
                        .font(.system(size: 11))
                        .foregroundColor(color(row.row?.state))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer()
                    if row.live {
                        Button("Pause") { pause.pause(row) }
                            .font(.system(size: 11))
                            .disabled(!pause.canAct)
                    }
                }
                .help("\(row.label) · \(row.cwd)")
            }
            if let err = pause.actionError ?? pause.readError {
                Text(err).font(.system(size: 11)).foregroundColor(.cuCritical)
            }
        }
        .task { await pause.refresh() }
    }

    private var summaryColor: Color {
        guard let s = pause.status?.summary else { return .primary }
        if s.ok { return .cuAccent }
        return s.done ? .cuWarning : .primary
    }

    private func color(_ state: PauseRowState?) -> Color {
        switch state {
        case .safe?, .resumed?: return .cuAccent
        case .notSafe?, .lost?: return .cuCritical
        case .expired?, .unarmed?: return .cuWarning
        default: return .secondary
        }
    }
}

/// Settings ▸ Sessions: the opt-in toggle and what it needs.
struct PauseSettingsSection: View {
    @ObservedObject var pause: PauseState

    var body: some View {
        Section("Pause sessions") {
            Toggle("Show Pause all / Resume all in the dropdown", isOn: $pause.enabled)
            Text(
                "Sends the pause protocol to every running Claude Code session: each one "
                    + "stops its jobs, writes a checkpoint and answers SAFE or NOT SAFE, shown "
                    + "per session. Resume reopens them from their checkpoint. It needs the "
                    + "hooks ./install.sh pause installs; they keep one idle node process per "
                    + "session and run node on every tool call."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }
}
