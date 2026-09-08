import XCTest

@testable import ClaudeUsageCore

final class WindowPlannerTests: XCTestCase {
    private let nineToSix = WorkDay(startMinute: 9 * 60, endMinute: 18 * 60)

    func testParsesAndFormatsTimes() {
        XCTAssertEqual(WindowPlanner.minutes(from: "05:30"), 330)
        XCTAssertEqual(WindowPlanner.minutes(from: "00:00"), 0)
        XCTAssertNil(WindowPlanner.minutes(from: "24:00"))
        XCTAssertNil(WindowPlanner.minutes(from: "9:60"))
        XCTAssertNil(WindowPlanner.minutes(from: "nope"))
        XCTAssertEqual(WindowPlanner.label(330), "05:30")
    }

    // The whole point: two windows (10h) more than cover a 9h day, but only if
    // the chain is pulled earlier than the day's start.
    func testTwoPingsCoverANineHourDayCompletely() {
        let plan = WindowPlanner.plan(day: nineToSix, pings: 2)
        XCTAssertEqual(plan.coveragePercent, 100)
        XCTAssertEqual(plan.pingTimes.count, 2)
        // 10h of window ending at 18:00 means starting at 08:00.
        XCTAssertEqual(plan.pingTimes, ["08:00", "13:00"])
    }

    // The failure mode users actually hit: start working at 09:00 with no ping,
    // and the second window dies mid-afternoon.
    func testStartingAtNineWithNoPlanLeavesTheDayUncovered() {
        let naive = WindowPlanner.evaluate(pingTimes: ["09:00"], day: nineToSix)
        XCTAssertEqual(naive?.coveredMinutes, 5 * 60)
        XCTAssertEqual(naive?.coveragePercent, 56)
        let planned = WindowPlanner.plan(day: nineToSix, pings: 2)
        XCTAssertGreaterThan(planned.coveragePercent, naive!.coveragePercent)
    }

    // A naive sum would double-count and rank a redundant schedule as better
    // than a spread one. Union, not sum.
    func testOverlappingPingsAreNotCountedTwice() {
        let overlapping = WindowPlanner.evaluate(
            pingTimes: ["09:00", "10:00"], day: nineToSix)
        XCTAssertEqual(overlapping?.coveredMinutes, 6 * 60, "09:00-15:00 is 6h, not 10h")
        let spread = WindowPlanner.evaluate(pingTimes: ["09:00", "14:00"], day: nineToSix)
        XCTAssertGreaterThan(spread!.coveredMinutes, overlapping!.coveredMinutes)
    }

    func testNeverSchedulesBeforeMidnight() {
        let earlyBird = WorkDay(startMinute: 2 * 60, endMinute: 20 * 60)
        let plan = WindowPlanner.plan(day: earlyBird, pings: 4)
        XCTAssertTrue(plan.windows.allSatisfy { $0.openMinute >= 0 })
    }

    // Extra windows would start after the day is over - they used to wrap past
    // midnight and report bogus times like "28:00".
    func testCountIsCappedToWhatTheDayCanUse() {
        XCTAssertEqual(WindowPlanner.plan(day: nineToSix, pings: 0).windows.count, 1)
        XCTAssertEqual(WindowPlanner.plan(day: nineToSix, pings: 99).windows.count, 2)
        let long = WorkDay(startMinute: 6 * 60, endMinute: 22 * 60)  // 16h
        XCTAssertEqual(WindowPlanner.plan(day: long, pings: 99).windows.count, 4)
        XCTAssertTrue(
            WindowPlanner.plan(day: long, pings: 99).windows.allSatisfy {
                $0.openMinute >= 0 && $0.closeMinute <= 24 * 60
            })
    }

    func testEvaluateRejectsAnEmptyOrGarbageSchedule() {
        XCTAssertNil(WindowPlanner.evaluate(pingTimes: [], day: nineToSix))
        XCTAssertNil(WindowPlanner.evaluate(pingTimes: ["nope"], day: nineToSix))
    }

    func testWorkDayRejectsAnInvertedRange() {
        XCTAssertNil(WorkDay(start: "18:00", end: "09:00"))
        XCTAssertNotNil(WorkDay(start: "09:00", end: "18:00"))
    }

    func testSummaryReadsAsOneLine() {
        let plan = WindowPlanner.plan(day: nineToSix, pings: 2)
        XCTAssertEqual(plan.summary, "08:00 13:00 · 100% of 09:00-18:00 covered")
    }
}

/// Adaptive-poll parity against the fixture pure.js asserts (tests/pure.test.js).
final class PollScheduleParityTests: XCTestCase {
    func testMatchesSharedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/poll.json")
        let fix =
            try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let now = Date(timeIntervalSince1970: (fix["now"] as! NSNumber).doubleValue / 1000)
        XCTAssertEqual(PollSchedule.idleAfter, (fix["idleAfter"] as! NSNumber).intValue)

        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let reset = (c["nextResetMs"] as? NSNumber).map {
                Date(timeIntervalSince1970: $0.doubleValue / 1000)
            }
            XCTAssertEqual(
                PollSchedule.nextPollSeconds(
                    baseSeconds: (c["baseSeconds"] as! NSNumber).intValue,
                    idleStreak: (c["idleStreak"] as! NSNumber).intValue,
                    nextReset: reset, now: now),
                (c["expected"] as! NSNumber).intValue, name)
        }
    }

    func testIdleStreakCountsUnmovedLimits() {
        let a = LimitCard(
            id: "session", label: "s", percent: 10, severity: .normal, resetsAt: nil,
            active: true, group: "session", scoped: false)
        let moved = LimitCard(
            id: "session", label: "s", percent: 11, severity: .normal, resetsAt: nil,
            active: true, group: "session", scoped: false)
        XCTAssertTrue(PollSchedule.sameUsage([a], [a]))
        XCTAssertFalse(PollSchedule.sameUsage([a], [moved]))
        XCTAssertFalse(PollSchedule.sameUsage([a], []))
    }
}

/// Event-hook parity against the fixture pure.js asserts (tests/pure.test.js).
final class EventHooksParityTests: XCTestCase {
    private func card(_ o: [String: Any]) -> LimitCard {
        LimitCard(
            id: o["key"] as! String, label: o["label"] as! String,
            percent: (o["percent"] as! NSNumber).intValue, severity: .normal, resetsAt: nil,
            active: true, group: "session", scoped: false)
    }

    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/events.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    func testDetectMatchesSharedFixtures() throws {
        for c in try fixture()["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let got = EventHooks.detect(
                previous: (c["previous"] as! [[String: Any]]).map(card),
                current: (c["current"] as! [[String: Any]]).map(card))
            let want = (c["expected"] as! [[String: Any]]).map {
                UsageEvent(
                    event: UsageEvent.Kind(rawValue: $0["event"] as! String)!,
                    key: $0["key"] as! String, label: $0["label"] as! String,
                    percent: ($0["percent"] as! NSNumber).intValue,
                    threshold: ($0["threshold"] as! NSNumber).intValue)
            }
            XCTAssertEqual(got, want, name)
        }
    }

    func testExpandMatchesSharedFixtures() throws {
        for c in try fixture()["expansions"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let e = c["event"] as! [String: Any]
            let event = UsageEvent(
                event: UsageEvent.Kind(rawValue: e["event"] as! String)!,
                key: e["key"] as! String, label: e["label"] as! String,
                percent: (e["percent"] as! NSNumber).intValue,
                threshold: (e["threshold"] as! NSNumber).intValue)
            XCTAssertEqual(
                EventHooks.expand(c["template"] as! String, event), c["expected"] as! String, name)
        }
    }
}
