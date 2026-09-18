import ClaudeUsageCore
import SwiftUI

// Named accounts in the popup and in Settings. The popup lists every saved
// login with its usage - the active one marked, the others one click from
// becoming the login - and carries the auto-switch toggle so the option is
// reachable without opening Settings. Settings is where accounts are saved
// and removed.

/// Accounts block in the dropdown (shown once at least one login is saved).
struct AccountsSectionView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Accounts").font(.system(size: 13, weight: .bold))
            ForEach(model.accounts) { row in
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
            }
            if model.accounts.count >= 2 && model.showAutoSwitchInMenu {
                Toggle(
                    "Auto-switch at \(model.accountsSwitchThreshold)%",
                    isOn: $model.accountsAutoSwitch
                )
                .toggleStyle(.checkbox)
                .font(.system(size: 12))
                .help(
                    "When the current account reaches \(model.accountsSwitchThreshold)% "
                        + "on any limit, switch to the saved account with the most room.")
            }
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
                .foregroundColor(row.expired || row.error != nil ? .cuCritical : .secondary)
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
            HStack {
                TextField("Save the current login as (e.g. PRO)", text: $newName)
                    .onSubmit(save)
                Button("Save") { save() }.disabled(!nameIsValid)
            }
            if let email = model.liveLoginEmail {
                Text(
                    model.activeAccount.map { "Current login: \(email) - saved as \($0)" }
                        ?? "Current login: \(email) - not saved yet"
                )
                .font(.footnote).foregroundColor(.secondary)
            }
            ForEach(model.accounts) { row in
                HStack {
                    Text(row.name).fontWeight(row.active ? .bold : .regular)
                    if let email = row.email {
                        Text(email).foregroundColor(.secondary).lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if let plan = row.plan { Text(plan).foregroundColor(.secondary) }
                    if row.expired {
                        Text("login expired").foregroundColor(.cuCritical)
                    }
                    Spacer()
                    Button("Remove") { model.removeAccount(row.name) }
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
            Toggle("Show the auto-switch toggle in the menu", isOn: $model.showAutoSwitchInMenu)
            if let err = model.accountsError {
                Text(err).font(.footnote).foregroundColor(.cuCritical)
            }
            Text(
                "A saved login is the Claude Code credentials plus the account block of "
                    + "~/.claude.json, kept with mode 0600 under Application Support. Switching "
                    + "swaps exactly those two; settings, plugins and history stay. Sessions "
                    + "already running keep the old login until restarted. Idle logins are "
                    + "refreshed with their own refresh token; the live one is Claude Code's."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
    }

    private func save() {
        guard nameIsValid else { return }
        model.saveCurrentAccount(newName)
        if model.accountsError == nil { newName = "" }
    }
}
