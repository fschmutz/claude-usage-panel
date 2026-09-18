import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Named-account parity against the fixture claude-code/accounts.js and
/// lib/pure.js assert (tests/accounts.test.js, tests/parity.test.js).
final class AccountsParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("accounts.json") }

    private func profiles(_ fix: [String: Any]) -> [AccountProfile] {
        (fix["profiles"] as! [Any]).compactMap(AccountProfile.parse)
    }

    func testConstantsArePinned() throws {
        let fix = try fixture()
        XCTAssertEqual(
            AccountProfile.refreshLeadMs, (fix["refreshLeadMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(AutoSwitch.threshold, (fix["threshold"] as! NSNumber).intValue)
        XCTAssertEqual(AutoSwitch.margin, (fix["margin"] as! NSNumber).intValue)
        XCTAssertEqual(AutoSwitch.cooldownMs, (fix["cooldownMs"] as! NSNumber).doubleValue)
    }

    func testProfilesParseAndSummarize() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        let raw = fix["profiles"] as! [Any]
        let parsed = profiles(fix)
        XCTAssertEqual(parsed.count, raw.count, "every fixture profile parses")
        let expected = fix["summaries"] as! [[String: Any]]
        XCTAssertEqual(parsed.count, expected.count)
        for (p, e) in zip(parsed, expected) {
            let want = AccountSummary(
                name: e["name"] as! String,
                email: e["email"] as? String,
                accountUuid: e["accountUuid"] as? String,
                plan: e["plan"] as? String,
                tier: e["tier"] as? String,
                tokenState: TokenState(rawValue: e["tokenState"] as! String)!)
            XCTAssertEqual(p.summary(nowMs: now), want, p.name)
        }
        // round-trips through toJSON
        for p in parsed {
            let again = try XCTUnwrap(AccountProfile.parse(p.toJSON()), p.name)
            XCTAssertEqual(again.summary(nowMs: now), p.summary(nowMs: now), p.name)
            XCTAssertEqual(again.accessToken, p.accessToken)
        }
    }

    func testInvalidProfilesAreRejected() throws {
        let fix = try fixture()
        for raw in fix["invalidProfiles"] as! [Any] {
            XCTAssertNil(AccountProfile.parse(raw), "\(raw)")
        }
    }

    func testNameRules() throws {
        let fix = try fixture()
        for n in fix["validNames"] as! [String] { XCTAssertTrue(Accounts.isValidName(n), n) }
        for n in fix["invalidNames"] as! [String] { XCTAssertFalse(Accounts.isValidName(n), n) }
    }

    func testActiveName() throws {
        let fix = try fixture()
        let ps = profiles(fix)
        for c in fix["active"] as! [[String: Any]] {
            let name = c["name"] as! String
            let live = c["live"] as? [String: Any]
            XCTAssertEqual(
                Accounts.activeName(profiles: ps, live: live), c["expected"] as? String, name)
        }
    }

    private func cards(_ raw: [[String: Any]]) -> [LimitCard] {
        raw.map { .stub(id: $0["key"] as! String, percent: ($0["percent"] as! NSNumber).intValue) }
    }

    func testAutoSwitchTarget() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        for c in fix["autoSwitch"] as! [[String: Any]] {
            let name = c["name"] as! String
            let worst = (c["worst"] as! [String: Any]).mapValues { ($0 as? NSNumber)?.intValue }
            let got = Accounts.autoSwitchTarget(
                active: c["active"] as? String, worst: worst,
                threshold: (fix["threshold"] as! NSNumber).intValue,
                margin: (fix["margin"] as! NSNumber).intValue,
                cooldownMs: (fix["cooldownMs"] as! NSNumber).doubleValue,
                lastSwitchMs: (c["lastSwitchMs"] as? NSNumber)?.doubleValue, nowMs: now)
            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            XCTAssertEqual(
                got,
                AutoSwitchDecision(
                    from: e["from"] as! String, to: e["to"] as! String,
                    activePercent: (e["activePercent"] as! NSNumber).intValue,
                    targetPercent: (e["targetPercent"] as! NSNumber).intValue), name)
        }
    }

    func testSortAndFormat() {
        let mk = { (n: String) in
            AccountProfile(
                name: n, savedAt: nil, account: [:],
                credentials: ["claudeAiOauth": ["accessToken": "x"]])
        }
        XCTAssertEqual(
            Accounts.sortedByName([mk("admin"), mk("PERSO"), mk("PRO")]).map(\.name),
            ["PERSO", "PRO", "admin"])
        XCTAssertEqual(
            Accounts.formatUsage(
                cards([["key": "session", "percent": 42], ["key": "weekly_all", "percent": 12]])),
            "S 42% · W 12%")
        XCTAssertEqual(Accounts.formatUsage([]), "S - · W -")
        // The row already names the account, so the store's prefix goes.
        XCTAssertEqual(
            Accounts.rowError(name: "PRO", message: "PRO: token refresh rejected (HTTP 400)"),
            "token refresh rejected (HTTP 400)")
        XCTAssertEqual(Accounts.rowError(name: "PRO", message: "HTTP 424"), "HTTP 424")
        XCTAssertEqual(Accounts.rowError(name: "PRO", message: "PROD: nope"), "PROD: nope")
    }
}
