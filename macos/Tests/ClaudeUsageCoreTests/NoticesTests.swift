import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Inline notices, button-local outcomes and the switch rotation, against the
/// same fixture the JS ports assert (tests/notices.test.js).
/// Sentences and button labels are per port and deliberately not asserted.
final class NoticesTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("notices.json") }

    func testConstantsArePinned() throws {
        let fix = try fixture()
        XCTAssertEqual(ControlOutcome.ttlMs, (fix["outcomeTtlMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(Rotation.minimum, (fix["rotationMin"] as! NSNumber).intValue)
    }

    func testHealth() throws {
        let fix = try fixture()
        for c in fix["health"] as! [[String: Any]] {
            let name = c["name"] as! String
            let got = Notices.health(
                tokenState: TokenState(rawValue: c["tokenState"] as! String)!,
                errorCode: c["errorCode"] as? String, live: c["live"] as? Bool ?? false)
            XCTAssertEqual(got.rawValue, c["expected"] as! String, name)
            XCTAssertEqual(got.needsAttention, c["needsAttention"] as! Bool, name)
        }
    }

    func testAccountNotices() throws {
        let fix = try fixture()
        for c in fix["notices"] as! [[String: Any]] {
            let name = c["name"] as! String
            let state = c["state"] as! [String: Any]
            let rows = (state["rows"] as! [[String: Any]]).map {
                (
                    name: $0["name"] as! String,
                    health: AccountHealth(rawValue: $0["health"] as! String)!
                )
            }
            let got = Notices.accountNotices(
                rows: rows, liveEmail: state["liveEmail"] as? String,
                activeName: state["activeName"] as? String,
                pendingTo: (state["pending"] as? [String: Any])?["to"] as? String,
                torn: state["torn"] as! Bool)
            let want = (c["expected"] as! [[String: Any]]).map {
                AccountNotice(
                    id: $0["id"] as! String,
                    kind: AccountNotice.Kind(rawValue: $0["kind"] as! String)!,
                    severity: Severity(rawValue: $0["severity"] as! String)!,
                    action: AccountNotice.Action(rawValue: $0["action"] as! String)!,
                    arg: $0["arg"] as? String)
            }
            XCTAssertEqual(got, want, name)
        }
    }

    func testOutcomeVisibility() throws {
        let fix = try fixture()
        for c in fix["outcomes"] as! [[String: Any]] {
            let raw = c["outcome"] as! [String: Any]
            let o = ControlOutcome(
                control: raw["control"] as! String, ok: raw["ok"] as! Bool,
                text: raw["text"] as! String, atMs: (raw["atMs"] as! NSNumber).doubleValue)
            XCTAssertEqual(
                o.visible(nowMs: (c["nowMs"] as! NSNumber).doubleValue),
                c["expected"] as! Bool, c["name"] as! String)
        }
    }

    func testRotation() throws {
        let fix = try fixture()
        for c in fix["rotation"] as! [[String: Any]] {
            let name = c["name"] as! String
            let names = c["names"] as! [String]
            let expected = c["expected"] as? String  // JSON null reads as NSNull, not nil
            let got = Rotation.next(names, active: c["active"] as? String)
            XCTAssertEqual(got, expected, name)
        }
    }
}
