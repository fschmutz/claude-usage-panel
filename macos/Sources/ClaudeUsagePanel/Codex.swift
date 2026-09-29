import ClaudeUsageCore
import Foundation

// The Codex vault in the model: what the popup and Settings render, and the
// three things the user can do with it. The stored properties live in
// UsageModel itself (extensions cannot declare them).
//
// Everything here is local file work - there is no network client on the Codex
// path at all - so it runs synchronously at the end of a poll rather than
// adding another await to it.

extension UsageModel {
    /// Re-read the Codex store and the newest recorded reading. Off by
    /// default: with the toggle off, nothing under the Codex home is opened.
    func refreshCodex() {
        guard codexEnabled else {
            codexAccounts = []
            codexActive = nil
            codexLiveEmail = nil
            codexUsage = nil
            return
        }
        // The codex CLI rotates its tokens as it runs; sync first so the saved
        // copy of the live login does not rot into a dead refresh token.
        _ = try? CodexStore.syncBack()
        let live = CodexStore.readLiveAuth()
        codexLiveEmail = Codex.identity(live).email
        let active = CodexStore.liveName()
        codexActive = active
        let nowMs = Date().timeIntervalSince1970 * 1000
        codexAccounts = CodexStore.list().map {
            CodexRow(summary: $0.summary(nowMs: nowMs), active: $0.name == active)
        }
        codexUsage = CodexStore.recordedUsage()
    }

    func switchCodexAccount(_ name: String) {
        do {
            let r = try CodexStore.switchTo(name)
            setOutcome(
                "codex:\(name)", ok: true,
                r.changed
                    ? "now on \(name) - restart codex to use it"
                    : "\(name) was already the Codex login")
            refreshCodex()
        } catch {
            setOutcome(
                "codex:\(name)", ok: false,
                Accounts.rowError(name: name, message: error.localizedDescription))
        }
    }

    func saveCurrentCodexAccount(_ name: String) {
        do {
            let p = try CodexStore.saveCurrent(name.trimmingCharacters(in: .whitespaces))
            setOutcome("codex-save", ok: true, "saved as \(p.name)")
            refreshCodex()
        } catch {
            setOutcome("codex-save", ok: false, error.localizedDescription)
        }
    }

    func removeCodexAccount(_ name: String) {
        do {
            try CodexStore.remove(name)
            setOutcome("codex-remove:\(name)", ok: true, "removed")
            refreshCodex()
        } catch {
            setOutcome("codex-remove:\(name)", ok: false, error.localizedDescription)
        }
    }
}
