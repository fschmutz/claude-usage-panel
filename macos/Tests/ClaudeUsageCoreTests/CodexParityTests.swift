import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The Codex contract against the same fixture the JS ports assert
/// (tests/codex-contract.test.js). No disk, no network: every decision is a
/// pure function of an auth blob, a clock, and a recorded snapshot.
final class CodexParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("codex.json") }
    private func usage() throws -> [String: Any] { try Fixtures.load("codex-usage.json") }

    private func profiles(_ fix: [String: Any]) -> [CodexProfile] {
        (fix["profiles"] as! [Any]).compactMap(CodexProfile.parse)
    }

    func testConstantsArePinned() throws {
        let fix = try fixture()
        XCTAssertEqual(Codex.refreshLeadMs, (fix["refreshLeadMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(Codex.refreshMaxAgeMs, (fix["refreshMaxAgeMs"] as! NSNumber).doubleValue)
        XCTAssertEqual(
            Codex.snapshotMaxAgeMs, (try usage()["snapshotMaxAgeMs"] as! NSNumber).doubleValue)
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

    func testTokenStateReadsStrictly() throws {
        let fix = try fixture()
        let now = (fix["now"] as! NSNumber).doubleValue
        let strict = fix["tokenStateStrict"] as! [String: Any]
        for c in strict["cases"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.tokenState(auth: c["auth"] as? [String: Any], nowMs: now).rawValue,
                c["expected"] as! String, c["name"] as! String)
        }
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

    func testOneTeamWorkspaceTwoMembers() throws {
        let team = try fixture()["team"] as! [String: Any]
        let ps = (team["profiles"] as! [Any]).compactMap(CodexProfile.parse)
        XCTAssertEqual(ps.count, (team["profiles"] as! [Any]).count)
        for c in team["active"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.activeName(profiles: ps, live: c["live"] as? [String: Any]),
                c["expected"] as? String, c["name"] as! String)
        }
        for c in team["identities"] as! [[String: Any]] {
            let id = Codex.identity(c["auth"] as? [String: Any])
            let want = c["expected"] as! [String: Any]
            let name = c["name"] as! String
            XCTAssertEqual(id.email, want["email"] as? String, name)
            XCTAssertEqual(id.accountId, want["accountId"] as? String, name)
            XCTAssertEqual(id.userId, want["userId"] as? String, name)
            XCTAssertEqual(id.plan, want["plan"] as? String, name)
        }
    }

    func testWindowLabels() throws {
        let fix = try usage()
        for c in fix["windowLabels"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.windowLabel(Codex.number(c["minutes"])),
                c["expected"] as! String, "\(c["minutes"] ?? "nil")")
        }
    }

    func testRecordedSnapshotsBecomeCardsAndNothingElseDoes() throws {
        let fix = try usage()
        for c in fix["limits"] as! [[String: Any]] {
            let name = c["name"] as! String
            let captured = (c["capturedAtMs"] as! NSNumber).doubleValue
            let got = Codex.normalizeLimits(
                c["rateLimits"] as? [String: Any], capturedAtMs: captured,
                nowMs: (c["nowMs"] as? NSNumber)?.doubleValue)
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
        let fix = try usage()
        let now = (fix["now"] as! NSNumber).doubleValue
        for c in fix["snapshotAge"] as! [[String: Any]] {
            XCTAssertEqual(
                Codex.snapshotIsFresh(
                    capturedAtMs: (c["capturedAtMs"] as! NSNumber).doubleValue, nowMs: now),
                c["expected"] as! Bool, c["name"] as! String)
        }
    }

    func testLastRateLimitsInATranscriptTail() throws {
        for c in try usage()["transcripts"] as! [[String: Any]] {
            let name = c["name"] as! String
            let got = Codex.lastRateLimits(c["text"] as! String)
            guard let want = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            let found = try XCTUnwrap(got, name)
            XCTAssertTrue(Accounts.sameJSON(found.limits, want["limits"] as Any), name)
            XCTAssertEqual(
                found.capturedAtMs, (want["capturedAtMs"] as? NSNumber)?.doubleValue, name)
        }
    }

    func testTheFreshestRecordedUsageOrWhyThereIsNone() throws {
        let fix = try usage()
        let now = (fix["now"] as! NSNumber).doubleValue
        for c in fix["recorded"] as! [[String: Any]] {
            let name = c["name"] as! String
            let files = (c["files"] as! [[String: Any]]).map {
                CodexTranscriptTail(
                    text: $0["text"] as! String, mtimeMs: ($0["mtimeMs"] as! NSNumber).doubleValue)
            }
            let got = Codex.pickRecorded(files, nowMs: now)
            let want = c["expected"] as! [String: Any]
            XCTAssertEqual(got.reason?.rawValue, want["reason"] as? String, name)
            XCTAssertEqual(got.cards.map(\.id), want["keys"] as! [String], name)
            XCTAssertEqual(
                got.capturedAt.map { ($0.timeIntervalSince1970 * 1000).rounded() },
                UsageNormalizer.parseDate(want["capturedAt"] as? String)
                    .map { ($0.timeIntervalSince1970 * 1000).rounded() }, name)
            if let resets = want["resetsAt"] as? [String] {
                XCTAssertEqual(
                    got.cards.map { $0.resetsAt?.timeIntervalSince1970 },
                    resets.map { UsageNormalizer.parseDate($0)?.timeIntervalSince1970 }, name)
            }
        }
    }

    func testSwitchAndScanConstantsArePinned() throws {
        XCTAssertEqual(Codex.switchSyncTries, try fixture()["switchSyncTries"] as! Int)
        XCTAssertEqual(Codex.sessionScanLimit, try usage()["sessionScanLimit"] as! Int)
        XCTAssertEqual(Codex.sessionsMaxDepth, try usage()["sessionsMaxDepth"] as! Int)
    }

    func testARotationMidSwitchIsSyncedNeverOverwritten() throws {
        let guardCases =
            (try fixture()["switchGuard"] as! [String: Any])["cases"] as! [[String: Any]]
        for c in guardCases {
            let name = c["name"] as! String
            let hasLive = c["hasLive"] as! Bool
            let live = c["live"] as? String
            let rotations = c["rotations"] as! [Bool]
            var version = 0
            var syncs = 0
            var writes = 0
            let blob = { () -> [String: Any]? in hasLive ? ["tokens": ["v": version]] : nil }
            let outcome = Codex.guardedSwitch(
                to: c["target"] as! String,
                syncBack: {
                    let synced = (name: hasLive ? live : nil, auth: blob())
                    if syncs < rotations.count, rotations[syncs] { version += 1 }
                    syncs += 1
                    return synced
                },
                readLive: blob, write: { writes += 1 })
            let (kind, from): (String, String?) =
                switch outcome {
                case .unsaved: ("unsaved", nil)
                case .already(let f): ("already", f)
                case .switched(let f): ("switched", f)
                case .busy(let f): ("busy", f)
                }
            let want = c["expected"] as! [String: Any]
            XCTAssertEqual(kind, want["outcome"] as! String, name)
            XCTAssertEqual(from, want["from"] as? String, name)
            XCTAssertEqual(syncs, want["syncs"] as! Int, name)
            XCTAssertEqual(writes, want["writes"] as! Int, name)
        }
    }

    func testTheTranscriptWalkNewestDayFirstBoundedDepth() throws {
        let scan = try usage()["sessionScan"] as! [String: Any]
        for c in scan["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            var visited: [String] = []
            let tree = c["tree"] as? [String: Any]
            let list = { (segments: [String]) -> [CodexDirEntry] in
                visited.append(segments.joined(separator: "/"))
                var node: [String: Any]? = tree
                for s in segments { node = node?[s] as? [String: Any] }
                return (node ?? [:]).map { key, value in
                    CodexDirEntry(
                        name: key, isDirectory: value is [String: Any],
                        mtimeMs: (value as? NSNumber)?.doubleValue)
                }
            }
            let got = Codex.scanSessions(
                limit: c["limit"] as? Int ?? Codex.sessionScanLimit, list: list)
            XCTAssertEqual(got.map(\.path), c["expected"] as! [String], name)
            XCTAssertEqual(visited, c["visited"] as! [String], name)
        }
    }
}
