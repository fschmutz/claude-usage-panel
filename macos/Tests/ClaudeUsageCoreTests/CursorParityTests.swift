import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Cursor team-spend parity against the fixture lib/pure/cursor.js asserts
/// (tests/cursor.test.js). The fixture carries fractional cents, which is
/// exactly where a port that reads them as Int drifts.
final class CursorParityTests: XCTestCase {
    private let eps = 1e-9

    private func fixture() throws -> [String: Any] { try Fixtures.load("cursor.json") }

    private func number(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }

    func testSpendMatchesSharedFixture() throws {
        let cases = try XCTUnwrap(try fixture()["spend"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let rows = try XCTUnwrap(c["rows"] as? [[String: Any]], name)
            let e = try XCTUnwrap(c["expected"] as? [String: Any], name)
            let s = CursorMath.summarizeSpend(rows)
            XCTAssertEqual(s.cycleUSD, try XCTUnwrap(number(e["cycleUSD"])), accuracy: eps, name)
            XCTAssertEqual(s.limitUSD, try XCTUnwrap(number(e["limitUSD"])), accuracy: eps, name)
            XCTAssertEqual(s.percent, (e["percent"] as? NSNumber)?.intValue, name)
            XCTAssertEqual(s.members, (e["members"] as? NSNumber)?.intValue, name)
            if let top = e["top"] as? [String: Any] {
                let got = try XCTUnwrap(s.top, name)
                XCTAssertEqual(got.email, top["email"] as? String, name)
                XCTAssertEqual(got.usd, try XCTUnwrap(number(top["usd"])), accuracy: eps, name)
            } else {
                XCTAssertNil(s.top, name)
            }
        }
    }

    func testTodayMatchesSharedFixture() throws {
        let cases = try XCTUnwrap(try fixture()["today"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let events = try XCTUnwrap(c["events"] as? [[String: Any]], name)
            XCTAssertEqual(
                CursorMath.summarizeToday(events), try XCTUnwrap(number(c["expectedUSD"])),
                accuracy: eps, name)
        }
    }
}
