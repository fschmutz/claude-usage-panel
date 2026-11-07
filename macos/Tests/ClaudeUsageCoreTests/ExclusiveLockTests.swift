import Foundation
import XCTest

@testable import ClaudeUsageCore

/// ExclusiveLock: the decisions of the `.hold.lock` protocol shared with
/// claude-code/excl-lock.js and scripts/awake-backstop.sh.
final class ExclusiveLockTests: XCTestCase {
    private func snap(_ text: String, inode: UInt64 = 1, mtime: Double = 0)
        -> ExclusiveLock.Snapshot
    {
        .init(text: text, inode: inode, mtimeMs: mtime)
    }

    func testBodyCarriesThePidTheBackstopReadsAndAToken() {
        let body = ExclusiveLock.body(pid: 4242, token: "ab12")
        XCTAssertEqual(body, "4242\nab12\n")
        XCTAssertEqual(ExclusiveLock.holderPid(body), 4242)
        XCTAssertEqual(ExclusiveLock.holderPid("4242\n"), 4242, "an old pid-only body")
        XCTAssertNil(ExclusiveLock.holderPid(""))
        XCTAssertNil(ExclusiveLock.holderPid("x\n"))
        XCTAssertNil(ExclusiveLock.holderPid("-3\n"))
        XCTAssertNotEqual(ExclusiveLock.newToken(), ExclusiveLock.newToken())
        XCTAssertEqual(ExclusiveLock.newToken().count, 16)
    }

    func testStaleWhenThePidIsGoneOrTheLockIsOld() {
        let alive: (Int32) -> Bool = { _ in true }
        let dead: (Int32) -> Bool = { _ in false }
        let fresh = snap("7\nt\n", mtime: 1_000)
        XCTAssertFalse(
            ExclusiveLock.isStale(fresh, nowMs: 2_000, staleMs: 60_000, pidAlive: alive))
        XCTAssertTrue(
            ExclusiveLock.isStale(fresh, nowMs: 2_000, staleMs: 60_000, pidAlive: dead))
        XCTAssertTrue(
            ExclusiveLock.isStale(fresh, nowMs: 62_000, staleMs: 60_000, pidAlive: alive))
        // No pid to ask about: age alone decides.
        XCTAssertFalse(
            ExclusiveLock.isStale(
                snap("", mtime: 1_000), nowMs: 2_000, staleMs: 60_000, pidAlive: dead))
    }

    /// The race the guard closes: a lock replaced between the judgement and
    /// the unlink is a live holder's, and must be left alone.
    func testOnlyTheLockJudgedStaleIsRemoved() {
        let judged = snap("7\na\n", inode: 9, mtime: 5)
        XCTAssertTrue(ExclusiveLock.sameAsJudged(judged: judged, now: judged))
        XCTAssertFalse(ExclusiveLock.sameAsJudged(judged: judged, now: nil), "already gone")
        for now in [
            snap("8\nb\n", inode: 9, mtime: 5),
            snap("7\na\n", inode: 10, mtime: 5),
            snap("7\na\n", inode: 9, mtime: 6),
        ] {
            XCTAssertFalse(ExclusiveLock.sameAsJudged(judged: judged, now: now))
        }
    }

    /// The bug: release unlinked whatever lock file was there, so a holder
    /// that overran its stale window removed its successor's lock.
    func testReleaseOnlyWhileTheBodyIsStillOurs() {
        let mine = ExclusiveLock.body(pid: 7, token: "mine")
        XCTAssertTrue(ExclusiveLock.isOurs(current: mine, mine: mine))
        XCTAssertFalse(
            ExclusiveLock.isOurs(current: ExclusiveLock.body(pid: 7, token: "next"), mine: mine))
        XCTAssertFalse(ExclusiveLock.isOurs(current: nil, mine: mine))
    }

    func testATakeoverGuardOlderThanTenSecondsIsALeftover() {
        XCTAssertEqual(ExclusiveLock.takeoverStaleSeconds, 10)
        XCTAssertFalse(ExclusiveLock.takeoverGuardIsStale(mtimeMs: 0, nowMs: 10_000))
        XCTAssertTrue(ExclusiveLock.takeoverGuardIsStale(mtimeMs: 0, nowMs: 10_001))
    }
}
