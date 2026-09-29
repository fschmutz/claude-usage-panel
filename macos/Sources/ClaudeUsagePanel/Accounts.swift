import AppKit
import ClaudeUsageCore
import Foundation

// Named accounts in the model: what the popup and Settings render, the manual
// switch and the rotation, the inline notices with their one repair each, and
// the opt-in auto-switch that moves to the freest saved account when the
// active one crosses the threshold. The stored properties live in UsageModel
// itself (extensions cannot declare them); everything else is here.

/// One saved account as the UI shows it.
struct AccountRow: Identifiable, Equatable, Sendable {
    var id: String { summary.name }
    let summary: AccountSummary
    let active: Bool
    /// Usage cards - the live ones for the active account, fetched with the
    /// stored token for the others; nil while unknown.
    let cards: [LimitCard]?
    let error: String?
    /// The stored login's own dates folded together with what the last fetch
    /// said, so a token the endpoint refused does not read as valid.
    let health: AccountHealth

    var name: String { summary.name }
    var email: String? { summary.email }
    var plan: String? { summary.plan }
    var expired: Bool { health == .expired }
    var needsAttention: Bool { health.needsAttention }

    /// The right-hand column: the figures when there are any, else the reason
    /// there are not. Never the previous poll's figures - a row whose login
    /// broke must stop looking like a row that is fine.
    var usageText: String {
        if let cards, !cards.isEmpty { return Accounts.formatUsage(cards) }
        switch health {
        case .expired: return "login expired"
        case .refreshFailed: return "refresh failed"
        case .unreachable: return error ?? "no reading"
        case .valid, .stale: return error ?? ""
        }
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
        let liveAccount = accountsEnabled ? AccountStore.readLiveAccount() : nil
        liveLoginEmail = liveAccount?["emailAddress"] as? String
        guard !profiles.isEmpty else {
            accounts = []
            activeAccount = nil
            accountNotices =
                accountsEnabled
                ? Notices.accountNotices(rows: [], liveEmail: liveLoginEmail) : []
            return
        }
        let active = AccountStore.liveAccountName()
        activeAccount = active
        let nowMs = Date().timeIntervalSince1970 * 1000
        var rows: [AccountRow] = []
        var usage: [String: [LimitCard]] = [:]
        for p in profiles {
            let summary = p.summary(nowMs: nowMs)
            var result = AccountUsage.unread
            if p.name == active {
                result = AccountUsage(
                    cards: self.cards.isEmpty ? nil : self.cards, errorCode: nil, message: nil)
            } else if summary.tokenState != .expired {
                // A parked account's stale token is refreshed here - into OUR
                // store only. The live login is Claude Code's to refresh, and
                // accessTokenFor returns it before any exchange can happen.
                result = await AccountStore.usageFor(p.name, endpoint: endpoint)
            }
            if let cards = result.cards { usage[p.name] = cards }
            rows.append(
                AccountRow(
                    summary: summary, active: p.name == active, cards: result.cards,
                    error: result.message.map {
                        Accounts.rowError(name: p.name, message: $0)
                    },
                    // A live token's refusal is Claude Code's to refresh.
                    health: Notices.health(
                        tokenState: summary.tokenState, errorCode: result.errorCode,
                        live: result.live)))
        }
        accounts = rows
        accountsError = nil
        accountNotices = Notices.accountNotices(
            rows: rows.map { (name: $0.name, health: $0.health) },
            liveEmail: liveLoginEmail, activeName: active,
            pendingTo: AccountStore.readPendingSwitch()?.to,
            torn: Accounts.isTorn(profiles: profiles, name: active ?? "", account: liveAccount)
                && active != nil)
        AccountStore.writeUsageCache(usage)
        await autoSwitchIfNeeded(usage: usage, active: active)
    }

