import XCTest

@testable import ClaudeUsageCore

final class UpdateStatusTests: XCTestCase {
    private func parse(_ s: String) -> UpdateStatus? {
        UpdateStatus.parse(json: Data(s.utf8))
    }

    func testParsesTheScriptOutput() {
        let s = parse(
            """
            {
              "checkout": "/home/u/claude-usage-panel",
              "installed": "1.7.0",
              "latest": "1.8.0",
              "updateAvailable": true,
              "blocked": false,
              "blockedReason": "",
              "lastCheck": "2026-08-27T03:10:44+0200",
              "log": "/home/u/.local/state/claude-usage-panel/auto-update.log"
            }
            """)
        XCTAssertEqual(s?.installed, "1.7.0")
        XCTAssertEqual(s?.latest, "1.8.0")
        XCTAssertEqual(s?.updateAvailable, true)
        XCTAssertEqual(s?.summary, "Update available: 1.7.0 → 1.8.0")
        XCTAssertEqual(s?.needsAttention, true)
    }

    // The case this whole feature exists for: current on paper, but the
    // scheduler has quietly stopped touching the checkout.
    func testBlockedBeatsUpToDateInTheSummary() {
        let s = parse(
            """
            {"installed":"1.7.0","latest":"1.7.0","updateAvailable":false,
             "blocked":true,"blockedReason":"local changes in /x - leaving them alone"}
            """)
        XCTAssertEqual(s?.summary, "Paused: local changes in /x - leaving them alone")
        XCTAssertEqual(s?.needsAttention, true)
    }

    func testUpToDateNeedsNoAttention() {
        let s = parse(#"{"installed":"1.8.0","latest":"1.8.0","updateAvailable":false}"#)
        XCTAssertEqual(s?.summary, "Up to date (1.8.0)")
        XCTAssertEqual(s?.needsAttention, false)
    }

    func testUnreachableRemoteIsNotReportedAsCurrent() {
        let s = parse(#"{"installed":"1.8.0","latest":"","updateAvailable":false}"#)
        XCTAssertEqual(s?.summary, "1.8.0 (could not reach the remote)")
    }

    func testRejectsGarbageAndMissingVersion() {
        XCTAssertNil(parse("not json"))
        XCTAssertNil(parse(#"{"latest":"1.8.0"}"#))
        XCTAssertNil(parse(#"{"installed":""}"#))
    }
}
