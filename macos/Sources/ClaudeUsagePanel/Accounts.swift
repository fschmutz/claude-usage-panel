import ClaudeUsageCore
import Foundation

// Named accounts in the model: what the popup and Settings render, the manual
// switch, and the opt-in auto-switch that moves to the freest saved account
// when the active one crosses the threshold. The stored properties live in
// UsageModel itself (extensions cannot declare them); everything else is here.

/// One saved account as the UI shows it.
struct AccountRow: Identifiable, Equatable, Sendable {
    var id: String { summary.name }
    let summary: AccountSummary
    let active: Bool
    /// Usage cards - the live ones for the active account, fetched with the
    /// stored token for the others; nil while unknown.
    let cards: [LimitCard]?
    let error: String?

    var name: String { summary.name }
    var email: String? { summary.email }
    var plan: String? { summary.plan }
    var expired: Bool { summary.tokenState == .expired }

    var usageText: String {
        if let cards { return Accounts.formatUsage(cards) }
        if expired { return "login expired" }
        return error ?? ""
    }
}

extension UsageModel {
    /// Re-read the store, fetch the other accounts' usage, refresh the status
    /// line's cache, then let the auto-switch decide. Runs at the end of every
    /// poll; the active account's cards are the ones just fetched.
    func refreshAccounts() async {
        // Off by default: no rows, no menu-bar prefix, no fetch.
        // Claude Code rotates the live login's tokens as it runs, and the
        // refresh token it replaces is revoked. A profile only written at save
        // time therefore rots while its account is the live one, and the switch
        // back fails with HTTP 400. Sync first, every poll: it compares and
        // writes only when the blob actually moved.
        if accountsEnabled { _ = try? AccountStore.syncBack() }
        let profiles = accountsEnabled ? AccountStore.list() : []
        liveLoginEmail =
            accountsEnabled ? AccountStore.readLiveAccount()?["emailAddress"] as? String : nil
        guard !profiles.isEmpty else {
            accounts = []
            activeAccount = nil
            return
        }
        let active = AccountStore.liveAccountName()
        activeAccount = active
        let nowMs = Date().timeIntervalSince1970 * 1000
        var rows: [AccountRow] = []
        var usage: [String: [LimitCard]] = [:]
        for p in profiles {
            let summary = p.summary(nowMs: nowMs)
            var cards: [LimitCard]?
            var fetchError: String?
            if p.name == active {
                cards = self.cards.isEmpty ? nil : self.cards
            } else if summary.tokenState != .expired {
                do {
                    cards = try await AccountStore.usageFor(p.name)
                } catch {
                    fetchError = Accounts.rowError(
                        name: p.name, message: error.localizedDescription)
                }
            }
            if let cards { usage[p.name] = cards }
            rows.append(
                AccountRow(
                    summary: summary, active: p.name == active, cards: cards, error: fetchError))
        }
        accounts = rows
        accountsError = nil
        AccountStore.writeUsageCache(usage)
        await autoSwitchIfNeeded(usage: usage, active: active)
    }

    private func autoSwitchIfNeeded(usage: [String: [LimitCard]], active: String?) async {
        guard accountsAutoSwitch, accounts.count >= 2 else { return }
        var worst: [String: Int?] = [:]
        for row in accounts { worst[row.name] = usage[row.name].flatMap(Accounts.worstPercent) }
        guard
            let decision = Accounts.autoSwitchTarget(
                active: active, worst: worst, threshold: accountsSwitchThreshold,
                lastSwitchMs: AccountStore.readLastSwitchMs(),
                nowMs: Date().timeIntervalSince1970 * 1000)
        else { return }
        do {
            let r = try await AccountStore.switchTo(decision.to)
            var body =
                "Switched \(decision.from) → \(decision.to): "
                + "\(decision.from) was at \(decision.activePercent)%"
            if r.running > 0 { body += Self.runningNote(r.running, decision.to) }
            notify("Claude usage", body)
            // This runs inside a poll; the re-poll as the new account queues
            // behind it instead of joining it.
            refreshSoon(after: 1)
        } catch {
            accountsError = error.localizedDescription
        }
    }

    static func runningNote(_ running: Int, _ to: String) -> String {
        let n = running == 1 ? "1 Claude Code session" : "\(running) Claude Code sessions"
        return " · \(n) still on the old login - restart to use \(to)"
    }

    /// Manual switch from the popup.
    func switchAccount(_ name: String) {
        Task {
            do {
                let r = try await AccountStore.switchTo(name)
                accountsError = nil
                if r.changed {
                    var body = "Now on \(name)" + (r.email.map { " (\($0))" } ?? "")
                    if r.running > 0 { body += Self.runningNote(r.running, name) }
                    notify("Claude usage", body)
                }
                await refresh()
            } catch {
                accountsError = error.localizedDescription
            }
        }
    }

    func saveCurrentAccount(_ name: String, force: Bool = false) {
        do {
            try AccountStore.saveCurrent(name.trimmingCharacters(in: .whitespaces), force: force)
            accountsError = nil
            Task { await refreshAccounts() }
        } catch {
            accountsError = error.localizedDescription
        }
    }

    func removeAccount(_ name: String) {
        do {
            try AccountStore.remove(name)
            accountsError = nil
            Task { await refreshAccounts() }
        } catch {
            accountsError = error.localizedDescription
        }
    }
}
