import XCTest

@testable import ClaudeUsageCore

/// The `dst` slice of tests/fixtures/sessions.json, run in the zone it names
/// (Europe/Paris) rather than UTC: yesterday, the next ping and the index
/// pruning step calendar days, never 86400 s, so a 23 h or 25 h day neither
/// repeats nor skips a date. tests/sessions.test.js asserts the same cases
/// against the JS ports.
final class SessionsDstParityTests: XCTestCase {
    private func dst() throws -> (slice: [String: Any], zone: TimeZone) {
        let fix: [String: Any] = try Fixtures.load("sessions.json")
        let slice = fix["dst"] as! [String: Any]
        let zone = try XCTUnwrap(TimeZone(identifier: slice["tz"] as! String))
        return (slice, zone)
    }

    private func date(_ c: [String: Any]) -> Date {
        Date(timeIntervalSince1970: (c["nowMs"] as! NSNumber).doubleValue / 1000)
    }

    func testLastPingAcrossDst() throws {
        let (slice, zone) = try dst()
        for c in slice["lastPing"] as! [[String: Any]] {
            let raw = c["raw"] as! String
            XCTAssertEqual(
                SessionPingStatus.formatLastPing(raw, now: date(c), zone: zone),
                c["expected"] as? String, "lastPing - \(raw)")
        }
    }

    func testNextPingAcrossDst() throws {
        let (slice, zone) = try dst()
        for c in slice["nextPing"] as! [[String: Any]] {
            let times = c["times"] as! [String]
            let days = Set((c["days"] as! [NSNumber]).map(\.intValue))
            XCTAssertEqual(
                SessionPingStatus.nextPing(times: times, days: days, now: date(c), zone: zone),
                c["expected"] as? String, "nextPing - \(times)")
        }
    }

    func testPruneKeepsYesterdayAcrossDst() throws {
        let (slice, zone) = try dst()
        for c in slice["prune"] as! [[String: Any]] {
            let byDay = (c["byDay"] as! [String: NSNumber]).mapValues(\.intValue)
            let expected = (c["expected"] as! [String: NSNumber]).mapValues(\.intValue)
            XCTAssertEqual(
                SessionIndexer.pruneByDay(byDay, now: date(c), zone: zone), expected,
                "prune at \(c["nowMs"] ?? "")")
        }
    }
}
