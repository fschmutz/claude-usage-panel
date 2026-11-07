import Foundation

// After the usage fetch. The popup's other sections (session cost, today's
// sessions, Cursor spend, saved accounts, Codex) do not need the Claude token,
// and the account switcher is the very fix for an expired one, so they
// refresh after every poll, failed or not. The poll loop sleeps only once they
// settle, so each one gets a deadline: one hung child process must never stop
// the panel polling. Mirrors the GNOME extension's lib/pure/poll.js
// `sectionCards` / `refreshSections`, pinned by tests/fixtures/poll.json
// "sections".

public enum PollSections {
    /// How long one section may take before the poll stops waiting for it.
    public static let deadlineSeconds: TimeInterval = 90

    public enum Outcome: String, Sendable {
        case done, failed, timeout
    }

    public struct Report: Sendable, Equatable {
        public let section: String
        public let outcome: Outcome
        /// What a failed section threw, for the log.
        public let error: String?

        public init(section: String, outcome: Outcome, error: String? = nil) {
            self.section = section
            self.outcome = outcome
            self.error = error
        }
    }

    public typealias Refresh = @Sendable () async throws -> Void

    /// The cards the account section should treat as the live login's usage:
    /// the fresh ones, the last reading while a retryable failure keeps it on
    /// screen, else none (usage unknown - no figures, no auto-switch decision
    /// from them). `failureCode` is nil for a successful poll.
    public static func sectionCards(
        failureCode: String?, cards: [LimitCard], latest: [LimitCard]
    ) -> [LimitCard] {
        guard let code = failureCode else { return cards }
        if PollSchedule.isRetryable(code: code) && !latest.isEmpty { return latest }
        return []
    }

    /// Run every section side by side and return once each has finished,
    /// failed or run past `deadline` seconds, in the order given. Never
    /// throws. A section cut off at its deadline is cancelled but not
    /// awaited: a refresh blocked in a child process cannot be interrupted,
    /// and the poll must not wait for it.
    public static func run(
        _ sections: [(name: String, refresh: Refresh)], deadline: TimeInterval = deadlineSeconds
    ) async -> [Report] {
        await withTaskGroup(of: (Int, Report).self) { group in
            for (index, section) in sections.enumerated() {
                group.addTask {
                    (index, await race(section.name, deadline: deadline, section.refresh))
                }
            }
            var reports = [Report?](repeating: nil, count: sections.count)
            for await (index, report) in group { reports[index] = report }
            return reports.compactMap { $0 }
        }
    }

    /// One section against its deadline. Both legs are unstructured tasks,
    /// so the loser is simply left behind: the deadline leg is cancelled when
    /// the work wins, the work leg when the deadline does.
    static func race(_ name: String, deadline: TimeInterval, _ refresh: @escaping Refresh) async
        -> Report
    {
        let once = Once()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Report, Never>) in
            once.arm(continuation)
            let work = Task {
                do {
                    try await refresh()
                    once.finish(Report(section: name, outcome: .done))
                } catch {
                    once.finish(
                        Report(section: name, outcome: .failed, error: "\(error)"))
                }
            }
            let timer = Task {
                try? await Task.sleep(nanoseconds: UInt64(max(0, deadline) * 1_000_000_000))
                guard !Task.isCancelled else { return }
                if once.finish(Report(section: name, outcome: .timeout)) { work.cancel() }
            }
            once.onFinish { timer.cancel() }
        }
    }

    /// Resumes the continuation exactly once, whichever leg gets there first.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Report, Never>?
        private var finished = false
        private var cleanup: (@Sendable () -> Void)?

        func arm(_ c: CheckedContinuation<Report, Never>) {
            lock.lock()
            continuation = c
            lock.unlock()
        }

        /// Runs `body` when the race is decided (now, if it already is).
        func onFinish(_ body: @escaping @Sendable () -> Void) {
            lock.lock()
            if finished {
                lock.unlock()
                body()
                return
            }
            cleanup = body
            lock.unlock()
        }

        /// True for the leg that decided the race.
        @discardableResult
        func finish(_ report: Report) -> Bool {
            lock.lock()
            guard !finished else {
                lock.unlock()
                return false
            }
            finished = true
            let c = continuation
            let body = cleanup
            continuation = nil
            cleanup = nil
            lock.unlock()
            c?.resume(returning: report)
            body?()
            return true
        }
    }
}
