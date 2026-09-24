import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for session pings and today's sessions: the Swift core is
/// asserted against the very same fixture the JS ports use
/// (tests/sessions.test.js, tests/parity.test.js). The fixture is pinned to UTC
/// because localDay/clock are deliberately local, so the time zone is passed in
/// here and set with TZ=UTC on the JS side.
final class SessionsParityTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    private func fixture() throws -> [String: Any] { try Fixtures.load("sessions.json") }

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

    /// An index entry exactly as the node MCP writes it - no `carry`, the key
    /// the synthesized decoder used to require - must decode, or the app
    /// treats the whole shared index as empty after every MCP refresh.
    func testDecodesTheNodeIndexEntry() throws {
        let fix = try fixture()
        let block = fix["nodeIndexEntry"] as! [String: Any]
        let index: [String: Any] = ["version": 1, "files": ["/p/a.jsonl": block["entry"]!]]
        let data = try JSONSerialization.data(withJSONObject: index)
        struct IndexFile: Decodable {
            let version: Int
            let files: [String: SessionAcc]
        }
        let decoded = try JSONDecoder().decode(IndexFile.self, from: data)
        let acc = try XCTUnwrap(decoded.files["/p/a.jsonl"])
        XCTAssertEqual(acc.sessionId, "S1")
        XCTAssertEqual(acc.title, "P")
        XCTAssertEqual(acc.offset, 180)
        XCTAssertEqual(acc.size, 180)
        XCTAssertEqual(acc.byDay, ["2026-09-01": 100])
        XCTAssertEqual(acc.ids, ["m1"])
        // a bare entry (only what every port writes first) decodes to defaults
        let bare = try JSONDecoder().decode(SessionAcc.self, from: Data(#"{"sessionId":"x"}"#.utf8))
        XCTAssertEqual(bare, SessionAcc(sessionId: "x"))
        // and what this port writes, it reads back
        let round = try JSONDecoder().decode(SessionAcc.self, from: JSONEncoder().encode(acc))
        XCTAssertEqual(round, acc)
    }

    func testConsumableSkipsALineLongerThanALine() {
        let line = Data("{\"a\":1}\n{\"b\"".utf8)
        XCTAssertEqual(SessionIndexer.consumable(line), 8, "through the last newline")
        XCTAssertEqual(
            SessionIndexer.consumable(Data("{\"half".utf8)), 0, "a half-written line waits")
        let huge = Data(repeating: 0x78, count: SessionIndexer.carryMax)
        XCTAssertEqual(SessionIndexer.consumable(huge), huge.count, "not a line: moved past")
    }

    func testIndexMtime() throws {
        let fix = try fixture()
        let block = fix["indexMtime"] as! [String: Any]
        for c in block["cases"] as! [[String: Any]] {
            let ms = (c["ms"] as! NSNumber).doubleValue
            XCTAssertEqual(
                SessionIndexer.indexMtime(ms), (c["expected"] as! NSNumber).doubleValue, "\(ms)")
        }
    }

    func testProjectsDir() throws {
        let fix = try fixture()
        let block = fix["projectsDir"] as! [String: Any]
        for c in block["cases"] as! [[String: Any]] {
            let env = c["env"] as! [String: String]
            XCTAssertEqual(
                SessionPaths.projectsDir(environment: env, home: c["home"] as! String),
                c["expected"] as? String, "\(env)")
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
