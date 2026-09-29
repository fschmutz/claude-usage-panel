import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The reclaim catalog and its rules, against the same list the JS ports
/// assert (tests/reclaim.test.js). Nothing here touches a real path: the
/// catalog is a template, and this asserts what it expands to.
final class ReclaimTests: XCTestCase {
    private let dirs = Reclaim.Dirs(
        home: "/h", claudeHome: "/h/.claude", codexHome: "/h/.codex",
        xdgCache: "/h/.cache", xdgConfig: "/h/.config")

    func testCatalogIsTheSameFixedListAsTheOtherPorts() {
        XCTAssertEqual(
            Reclaim.ids,
            [
                "claude-shell-snapshots", "claude-statsig", "claude-todos", "claude-downloads",
                "claude-projects", "panel-session-index",
                "cursor-cache", "cursor-cached-data", "cursor-code-cache", "cursor-gpu-cache",
                "cursor-logs", "codex-logs", "codex-sessions",
            ])
        // A default run never reaches for anything nothing regenerates.
        XCTAssertEqual(
            Reclaim.ids.filter { !Reclaim.defaultIds.contains($0) },
            ["claude-projects", "codex-sessions"])
    }

    func testEveryPathIsExpandedAndFollowsThePlatform() {
        for platform in ["darwin", "linux"] {
            let entries = Reclaim.entries(dirs: dirs, platform: platform)
            XCTAssertEqual(entries.count, Reclaim.ids.count, platform)
            for e in entries { XCTAssertFalse(e.path.contains("{"), "\(platform) \(e.id)") }
        }
        let mac = Reclaim.entries(dirs: dirs, platform: "darwin")
        let linux = Reclaim.entries(dirs: dirs, platform: "linux")
        let path = { (list: [ReclaimEntry], id: String) in list.first { $0.id == id }!.path }
        XCTAssertEqual(path(mac, "cursor-cache"), "/h/Library/Application Support/Cursor/Cache")
        XCTAssertEqual(path(linux, "cursor-cache"), "/h/.config/Cursor/Cache")
        XCTAssertEqual(path(mac, "claude-projects"), "/h/.claude/projects")
    }

    func testPlanRefusesWhatItShouldAndSaysWhy() {
        let scanned = [
            ReclaimEntry(
                id: "claude-statsig", tool: "t", label: "l", kind: .cache, note: "", path: "/a",
                bytes: 100),
            ReclaimEntry(
                id: "cursor-logs", tool: "t", label: "l", kind: .logs, note: "", path: "/b",
                bytes: 0),
            ReclaimEntry(
                id: "claude-projects", tool: "t", label: "l", kind: .history, note: "", path: "/c",
                bytes: 900),
        ]
        let plain = Reclaim.plan(
            scanned: scanned, ids: ["claude-statsig", "cursor-logs", "claude-projects", "nope"])
        XCTAssertEqual(plain.targets.map(\.id), ["claude-statsig"])
        XCTAssertEqual(plain.totalBytes, 100)
        XCTAssertEqual(plain.refused.map(\.id), ["cursor-logs", "claude-projects", "nope"])
        XCTAssertEqual(plain.refused.map(\.why), [.empty, .history, .unknown])

        // History moves only when it is named AND asked for out loud.
        XCTAssertEqual(
            Reclaim.plan(scanned: scanned, ids: ["claude-projects"], includeHistory: true)
                .targets.map(\.id), ["claude-projects"])
        // …and never by a default run, even then.
        XCTAssertEqual(
            Reclaim.plan(scanned: scanned, ids: nil, includeHistory: true).targets.map(\.id),
            ["claude-statsig"])
    }

    func testSizesReadTheSameAsTheOtherPorts() {
        XCTAssertEqual(Reclaim.formatBytes(0), "0 B")
        XCTAssertEqual(Reclaim.formatBytes(999), "999 B")
        XCTAssertEqual(Reclaim.formatBytes(1024), "1.0 KB")
        XCTAssertEqual(Reclaim.formatBytes(1536), "1.5 KB")
        XCTAssertEqual(Reclaim.formatBytes(Int(Double(1024 * 1024 * 1024) * 1.44)), "1.4 GB")
        XCTAssertEqual(Reclaim.formatBytes(-1), "-")
        XCTAssertEqual(Reclaim.formatBytes(nil), "-")
    }
}
