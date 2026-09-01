import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for session pings and today's sessions: the Swift core is
/// asserted against the very same fixture the JS ports use
/// (tests/sessions.test.js, tests/parity.test.js). The fixture is pinned to UTC
/// because localDay/clock are deliberately local, so the time zone is passed in
/// here and set with TZ=UTC on the JS side.
final class SessionsParityTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ClaudeUsageCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .deletingLastPathComponent()  // repo root
        let url = root.appendingPathComponent("tests/fixtures/sessions.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    private func now(_ fix: [String: Any]) -> Date {
        Date(timeIntervalSince1970: (fix["nowMs"] as! NSNumber).doubleValue / 1000)
    }

    func testStamps() throws {
        let fix = try fixture()
        for c in fix["stamps"] as! [[String: Any]] {
            let raw = c["raw"] as! String
            let at = SessionPingStatus.parseStamp(raw)
            if let expected = c["atMs"] as? NSNumber {
                XCTAssertEqual(
                    (at?.timeIntervalSince1970 ?? 0) * 1000, expected.doubleValue, accuracy: 1,
                    "atMs - \(raw)")
            } else {
                XCTAssertNil(at, "expected no date - \(raw)")
            }
            XCTAssertEqual(
                SessionPingStatus.formatLastPing(raw, now: now(fix), zone: utc),
                c["lastPing"] as? String, "lastPing - \(raw)")
        }
    }

    func testNextPing() throws {
        let fix = try fixture()
        for c in fix["nextPing"] as! [[String: Any]] {
            let times = c["times"] as! [String]
            let days = Set((c["days"] as! [NSNumber]).map(\.intValue))
            XCTAssertEqual(
                SessionPingStatus.nextPing(times: times, days: days, now: now(fix), zone: utc),
                c["expected"] as? String, "nextPing - \(times)")
        }
    }

    func testFold() throws {
        let fix = try fixture()
        let fold = fix["fold"] as! [String: Any]
        var acc = SessionAcc()
        for line in fold["lines"] as! [String] {
            SessionIndexer.fold(
                line: line, into: &acc, defaultDay: fold["defaultDay"] as! String, zone: utc)
        }
        let expected = fold["expected"] as! [String: Any]
        XCTAssertEqual(acc.sessionId, expected["sessionId"] as? String)
        XCTAssertEqual(acc.cwd, expected["cwd"] as? String)
        XCTAssertEqual(acc.title, expected["title"] as? String)
        XCTAssertEqual(acc.lastMs, (expected["lastMs"] as! NSNumber).doubleValue)
        let byDay = (expected["byDay"] as! [String: NSNumber]).mapValues(\.intValue)
        XCTAssertEqual(acc.byDay, byDay)
    }

    func testRank() throws {
        let fix = try fixture()
        let rank = fix["rank"] as! [String: Any]
        let entries = (rank["entries"] as! [[String: Any]]).map { row -> SessionAcc in
            SessionAcc(
                sessionId: row["sessionId"] as? String,
                cwd: row["cwd"] as? String,
                title: row["title"] as? String,
                lastMs: (row["lastMs"] as! NSNumber).doubleValue,
                byDay: (row["byDay"] as! [String: NSNumber]).mapValues(\.intValue))
        }
        let got = SessionIndexer.rank(
            entries, now: now(fix), limit: (rank["limit"] as! NSNumber).intValue, zone: utc)
        let expected = rank["expected"] as! [[String: Any]]
        XCTAssertEqual(got.count, expected.count)
        for (i, e) in expected.enumerated() where i < got.count {
            XCTAssertEqual(got[i].sessionId, e["sessionId"] as? String, "sessionId - \(i)")
            XCTAssertEqual(got[i].label, e["label"] as? String, "label - \(i)")
            XCTAssertEqual(got[i].tokens, (e["tokens"] as! NSNumber).intValue, "tokens - \(i)")
            XCTAssertEqual(got[i].when, e["when"] as? String, "when - \(i)")
        }
    }

    func testResumeCommands() throws {
        let fix = try fixture()
        for c in fix["resume"] as! [[String: Any]] {
            let cwd = c["cwd"] as! String
            let id = c["sessionId"] as! String
            XCTAssertEqual(
                SessionResume.command(cwd: cwd, sessionId: id), c["command"] as? String,
                "command - \(cwd)")
            XCTAssertEqual(
                SessionResume.interactive(cwd: cwd, sessionId: id), c["interactive"] as? String,
                "interactive - \(cwd)")
        }
    }

    func testCompactTokens() throws {
        let fix = try fixture()
        for c in fix["compactTokens"] as! [[String: Any]] {
            XCTAssertEqual(
                SessionFormat.compactTokens((c["n"] as! NSNumber).intValue),
                c["expected"] as? String)
        }
    }
}
