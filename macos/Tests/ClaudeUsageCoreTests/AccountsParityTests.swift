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

    func testLiveProfileName() throws {
        let fix = try fixture()
        let ps = profiles(fix)
        for c in fix["liveLogin"] as! [[String: Any]] {
            XCTAssertEqual(
                Accounts.liveProfileName(
                    profiles: ps, token: c["token"] as? String,
                    account: c["account"] as? [String: Any]),
                c["expected"] as? String, c["name"] as! String)
        }
    }

    func testSyncBackPlan() throws {
        let fix = try fixture()
        let ps = profiles(fix)
        for c in fix["syncBack"] as! [[String: Any]] {
            let e = c["expected"] as! [String: Any]
            XCTAssertEqual(
                Accounts.syncBackPlan(
                    profiles: ps, token: c["token"] as? String,
                    account: c["account"] as? [String: Any],
                    pendingTo: (c["pending"] as? [String: Any])?["to"] as? String),
                SyncBackPlan(
                    name: e["name"] as? String, snapshot: e["snapshot"] as! Bool,
                    pendingDone: e["pendingDone"] as! Bool), c["name"] as! String)
        }
    }

    func testSameAndParkName() throws {
        let fix = try fixture()
        for pair in fix["sameName"] as! [[Any]] {
            let a = pair[0] as! String
            let b = pair[1] as! String
            XCTAssertEqual(Accounts.sameName(a, b), pair[2] as! Bool, "\(a)/\(b)")
        }
        for c in fix["parkName"] as! [[String: Any]] {
            let got = Accounts.parkName(
                email: c["email"] as? String, taken: c["taken"] as! [String])
            XCTAssertEqual(got, c["expected"] as? String, c["name"] as! String)
            XCTAssertTrue(Accounts.isValidName(got), got)
        }
    }

    func testFormatUsage() throws {
        let fix = try fixture()
        for c in fix["formatUsage"] as! [[String: Any]] {
            XCTAssertEqual(
                Accounts.formatUsage(cards(c["cards"] as! [[String: Any]])),
                c["expected"] as? String, c["name"] as! String)
        }
    }

    func testKeychainServices() throws {
        let fix = try fixture()
        let keychain = fix["keychain"] as! [String: Any]
        // No hash library on Linux: the fixture's digests stand in (the JS
        // test checks them against a real sha256), keyed by the NFC input.
        let digests = keychain["sha256"] as! [String: String]
        for c in keychain["cases"] as! [[String: Any]] {
            let got = Accounts.keychainServices(env: c["env"] as! [String: String]) { text in
                digests[text] ?? "missing digest for \(text)"
            }
            XCTAssertEqual(got, c["expected"] as! [String], c["name"] as! String)
        }
    }

    func testKeychainWriteLine() throws {
        let fix = try fixture()
        for c in fix["keychainWrite"] as! [[String: Any]] {
            let secret = String(
                repeating: c["secret"] as! String, count: c["repeat"] as? Int ?? 1)
            let got = Accounts.keychainWriteLine(
                account: c["account"] as! String, service: c["service"] as! String,
                secret: secret)
            if let bytes = c["expectedBytes"] as? Int {
                XCTAssertEqual(got?.utf8.count, bytes, c["name"] as! String)
            } else {
                XCTAssertEqual(got, c["expected"] as? String, c["name"] as! String)
            }
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
        // The row already names the account, so the store's prefix goes.
        XCTAssertEqual(
            Accounts.rowError(name: "PRO", message: "PRO: token refresh rejected (HTTP 400)"),
            "token refresh rejected (HTTP 400)")
        XCTAssertEqual(Accounts.rowError(name: "PRO", message: "HTTP 424"), "HTTP 424")
        XCTAssertEqual(Accounts.rowError(name: "PRO", message: "PROD: nope"), "PROD: nope")
    }
}
