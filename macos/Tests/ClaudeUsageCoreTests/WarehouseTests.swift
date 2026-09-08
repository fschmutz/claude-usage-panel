import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Warehouse parity against the fixture pure.js asserts (tests/pure.test.js).
final class WarehouseParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/warehouse.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    private func entries(_ fix: [String: Any]) -> [WarehouseEntry] {
        (fix["entries"] as! [[String: Any]]).map {
            WarehouseEntry(
                t: ($0["t"] as! NSNumber).doubleValue,
                limits: ($0["limits"] as! [String: NSNumber]).mapValues(\.intValue))
        }
    }

    func testWeekOverWeekMatchesSharedFixtures() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        XCTAssertEqual(Warehouse.keepDays, (fix["keepDays"] as! NSNumber).doubleValue)

        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let got = Warehouse.weekOverWeek(entries(fix), key: c["key"] as! String, nowMs: now)
            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            let w = try XCTUnwrap(got, name)
            XCTAssertEqual(w.thisWeekPeak, (e["thisWeekPeak"] as! NSNumber).intValue, name)
            XCTAssertEqual(w.lastWeekPeak, (e["lastWeekPeak"] as? NSNumber)?.intValue, name)
            XCTAssertEqual(w.deltaPoints, (e["deltaPoints"] as? NSNumber)?.intValue, name)
        }
    }

    func testFormatMatchesSharedFixtures() throws {
        for c in try fixture()["formats"] as! [[String: Any]] {
            let v = c["value"] as! [String: Any]
            let w = WeekOverWeek(
                thisWeekPeak: (v["thisWeekPeak"] as! NSNumber).intValue,
                lastWeekPeak: (v["lastWeekPeak"] as? NSNumber)?.intValue,
                deltaPoints: (v["deltaPoints"] as? NSNumber)?.intValue)
            XCTAssertEqual(Warehouse.format(w), c["expected"] as! String, c["name"] as! String)
        }
        XCTAssertEqual(Warehouse.format(nil), "")
    }

    func testRoundTripAndPrune() {
        let now = 1_800_000_000_000.0
        let card = LimitCard(
            id: "session", label: "s", percent: 42, severity: .normal, resetsAt: nil,
            active: true, group: "session", scoped: false)
        let text = Warehouse.line([card], nowMs: now)
        let parsed = Warehouse.parse(text + "\n{ not json\n")
        XCTAssertEqual(parsed, [WarehouseEntry(t: now, limits: ["session": 42])])
        // Older than the retention window, so it does not survive a prune.
        let old = WarehouseEntry(t: now - 91 * 86_400_000, limits: ["session": 1])
        XCTAssertEqual(Warehouse.prune(parsed + [old], nowMs: now), parsed)
    }
}
