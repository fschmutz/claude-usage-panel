import ClaudeUsageCore
import Foundation

// The Codex vault in the model: what the popup and Settings render, and the
// three things the user can do with it. The stored properties live in
// UsageModel itself (extensions cannot declare them).
//
// Everything here is local file work - there is no network client on the Codex
// path at all - but walking sessions/** and reading transcript tails is still
// too much for the main actor, so the read runs detached, like the session
// index.

/// One refresh's worth of the Codex vault, read off the main actor.
private struct CodexRead: Sendable {
    let liveEmail: String?
    let active: String?
    let rows: [CodexRow]
    let usage: CodexStore.RecordedUsage
}

extension UsageModel {
    /// Re-read the Codex store and the newest recorded reading. Off by
    /// default: with the toggle off, nothing under the Codex home is opened.
    func refreshCodex() async {
        guard codexEnabled else {
            codexAccounts = []
            codexActive = nil
            codexLiveEmail = nil
            codexUsage = nil
            return
        }
        let read = await Task.detached(priority: .utility) { () -> CodexRead in
            // The codex CLI rotates its tokens as it runs; sync first so the
            // saved copy of the live login does not rot into a dead refresh
            // token.
            _ = try? CodexStore.syncBack()
            let active = CodexStore.liveName()
            let nowMs = Date().timeIntervalSince1970 * 1000
            return CodexRead(
                liveEmail: Codex.identity(CodexStore.readLiveAuth()).email, active: active,
                rows: CodexStore.list().map {
                    CodexRow(summary: $0.summary(nowMs: nowMs), active: $0.name == active)
                },
                usage: CodexStore.recordedUsage())
        }.value
        codexLiveEmail = read.liveEmail
        codexActive = read.active
        codexAccounts = read.rows
        codexUsage = read.usage
    }

    func switchCodexAccount(_ name: String) {
        do {
            let r = try CodexStore.switchTo(name)
            setOutcome(
                "codex:\(name)", ok: true,
                r.changed
                    ? "now on \(name) - restart codex to use it"
                    : "\(name) was already the Codex login")
            Task { await refreshCodex() }
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
            Task { await refreshCodex() }
        } catch {
            setOutcome("codex-save", ok: false, error.localizedDescription)
        }
    }

    func removeCodexAccount(_ name: String) {
        do {
            try CodexStore.remove(name)
            setOutcome("codex-remove:\(name)", ok: true, "removed")
            Task { await refreshCodex() }
        } catch {
            setOutcome("codex-remove:\(name)", ok: false, error.localizedDescription)
        }
    }
}
