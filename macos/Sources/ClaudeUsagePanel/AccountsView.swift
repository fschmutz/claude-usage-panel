import ClaudeUsageCore
import SwiftUI

// Named accounts in the popup and in Settings. The popup lists every saved
// login with its usage - the active one marked, the others one click from
// becoming the login - carries the auto-switch toggle so the option is
// reachable without opening Settings, and shows the inline notices for
// anything that needs one click to repair. Settings is where accounts are
// saved and removed.

/// Accounts block in the dropdown (shown once at least one login is saved).
struct AccountsSectionView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Accounts").font(.system(size: 13, weight: .bold))
                Spacer()
                if model.rotationTarget != nil {
                    Button("Next") { model.rotateAccount() }
                        .buttonStyle(.borderless)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.cuAccent)
                        .help("Switch to the next saved login")
                }
            }
            ForEach(model.accounts) { row in
                VStack(alignment: .leading, spacing: 1) {
                    if row.active {
                        line(row).help("Current login" + (row.email.map { ": \($0)" } ?? ""))
                    } else {
                        Button {
                            model.switchAccount(row.name)
                        } label: {
                            line(row).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .help("Switch to \(row.name)" + (row.email.map { " (\($0))" } ?? ""))
                    }
                    // The answer to a switch belongs on the row that asked for
                    // it, not in a line at the bottom of the popup.
                    if let o = model.outcome("switch:\(row.name)") { OutcomeText(o) }
                }
            }
            // One quiet line, only while there is a rotation to describe.
            if let next = model.rotationTarget {
                Text(
                    "Next walks the saved list in order and wraps - "
                        + Rotation.order(model.accounts.map(\.name)).joined(separator: " → ")
                        + ". Up next: \(next)."
                )
                .font(.system(size: 10)).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            if let o = model.outcome("rotate") { OutcomeText(o) }
            AccountNoticesView(model: model)
            if let err = model.accountsError {
                Text(err).font(.system(size: 11)).foregroundColor(.cuCritical)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func line(_ row: AccountRow) -> some View {
        HStack(spacing: 6) {
            // A filled dot marks the login in use; the others are actions.
            Text(row.active ? "\u{25cf}" : "\u{25cb}")
                .font(.system(size: 11))
                .foregroundColor(row.active ? .cuAccent : .secondary)
            Text(row.name).font(.system(size: 12, weight: row.active ? .bold : .semibold))
            if let email = row.email {
                Text(email).font(.system(size: 11)).foregroundColor(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Text(row.usageText).font(.system(size: 11))
                .foregroundColor(row.needsAttention ? .cuCritical : .secondary)
        }
    }
}

/// The inline notices, wherever the accounts are listed: one row per thing
/// that needs doing, each with the single button that does it.
struct AccountNoticesView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        ForEach(model.accountNotices) { notice in
            NoticeRow(
                severity: notice.severity,
                text: UsageModel.noticeText(notice),
                actionLabel: model.noticeButton(notice),
                action: { model.repair(notice) },
                outcome: model.outcome("notice:\(notice.id)"))
        }
    }
}

/// The "Accounts" section of the Settings form: save the current login under a
/// name, forget one, and tune the auto-switch.
struct AccountsSettingsSection: View {
    @ObservedObject var model: UsageModel
    @State private var newName = ""

    private var nameIsValid: Bool {
        Accounts.isValidName(newName.trimmingCharacters(in: .whitespaces))
    }

    var body: some View {
        Section("Accounts") {
            Toggle("Enable named accounts", isOn: $model.accountsEnabled)
            if !model.accountsEnabled {
                Text("Off by default - nothing account-related is shown until you turn it on.")
                    .font(.footnote).foregroundColor(.secondary)
            }
        }
        if model.accountsEnabled { accountsBody }
    }

    private var accountsBody: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    TextField("Save the current login as (e.g. PRO)", text: $newName)
                        .onSubmit(save)
                    Button("Save") { save() }.disabled(!nameIsValid)
                }
                if let o = model.outcome("save") { OutcomeText(o) }
            }
            if let email = model.liveLoginEmail {
                Text(
                    model.activeAccount.map { "Current login: \(email) - saved as \($0)" }
                        ?? "Current login: \(email) - not saved yet"
                )
                .font(.footnote).foregroundColor(.secondary)
            }
            // The same inline notices as the popup, from the same contract:
            // whichever surface the user is looking at says the same thing.
            AccountNoticesView(model: model)
            ForEach(model.accounts) { row in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(row.name).fontWeight(row.active ? .bold : .regular)
                        if let email = row.email {
                            Text(email).foregroundColor(.secondary).lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if let plan = row.plan { Text(plan).foregroundColor(.secondary) }
                        if row.needsAttention {
                            Text(row.usageText).foregroundColor(.cuCritical)
                        }
                        Spacer()
                        Button("Remove") { model.removeAccount(row.name) }
                    }
                    if let o = model.outcome("remove:\(row.name)") { OutcomeText(o) }
                }
            }
            Toggle("Switch accounts automatically", isOn: $model.accountsAutoSwitch)
                .disabled(model.accounts.count < 2)
            Stepper(
                "Switch when a limit reaches \(model.accountsSwitchThreshold)%",
                value: $model.accountsSwitchThreshold, in: 50...100, step: 5
            )
            .disabled(!model.accountsAutoSwitch)
            Toggle("Show the account name in the menu bar", isOn: $model.showAccountInMenuBar)
            Toggle(
                "Show the auto-switch button in the menu header", isOn: $model.showAutoSwitchInMenu)
            if let err = model.accountsError {
                Text(err).font(.footnote).foregroundColor(.cuCritical)
            }
            Text(
                "A saved login is the Claude Code credentials plus the account block of "
                    + "~/.claude.json, kept with mode 0600 under Application Support. Switching "
                    + "swaps exactly those two; settings, plugins and history stay. Sessions "
                    + "already running keep the old login until restarted. Idle logins are "
                    + "refreshed with their own refresh token, into this store only; the live "
                    + "one is never touched - Claude Code refreshes that."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }

    private func save() {
        guard nameIsValid else { return }
        model.saveCurrentAccount(newName)
        if model.outcome("save")?.ok == true { newName = "" }
    }
}
