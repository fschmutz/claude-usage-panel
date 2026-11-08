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

    // The bug this field exists for: a manual `git pull` moves the checkout to
    // 1.8.0 while the installed clients stay on 1.7.0, and the daily run then
    // compares checkout-to-latest, matches, and never reinstalls.
    func testStaleClientsAreReportedEvenWhenTheCheckoutIsCurrent() {
        let s = parse(
            """
            {"installed":"1.7.0","checkout_version":"1.8.0","latest":"1.8.0",
             "updateAvailable":true,"clientsStale":true,"blocked":true,
             "blockedReason":"local changes in /x - leaving them alone"}
            """)
        XCTAssertEqual(s?.installed, "1.7.0")
        XCTAssertEqual(s?.checkoutVersion, "1.8.0")
        XCTAssertEqual(s?.clientsStale, true)
        XCTAssertEqual(s?.summary, "Update available: 1.7.0 → 1.8.0")
        XCTAssertEqual(s?.needsAttention, true)
    }

    func testStaleClientsOutrankAPauseWhenNothingNewerExists() {
        let s = parse(
            """
            {"installed":"1.7.0","checkout_version":"1.8.0","latest":"1.8.0",
             "updateAvailable":false,"clientsStale":true,"blocked":true,
             "blockedReason":"local changes"}
            """)
        XCTAssertEqual(
            s?.summary, "Installed 1.7.0, checkout 1.8.0 - reinstall the clients")
    }

    // The clients are installed, but the running GNOME Shell still holds the
    // code it loaded at login - reported, because every other surface says
    // "up to date" while the old code runs.
    func testAShellStillRunningTheOldCodeIsReported() {
        let s = parse(
            """
            {"installed":"2.1.2","checkout_version":"2.1.2","latest":"2.1.2",
             "updateAvailable":false,"loadedVersion":"2.0.0","reloadNeeded":true}
            """)
        XCTAssertEqual(s?.summary, "Installed 2.1.2, running 2.0.0 - log out and back in")
        XCTAssertEqual(s?.needsAttention, true)
    }

    // A lookup that failed is not "up to date" and not plain "offline": an
    // auth, DNS or URL error never fixes itself by waiting, so it is named.
    func testARemoteErrorIsNamedRatherThanCalledOffline() {
        let s = parse(
            """
            {"installed":"2.1.2","latest":"","updateAvailable":false,
             "remoteError":"Repository not found"}
            """)
        XCTAssertEqual(s?.summary, "2.1.2 - Repository not found")
        let quiet = parse(#"{"installed":"2.1.2","latest":""}"#)
        XCTAssertEqual(quiet?.summary, "2.1.2 (could not reach the remote)")
    }

    // The app runs only what the fixed link leads to, and only when the link,
    // the script and the directories above it are ours and nobody else's to
    // write.
    func testOnlyAScriptWeOwnBehindTheLinkIsTrusted() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("cup-trust-\(UUID().uuidString)")
        let root = base.appendingPathComponent("checkout")
        let scripts = root.appendingPathComponent("scripts")
        try fm.createDirectory(at: scripts, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        func chmod(_ url: URL, _ mode: Int) throws {
            try fm.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
        }
        func script(_ name: String) throws -> URL {
            let url = scripts.appendingPathComponent(name)
            try Data("#!/bin/bash\n".utf8).write(to: url)
            try chmod(url, 0o755)
            return url
        }
        let real = try script("auto-update.sh")
        let other = try script("other.sh")
        try chmod(root, 0o755)
        try chmod(scripts, 0o755)
        let link = base.appendingPathComponent("auto-update.sh")
        try fm.createSymbolicLink(at: link, withDestinationURL: real)

        XCTAssertEqual(
            UpdateStatus.trustedScript(link: link.path),
            real.resolvingSymlinksInPath().path)
        XCTAssertNil(
            UpdateStatus.trustedScript(link: link.path, uid: UInt32(getuid()) + 1), "another owner")
        XCTAssertNil(UpdateStatus.trustedScript(link: real.path), "a plain file, not the link")
        XCTAssertNil(UpdateStatus.trustedScript(link: base.appendingPathComponent("none").path))
        try chmod(real, 0o644)
        XCTAssertNil(UpdateStatus.trustedScript(link: link.path), "not executable")
        try chmod(real, 0o775)
        XCTAssertNil(UpdateStatus.trustedScript(link: link.path), "group-writable script")
        try chmod(real, 0o755)
        try chmod(scripts, 0o777)
        XCTAssertNil(UpdateStatus.trustedScript(link: link.path), "world-writable scripts/")
        try chmod(scripts, 0o755)
        try chmod(root, 0o757)
        XCTAssertNil(UpdateStatus.trustedScript(link: link.path), "world-writable checkout root")
        try chmod(root, 0o755)
        try fm.removeItem(at: link)
        try fm.createSymbolicLink(at: link, withDestinationURL: other)
        XCTAssertNil(UpdateStatus.trustedScript(link: link.path), "a link to another script")
    }

    // Mirrors version_compare in scripts/auto-update.sh: numeric per
    // component, v-prefix and prerelease suffix ignored.
    func testVersionOrderingMatchesTheShellComparator() {
        XCTAssertEqual(UpdateStatus.compare("1.10.0", "1.9.0"), 1)
        XCTAssertEqual(UpdateStatus.compare("1.5.10", "1.5.9"), 1)
        XCTAssertEqual(UpdateStatus.compare("v1.5.0", "1.5.0"), 0)
        XCTAssertEqual(UpdateStatus.compare("1.5", "1.5.0"), 0)
        XCTAssertEqual(UpdateStatus.compare("2.0.0-rc1", "2.0.0"), 0)
        XCTAssertTrue(UpdateStatus.isOlder("1.99.99", than: "2.0.0"))
    }

    func testRejectsGarbageAndMissingVersion() {
        XCTAssertNil(parse("not json"))
        XCTAssertNil(parse(#"{"latest":"1.8.0"}"#))
        XCTAssertNil(parse(#"{"installed":""}"#))
    }
}
