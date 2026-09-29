import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The Codex contract against the same fixture the JS ports assert
/// (tests/codex-contract.test.js). No disk, no network: every decision is a
/// pure function of an auth blob, a clock, and a recorded snapshot.
final class CodexParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("codex.json") }

    private func profiles(_ fix: [String: Any]) -> [CodexProfile] {
        (fix["profiles"] as! [Any]).compactMap(CodexProfile.parse)
    }

    func testConstantsArePinned() throws {
        let fix = try fixture()
        XCTAssertEqual(Codex.refreshLeadMs, (fix["refreshLeadMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(Codex.refreshMaxAgeMs, (fix["refreshMaxAgeMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(Codex.snapshotMaxAgeMs, (fix["snapshotMaxAgeMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(Codex.authClaim, fix["authClaim"] as! String)
    }

    func testJwtClaimsAreReadNeverVerified() throws {
        let fix = try fixture()
        for c in fix["jwt"] as! [[String: Any]] {
            let got = Codex.jwtClaims(c["token"] as? String)
            let name = c["name"] as! String
            guard let want = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            XCTAssertTrue(Accounts.sameJSON(try XCTUnwrap(got, name), want), name)
        }
        let tokens = fix["tokens"] as! [String: String]
        XCTAssertEqual(Codex.jwtClaims(tokens["idPlus"])?["email"] as? String, "plus@example.com")
        XCTAssertEqual(
            (Codex.jwtClaims(tokens["accessValid"])?["exp"] as? NSNumber)?.doubleValue,
            1_789_310_000)
    }

    func testPlanLabels() throws {
        let fix = try fixture()
        for c in fix["planLabels"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.planLabel(c["plan"] as? String), c["expected"] as! String,
                "\(c["plan"] ?? "nil")")
        }
    }

    func testProfilesParseAndSummarize() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        let parsed = profiles(fix)
        XCTAssertEqual(parsed.count, (fix["profiles"] as! [Any]).count)
        for (p, e) in zip(parsed, fix["summaries"] as! [[String: Any]]) {
            let want = CodexSummary(
                name: e["name"] as! String, email: e["email"] as? String,
                accountId: e["accountId"] as? String, plan: e["plan"] as? String,
                planLabel: e["planLabel"] as! String,
                tokenState: TokenState(rawValue: e["tokenState"] as! String)!)
            XCTAssertEqual(p.summary(nowMs: now), want, p.name)
        }
        for raw in fix["invalidProfiles"] as! [Any] {
            XCTAssertNil(CodexProfile.parse(raw is NSNull ? nil : raw), "\(raw)")
        }
        // round-trips through toJSON
        for p in parsed {
            let again = try XCTUnwrap(CodexProfile.parse(p.toJSON()), p.name)
            XCTAssertEqual(again.summary(nowMs: now), p.summary(nowMs: now), p.name)
        }
    }

    func testActiveName() throws {
        let fix = try fixture()
        let ps = profiles(fix)
        for c in fix["active"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.activeName(profiles: ps, live: c["live"] as? [String: Any]),
                c["expected"] as? String, c["name"] as! String)
        }
    }

    func testWindowLabels() throws {
        let fix = try fixture()
        for c in fix["windowLabels"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.windowLabel((c["minutes"] as? NSNumber)?.doubleValue),
                c["expected"] as! String, "\(c["minutes"] ?? "nil")")
        }
    }

    func testRecordedSnapshotsBecomeCardsAndNothingElseDoes() throws {
        let fix = try fixture()
        for c in fix["limits"] as! [[String: Any]] {
            let name = c["name"] as! String
            let captured = (c["capturedAtMs"] as! NSNumber).doubleValue
            let got = Codex.normalizeLimits(
                c["rateLimits"] as? [String: Any], capturedAtMs: captured)
            let want = c["expected"] as! [[String: Any]]
            XCTAssertEqual(got.count, want.count, name)
            for (card, e) in zip(got, want) {
                XCTAssertEqual(card.id, e["key"] as! String, name)
                XCTAssertEqual(card.label, e["label"] as! String, name)
                XCTAssertEqual(card.group, e["group"] as! String, name)
                XCTAssertEqual(card.percent, (e["percent"] as! NSNumber).intValue, name)
                XCTAssertEqual(card.percentKnown, e["percentKnown"] as! Bool, name)
                XCTAssertEqual(card.active, e["active"] as! Bool, name)
                if let iso = e["resetsAt"] as? String {
                    XCTAssertEqual(card.resetsAt, UsageNormalizer.parseDate(iso), name)
                } else {
                    XCTAssertNil(card.resetsAt, name)
                }
            }
        }
    }

    func testAnOldSnapshotIsNotShown() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        for c in fix["snapshotAge"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.snapshotIsFresh(
                    capturedAtMs: (c["capturedAtMs"] as! NSNumber).doubleValue, nowMs: now),
                c["expected"] as! Bool, c["name"] as! String)
        }
    }
}
