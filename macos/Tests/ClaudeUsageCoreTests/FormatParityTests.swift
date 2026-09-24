import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The reset countdown and the sparkline against the fixtures the JS ports
/// assert (tests/parity.test.js). Both used to live in the app target with no
/// test at all, so nothing held them to the GNOME panel.
final class ResetCountdownParityTests: XCTestCase {
    func testMatchesSharedFixture() throws {
        let fix = try Fixtures.load("resets.json")
        let now = try XCTUnwrap(UsageNormalizer.parseDate(fix["now"] as? String))
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let raw = c["resetsAt"] as? String
            // "not-a-date" parses to nil, which is what the panel is handed.
            let date = UsageNormalizer.parseDate(raw)
            XCTAssertEqual(ResetCountdown.text(date, now: now), c["panel"] as? String, name)
        }
    }
}

final class SparklineParityTests: XCTestCase {
    func testMatchesSharedFixture() throws {
        let fix = try Fixtures.load("sparkline.json")
        XCTAssertEqual(Sparkline.samples, (fix["samples"] as! NSNumber).intValue)
        for c in fix["cases"] as! [[String: Any]] {
            let percents = (c["percents"] as! [NSNumber]).map(\.doubleValue)
            XCTAssertEqual(
                Sparkline.render(percents), c["expected"] as? String, c["name"] as? String ?? "?")
        }
    }

    func testPercentsSkipsEntriesThatAreNotPairs() {
        XCTAssertEqual(Sparkline.percents([[1, 40], [2], [3, 50, 9], [4, 60]]), [40, 60])
    }

    func testNonFiniteAndHugeValuesNeverTrap() {
        XCTAssertEqual(Sparkline.render([.nan, .infinity, 1e300, -1e300]), "  █ ")
    }
}
