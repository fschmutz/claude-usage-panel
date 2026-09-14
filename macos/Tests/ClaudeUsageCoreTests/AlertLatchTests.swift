import XCTest

@testable import ClaudeUsageCore

/// The notification latch: once per window, with hysteresis. This is the
/// behavior the app's checkAlerts used to hard-code; pinned here so moving it
/// into the core changed nothing.
final class AlertLatchTests: XCTestCase {
    private func thresholds(_ latch: inout AlertLatch, _ percent: Int) -> [Int] {
        latch.crossings([.stub(id: "session", percent: percent)]).map(\.threshold)
    }

    func testFiresOnceAtNinetyAndOnceAtHundred() {
        var latch = AlertLatch()
        XCTAssertEqual(thresholds(&latch, 50), [])
        XCTAssertEqual(thresholds(&latch, 91), [90])
        XCTAssertEqual(thresholds(&latch, 95), [], "still in the 90 bucket")
        XCTAssertEqual(thresholds(&latch, 100), [100])
        XCTAssertEqual(thresholds(&latch, 100), [])
    }

    func testJumpingStraightToHundredReportsOnlyHundred() {
        var latch = AlertLatch()
        XCTAssertEqual(thresholds(&latch, 100), [100])
    }

    func testWobbleAroundNinetyDoesNotReFire() {
        var latch = AlertLatch()
        XCTAssertEqual(thresholds(&latch, 92), [90])
        XCTAssertEqual(thresholds(&latch, 89), [], "dipped, but not below the re-arm line")
        XCTAssertEqual(thresholds(&latch, 93), [], "back over 90 without a new window")
    }

    func testReArmsOnceUsageDropsBelowEightyFive() {
        var latch = AlertLatch()
        XCTAssertEqual(thresholds(&latch, 92), [90])
        XCTAssertEqual(thresholds(&latch, 3), [], "the window reset")
        XCTAssertEqual(thresholds(&latch, 91), [90], "a fresh crossing in the new window")
    }

    func testLimitsAreIndependent() {
        var latch = AlertLatch()
        let got = latch.crossings([
            .stub(id: "session", percent: 95), .stub(id: "weekly_all", percent: 40),
        ])
        XCTAssertEqual(got.map { $0.card.id }, ["session"])
        XCTAssertEqual(
            latch.crossings([.stub(id: "weekly_all", percent: 100)]).map(\.threshold), [100])
    }

    func testMatchesTheEventHooksBuckets() {
        for p in [0, 89, 90, 99, 100, 140] {
            var latch = AlertLatch()
            let expected = EventHooks.alertThreshold(p)
            XCTAssertEqual(thresholds(&latch, p), expected == 0 ? [] : [expected], "\(p)")
        }
    }
}