    private func autoSwitchIfNeeded(usage: [String: [LimitCard]], active: String?) async {
        guard accountsAutoSwitch, accounts.count >= 2 else { return }
        var worst: [String: Int?] = [:]
        let now = Date()
        for row in accounts {
            worst[row.name] = usage[row.name].flatMap { Accounts.worstPercent($0, now: now) }
        }
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

    // MARK: - Button-local outcomes
    //
    // The answer to "did that work?" goes beside the control that asked, and
    // clears itself: a success that never clears becomes furniture, and a
    // failure still on screen two actions later is a lie. The global
    // `accountsError` line stays for the things no single control owns.

    /// The outcome to draw next to `control`, or nil.
    func outcome(_ control: String) -> ControlOutcome? {
        guard let o = outcomes[control],
            o.visible(nowMs: Date().timeIntervalSince1970 * 1000)
        else { return nil }
        return o
    }

    /// Record one, and schedule the repaint that makes it disappear. Any
    /// earlier outcome goes: the previous answer is not about this action.
    func setOutcome(_ control: String, ok: Bool, _ text: String) {
        outcomes = [
            control: ControlOutcome(
                control: control, ok: ok, text: text,
                atMs: Date().timeIntervalSince1970 * 1000)
        ]
        outcomeTask?.cancel()
        outcomeTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ControlOutcome.ttlMs) * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.outcomes = [:]
        }
    }

    // MARK: - Switching

    /// Manual switch from the popup. `control` is the row that asked, so the
    /// answer lands on that row.
    func switchAccount(_ name: String, control: String? = nil) {
        let answersAt = control ?? "switch:\(name)"
        Task {
            do {
                let r = try await AccountStore.switchTo(name)
                accountsError = nil
                if r.changed {
                    var body = "Now on \(name)" + (r.email.map { " (\($0))" } ?? "")
                    if r.running > 0 { body += Self.runningNote(r.running, name) }
                    notify("Claude usage", body)
                    setOutcome(answersAt, ok: true, "now on \(name)")
                } else {
                    setOutcome(answersAt, ok: true, "\(name) was already the login")
                }
                await refresh()
            } catch {
                accountsError = nil
                setOutcome(
                    answersAt, ok: false,
                    Accounts.rowError(name: name, message: error.localizedDescription))
            }
        }
    }

    /// The account the saved list walks to next, wrapping - what the "Next"
    /// control does and what the line under it describes. Nil below two.
    var rotationTarget: String? {
        Rotation.next(accounts.map(\.name), active: activeAccount)
    }

    func rotateAccount() {
        guard let next = rotationTarget else { return }
        switchAccount(next, control: "rotate")
    }

    func saveCurrentAccount(_ name: String, force: Bool = false, control: String = "save") {
        do {
            let p = try AccountStore.saveCurrent(
                name.trimmingCharacters(in: .whitespaces), force: force)
            accountsError = nil
            setOutcome(control, ok: true, "saved as \(p.name)")
            Task { await refreshAccounts() }
        } catch {
            setOutcome(control, ok: false, error.localizedDescription)
        }
    }

    func removeAccount(_ name: String) {
        do {
            try AccountStore.remove(name)
            accountsError = nil
            setOutcome("remove:\(name)", ok: true, "removed")
            Task { await refreshAccounts() }
        } catch {
            setOutcome("remove:\(name)", ok: false, error.localizedDescription)
        }
    }

    // MARK: - Notice repairs
    //
    // Every notice carries exactly one action, and this is where each one is
    // carried out. `relogin` is the only one the app cannot do itself - no
    // client of this repo ever runs a login - so it hands over the command.

    func repair(_ notice: AccountNotice) {
        let control = "notice:\(notice.id)"
        switch notice.action {
        case .finishSwitch, .repairLogin:
            guard let name = notice.arg else { return }
            // Re-running the switch is the repair: switchPlan answers `repair`
            // for a torn login and finishes an interrupted one.
            switchAccount(name, control: control)
        case .save:
            saveCurrentAccount(parkNameFor(notice.arg), control: control)
        case .relogin:
            let command = "claude auth login"
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
            setOutcome(control, ok: true, "copied `\(command)` - run it, then save the login again")
        case .retry:
            Task {
                await refresh()
                let still = accounts.first { $0.name == notice.arg }?.health
                setOutcome(
                    control, ok: still == .valid || still == .stale,
                    still == .valid || still == .stale ? "read it" : "still no reading")
            }
        }
    }

    /// The sentence a notice row shows. Kept in the view layer's language
    /// rather than in the shared contract, which pins only which notice
    /// appears and what its button does.
    static func noticeText(_ notice: AccountNotice) -> String {
        let who = notice.arg ?? "?"
        switch notice.kind {
        case .pendingSwitch:
            return "Incomplete switch to \(who) - the login may be half-installed."
        case .tornLogin:
            return "\(who)'s credentials and account block disagree."
        case .unsavedLogin:
            return "Signed in as \(who), but this login is not saved."
        case .loginExpired:
            return "\(who): login expired - a new sign-in is the only fix."
        case .refreshFailed:
            return "\(who): the stored login was refused - sign in again."
        case .unreachable:
            return "\(who): no usage reading right now."
        }
    }

    /// The popup has nowhere to type a name, and the name a switch would have
    /// parked this login under is the obvious one to offer - so the button
    /// says it and saves exactly that.
    func parkNameFor(_ email: String?) -> String {
        Accounts.parkName(email: email, taken: accounts.map(\.name))
    }

    /// The one button on that row.
    func noticeButton(_ notice: AccountNotice) -> String {
        switch notice.action {
        case .finishSwitch: return "Finish switch"
        case .repairLogin: return "Repair"
        case .save: return "Save as \(parkNameFor(notice.arg))"
        case .relogin: return "Copy sign-in command"
        case .retry: return "Retry"
        }
    }
}
