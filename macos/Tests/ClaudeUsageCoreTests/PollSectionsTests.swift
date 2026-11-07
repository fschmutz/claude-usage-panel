import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The sections a poll refreshes, against the fixture lib/pure/poll.js
/// asserts (tests/poll.test.js), and the deadline that keeps one hung section
/// from stopping the poll loop.
final class PollSectionsTests: XCTestCase {
    private func cards(_ raw: Any?) -> [LimitCard] {
        (raw as? [[String: Any]] ?? []).map {
            .stub(id: $0["key"] as! String, percent: ($0["percent"] as! NSNumber).intValue)
        }
    }

    func testSectionCardsMatchSharedFixture() throws {
        let fix = try Fixtures.load("poll.json")
        XCTAssertEqual(
            PollSections.deadlineSeconds * 1000,
            (fix["sectionDeadlineMs"] as! NSNumber).doubleValue)
        let cases = try XCTUnwrap(fix["sections"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let result = c["result"] as! [String: Any]
            let ok = result["ok"] as! Bool
            let got = PollSections.sectionCards(
                failureCode: ok ? nil : result["code"] as? String, cards: cards(result["cards"]),
                latest: cards(c["latest"]))
            XCTAssertEqual(got, cards(c["expected"]), name)
        }
    }

    func testEverySectionRunsAndReportsInOrder() async {
        let reports = await PollSections.run([
            (name: "cost", refresh: {}),
            (name: "cursor", refresh: { throw CocoaError(.fileNoSuchFile) }),
            (name: "accounts", refresh: {}),
        ])
        XCTAssertEqual(reports.map(\.section), ["cost", "cursor", "accounts"])
        XCTAssertEqual(reports.map(\.outcome), [.done, .failed, .done])
        XCTAssertNotNil(reports[1].error)
    }

    /// The bug this exists for: a section that never returns (a `ccusage`
    /// stuck in waitUntilExit) held the poll, and with it every later poll.
    func testAHungSectionIsCutOffAndTheOthersFinish() async {
        let started = Date()
        let reports = await PollSections.run(
            [
                (name: "cost", refresh: { try await Task.sleep(nanoseconds: 60_000_000_000) }),
                (name: "sessions", refresh: {}),
            ], deadline: 0.2)
        XCTAssertEqual(reports.map(\.outcome), [.timeout, .done])
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    /// A refresh that blocks its thread outright cannot be cancelled; the
    /// poll still moves on at the deadline.
    func testABlockingSectionDoesNotHoldThePoll() async {
        let started = Date()
        let reports = await PollSections.run(
            [(name: "cost", refresh: { Self.block(seconds: 3) })], deadline: 0.2)
        XCTAssertEqual(reports.map(\.outcome), [.timeout])
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
    }

    /// A synchronous wait, like `waitUntilExit` on a stuck child.
    private nonisolated static func block(seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// The app's sections are main-actor methods of its view model, handed
    /// over as `{ @MainActor in ... }` closures.
    @MainActor final class Model {
        var hits: [String] = []
        func refresh(_ name: String) async { hits.append(name) }
    }

    func testMainActorSectionsRunOnTheMainActor() async {
        let model = await MainActor.run { Model() }
        let reports = await PollSections.run([
            (name: "cost", refresh: { @MainActor in await model.refresh("cost") }),
            (name: "codex", refresh: { @MainActor in await model.refresh("codex") }),
        ])
        XCTAssertEqual(reports.map(\.outcome), [.done, .done])
        let hits = await MainActor.run { model.hits.sorted() }
        XCTAssertEqual(hits, ["codex", "cost"])
    }

    func testSectionsRunSideBySide() async {
        let started = Date()
        let nap: PollSections.Refresh = { try await Task.sleep(nanoseconds: 400_000_000) }
        let reports = await PollSections.run(
            [(name: "a", refresh: nap), (name: "b", refresh: nap), (name: "c", refresh: nap)])
        XCTAssertEqual(reports.map(\.outcome), [.done, .done, .done])
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.1)
    }
}
