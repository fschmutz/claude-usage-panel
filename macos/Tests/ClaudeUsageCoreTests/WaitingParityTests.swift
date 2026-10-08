import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for the waiting-on-you list: the Swift core is asserted
/// against the very same fixture the JS port uses (tests/waiting.test.js).
final class WaitingParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("waiting.json") }

    private func nowMs(_ fix: [String: Any]) -> Double {
        (fix["nowMs"] as! NSNumber).doubleValue
    }

    func testReasonsAndHookEvents() throws {
        let fix = try fixture()
        XCTAssertEqual(Waiting.reasons, fix["reasons"] as! [String])
        XCTAssertEqual(Waiting.hookEvents, fix["hookEvents"] as! [String])
    }

    func testMarkerName() throws {
        let fix = try fixture()
        for c in fix["markerName"] as! [[String: Any]] {
            let pid = (c["pid"] as! NSNumber).intValue
            XCTAssertEqual(Waiting.markerName(pid), c["name"] as? String)
        }
        for c in fix["pidFromName"] as! [[String: Any]] {
            XCTAssertEqual(
                Waiting.pid(fromMarkerName: c["name"] as! String),
                (c["pid"] as? NSNumber)?.intValue)
        }
    }

    func testReasonFromNotification() throws {
        let fix = try fixture()
        for c in fix["reasonFromNotification"] as! [[String: Any]] {
            let payload = c["payload"] as! [String: Any]
            XCTAssertEqual(
                Waiting.reasonFromNotification(payload).rawValue, c["reason"] as? String)
        }
    }

    func testApplyHookEvent() throws {
        let fix = try fixture()
        let now = nowMs(fix)
        for c in fix["applyHookEvent"] as! [[String: Any]] {
            let expected = c["expected"] as! [String: Any]
            let got = Waiting.applyHookEvent(
                c["name"] as! String, payload: c["payload"] as? [String: Any] ?? [:],
                nowMs: now, previous: Waiting.parseMarker(c["previous"]))
            switch expected["action"] as! String {
            case "mark":
                let reason = WaitingReason(rawValue: expected["reason"] as! String)!
                let at = (expected["at"] as? NSNumber)?.doubleValue ?? now
                XCTAssertEqual(got, .mark(reason: reason, at: at))
            case "clear":
                XCTAssertEqual(got, .clear)
            default:
                XCTAssertEqual(got, .ignore)
            }
        }
    }

    func testParse() throws {
        let fix = try fixture()
        for c in fix["parse"] as! [[String: Any]] {
            let got = Waiting.parseMarker(c["raw"])
            if c["expected"] is NSNull {
                XCTAssertNil(got)
            } else {
                let e = c["expected"] as! [String: Any]
                XCTAssertEqual(got?.sessionId, e["sessionId"] as? String)
                XCTAssertEqual(got?.pid, (e["pid"] as? NSNumber)?.intValue)
                XCTAssertEqual(got?.reason.rawValue, e["reason"] as? String)
                XCTAssertEqual(got?.at, (e["at"] as? NSNumber)?.doubleValue)
            }
        }
    }

    func testAge() throws {
        let fix = try fixture()
        let now = nowMs(fix)
        for c in fix["age"] as! [[String: Any]] {
            XCTAssertEqual(
                Waiting.age(atMs: (c["atMs"] as! NSNumber).doubleValue, nowMs: now),
                c["expected"] as? String)
        }
    }

    func testList() throws {
        let fix = try fixture()
        let list = fix["list"] as! [String: Any]
        let sessions = (list["sessions"] as! [[String: Any]]).map {
            Waiting.LiveSession(
                pid: ($0["pid"] as! NSNumber).intValue,
                sessionId: $0["sessionId"] as! String,
                name: $0["name"] as! String,
                cwd: $0["cwd"] as! String)
        }
        let markers = (list["markers"] as! [[String: Any]]).compactMap(Waiting.parseMarker)
        let got = Waiting.list(sessions: sessions, markers: markers, nowMs: nowMs(fix))
        let expected = list["expected"] as! [[String: Any]]
        XCTAssertEqual(got.count, expected.count)
        for (i, e) in expected.enumerated() where i < got.count {
            XCTAssertEqual(got[i].pid, (e["pid"] as! NSNumber).intValue)
            XCTAssertEqual(got[i].sessionId, e["sessionId"] as? String)
            XCTAssertEqual(got[i].name, e["name"] as? String)
            XCTAssertEqual(got[i].cwd, e["cwd"] as? String)
            XCTAssertEqual(got[i].reason.rawValue, e["reason"] as? String)
            XCTAssertEqual(got[i].age, e["age"] as? String)
            XCTAssertEqual(got[i].reasonLabel, e["reasonLabel"] as? String)
        }
    }

    func testFocusPlan() throws {
        let fix = try fixture()
        for c in fix["focusPlan"] as! [[String: Any]] {
            let row = c["row"] as! [String: Any]
            let expected = c["expected"] as! [String: Any]
            let got = Waiting.focusPlan(
                window: row["window"] as? String,
                tab: (row["tab"] as? NSNumber)?.intValue,
                pid: (row["pid"] as? NSNumber)?.intValue,
                pane: (row["pane"] as? NSNumber)?.intValue)
            XCTAssertEqual(got.how.rawValue, expected["how"] as? String)
            if let id = expected["id"] as? String { XCTAssertEqual(got.id, id) }
            if let session = expected["session"] as? String {
                XCTAssertEqual(got.session, session)
            }
            if let tab = expected["tab"] as? NSNumber { XCTAssertEqual(got.tab, tab.intValue) }
            if let pid = expected["pid"] as? NSNumber { XCTAssertEqual(got.pid, pid.intValue) }
        }
    }

    func testFocusArgv() throws {
        let fix = try fixture()
        for c in fix["focusArgv"] as! [[String: Any]] {
            let got = Waiting.focusArgv(planFromFixture(c["plan"] as! [String: Any]))
            if c["expected"] is NSNull {
                XCTAssertNil(got)
            } else {
                XCTAssertEqual(got, c["expected"] as? [String])
            }
        }
    }

    private func planFromFixture(_ raw: [String: Any]) -> WaitingFocusPlan {
        WaitingFocusPlan(
            how: WaitingFocusPlan.How(rawValue: raw["how"] as! String) ?? .none,
            id: raw["id"] as? String,
            session: raw["session"] as? String,
            tab: (raw["tab"] as? NSNumber)?.intValue,
            pid: (raw["pid"] as? NSNumber)?.intValue)
    }
}
