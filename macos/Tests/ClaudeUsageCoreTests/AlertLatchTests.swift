import XCTest

@testable import ClaudeUsageCore

/// The notification latches: once per window, with hysteresis. Every case
/// comes from tests/fixtures/alerts.json, the file tests/alerts.test.js runs
/// through lib/pure/events.js (latchCrossings, latchPaceAlerts), so the two
/// ports cannot drift apart.
final class AlertLatchTests: XCTestCase {
    private func cases(_ section: String) throws -> [[String: Any]] {
        let fixture = try Fixtures.load("alerts.json")
        let list = try XCTUnwrap(fixture[section] as? [[String: Any]], "alerts.json \(section)")
        XCTAssertFalse(list.isEmpty, "alerts.json \(section) has no cases")
        return list
    }

    func testThresholdLatchMatchesTheSharedFixture() throws {
        for c in try cases("thresholds") {
            let name = try XCTUnwrap(c["name"] as? String)
            let polls = try XCTUnwrap(c["polls"] as? [[[String: Any]]], name)
            let expected = try XCTUnwrap(c["expected"] as? [[[String: Any]]], name)
            XCTAssertEqual(polls.count, expected.count, name)
            var latch = AlertLatch()
            for (i, poll) in polls.enumerated() {
                let cards = try poll.map { raw in
                    LimitCard.stub(
                        id: try XCTUnwrap(raw["key"] as? String, name),
                        percent: try XCTUnwrap(raw["percent"] as? Int, name))
                }
                let got = latch.crossings(cards).map { "\($0.card.id)@\($0.threshold)" }
                let want = try expected[i].map { raw in
                    "\(try XCTUnwrap(raw["key"] as? String))@\(try XCTUnwrap(raw["threshold"] as? Int))"
                }
                XCTAssertEqual(got, want, "\(name), poll \(i)")
            }
        }
    }

    func testPaceLatchMatchesTheSharedFixture() throws {
        for c in try cases("pace") {
            let name = try XCTUnwrap(c["name"] as? String)
            let polls = try XCTUnwrap(c["polls"] as? [[String: Any]], name)
            let expected = try XCTUnwrap(c["expected"] as? [[String]], name)
            XCTAssertEqual(polls.count, expected.count, name)
            var latch = PaceAlertLatch()
            for (i, poll) in polls.enumerated() {
                let keys = try XCTUnwrap(poll["cards"] as? [String], name)
                let raw = try XCTUnwrap(poll["forecasts"] as? [String: Any], name)
                var forecasts: [String: Forecast] = [:]
                for (key, value) in raw {
                    guard let fc = value as? [String: Any] else { continue }  // null: none
                    forecasts[key] = Forecast(
                        pctPerHour: 10, projectedFullAt: Date(timeIntervalSince1970: 0),
                        exhaustsBeforeReset: try XCTUnwrap(fc["exhaustsBeforeReset"] as? Bool),
                        marginHours: fc["marginHours"] as? Double)
                }
                let got = latch.alerts(
                    keys.map { LimitCard.stub(id: $0, percent: 50) }, forecasts: forecasts)
                XCTAssertEqual(got.map(\.card.id), expected[i], "\(name), poll \(i)")
            }
        }
    }

    func testThresholdLatchMatchesTheEventHooksBuckets() {
        for p in [0, 89, 90, 99, 100, 140] {
            var latch = AlertLatch()
            let expected = EventHooks.alertThreshold(p)
            let got = latch.crossings([.stub(id: "session", percent: p)]).map(\.threshold)
            XCTAssertEqual(got, expected == 0 ? [] : [expected], "\(p)")
        }
    }
}
