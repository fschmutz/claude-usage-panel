import ClaudeUsageCore
import SwiftUI

// The Codex block in the popup and its Settings section. A SIBLING of the
// Claude accounts, never a takeover: it is off by default, it sits below
// everything Claude, and it is drawn from its own store. Every figure it shows
// carries the est. badge and the instant it was captured, because OpenAI
// publishes no usage endpoint to read - see CodexStore.recordedUsage.

/// One saved Codex login as the UI shows it.
struct CodexRow: Identifiable, Equatable, Sendable {
    var id: String { summary.name }
    let summary: CodexSummary
    let active: Bool

    var name: String { summary.name }
    var email: String? { summary.email }
    var plan: String { summary.planLabel }
    var needsLogin: Bool { summary.tokenState == .expired }
}

/// What the popup shows for Codex: the saved logins, and the last reading the
/// codex CLI recorded.
struct CodexSectionView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("OpenAI Codex").font(.system(size: 13, weight: .bold))
                Text(Provenances.codex.badge)
                    .font(.system(size: 9)).foregroundColor(.secondary)
                    .help(Provenances.codex.explanation)
                Spacer()
            }
            ForEach(model.codexAccounts) { row in
                VStack(alignment: .leading, spacing: 1) {
                    if row.active {
                        line(row).help("Current Codex login" + (row.email.map { ": \($0)" } ?? ""))
                    } else {
                        Button {
                            model.switchCodexAccount(row.name)
                        } label: {
                            line(row).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .help("Switch the codex CLI to \(row.name)")
                    }
                    if let o = model.outcome("codex:\(row.name)") { OutcomeText(o) }
                }
            }
            if model.codexAccounts.isEmpty {
                Text("No saved Codex logins - Settings ▸ Codex saves the current one.")
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            codexUsage
        }
    }

    @ViewBuilder
    private var codexUsage: some View {
        if let recorded = model.codexUsage {
            if let reason = recorded.reason {
                Text(Self.unavailable(reason))
                    .font(.system(size: 11)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(recorded.cards) { card in
                    HStack {
                        Text(card.label).font(.system(size: 12))
                        Spacer()
                        Text("\(card.percent)%")
                            .font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        Text(ResetCountdown.text(card.resetsAt))
                            .font(.system(size: 11)).foregroundColor(.secondary)
                    }
                }
                if let at = recorded.capturedAt {
                    Text(
                        "Recorded by the codex CLI at \(UsageModel.timeFormatter.string(from: at))"
                    )
                    .font(.system(size: 10)).foregroundColor(.secondary)
                }
            }
        }
    }

    private func line(_ row: CodexRow) -> some View {
        HStack(spacing: 6) {
            Text(row.active ? "\u{25cf}" : "\u{25cb}")
                .font(.system(size: 11))
                .foregroundColor(row.active ? .cuAccent : .secondary)
            Text(row.name).font(.system(size: 12, weight: row.active ? .bold : .semibold))
            if let email = row.email {
                Text(email).font(.system(size: 11)).foregroundColor(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            if row.needsLogin {
                Text("codex login").font(.system(size: 11)).foregroundColor(.cuCritical)
            } else if !row.plan.isEmpty {
                Text(row.plan).font(.system(size: 11)).foregroundColor(.secondary)
            }
        }
    }

    static func unavailable(_ reason: CodexStore.Unavailable) -> String {
        switch reason {
        case .noSessions: return "No Codex sessions on this Mac yet - nothing has recorded a limit."
        case .noSnapshot: return "The recent Codex sessions carry no rate limits."
        case .stale: return "The newest recorded Codex reading is too old to mean anything now."
        }
    }
}

/// The "Codex" tab of Settings: the opt-in, the vault, and a plain statement
/// of what is read and what is not sent anywhere.
struct CodexSettingsSection: View {
    @ObservedObject var model: UsageModel
    @State private var newName = ""

    private var nameIsValid: Bool {
        Accounts.isValidName(newName.trimmingCharacters(in: .whitespaces))
    }

    var body: some View {
        Section("OpenAI Codex (optional)") {
            Toggle("Show saved Codex logins", isOn: $model.codexEnabled)
            if !model.codexEnabled {
                Text(
                    "Off by default. Claude Code is what this app is for; Codex is a sibling "
                        + "section, and nothing Codex-related is read until you turn it on."
                )
                .font(.footnote).foregroundColor(.secondary)
            }
        }
        if model.codexEnabled { body2 }
    }

    private var body2: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    TextField("Save the current Codex login as (e.g. PLUS)", text: $newName)
                        .onSubmit(save)
                    Button("Save") { save() }.disabled(!nameIsValid)
                }
                if let o = model.outcome("codex-save") { OutcomeText(o) }
            }
            if let email = model.codexLiveEmail {
                Text(
                    model.codexActive.map { "Current Codex login: \(email) - saved as \($0)" }
                        ?? "Current Codex login: \(email) - not saved yet"
                )
                .font(.footnote).foregroundColor(.secondary)
            } else {
                Text("No Codex login found. Run `codex login` first.")
                    .font(.footnote).foregroundColor(.secondary)
            }
            ForEach(model.codexAccounts) { row in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(row.name).fontWeight(row.active ? .bold : .regular)
                        if let email = row.email {
                            Text(email).foregroundColor(.secondary).lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if !row.plan.isEmpty { Text(row.plan).foregroundColor(.secondary) }
                        if row.needsLogin {
                            Text("needs `codex login`").foregroundColor(.cuCritical)
                        }
                        Spacer()
                        Button("Remove") { model.removeCodexAccount(row.name) }
                    }
                    if let o = model.outcome("codex-remove:\(row.name)") { OutcomeText(o) }
                }
            }
            // Say exactly what is read and what is not sent. A vault that
            // holds someone else's OAuth tokens owes them this paragraph.
            Text(
                "Reads \(CodexStore.authURL.path) - the file the codex CLI writes when you sign "
                    + "in with ChatGPT - and the read-only session transcripts under "
                    + "\(CodexStore.sessionsURL.path). Saved copies are kept mode 0600 under "
                    + "Application Support, next to (never inside) the Claude store. Nothing is "
                    + "uploaded, and no token is ever minted here: a lapsed login is reported, "
                    + "and `codex login` is the fix."
            )
            .font(.footnote).foregroundColor(.secondary)
            Text(
                "OpenAI publishes no plan-usage endpoint, so the percentages above are the ones "
                    + "the codex CLI recorded when the API last returned them - labelled est. "
                    + "and stamped with when. This app will not show a Codex number it did not "
                    + "get from somewhere real."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }

    private func save() {
        guard nameIsValid else { return }
        model.saveCurrentCodexAccount(newName)
        if model.outcome("codex-save")?.ok == true { newName = "" }
    }
}
