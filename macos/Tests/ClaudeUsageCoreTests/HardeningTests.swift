import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Shell: every child process has a deadline.
final class ShellTests: XCTestCase {
    func testOutputAndStatus() {
        let r = Shell.run("/bin/sh", ["-c", "printf hi; exit 3"])
        XCTAssertEqual(r.out, "hi")
        XCTAssertEqual(r.status, 3)
        XCTAssertFalse(r.ok)
        XCTAssertFalse(r.timedOut)
        XCTAssertTrue(Shell.run("/bin/sh", ["-c", "exit 0"]).ok)
    }

    func testStdinReachesTheChild() {
        let r = Shell.run("/bin/cat", [], stdin: Data("secret".utf8))
        XCTAssertEqual(r.out, "secret")
    }

    /// The hang this exists for: without a deadline a child that never exits
    /// held `run` (and the poll awaiting it) forever.
    func testAHungChildIsTerminatedAtTheDeadline() {
        let started = Date()
        let r = Shell.run("/bin/sleep", ["30"], timeout: 0.3)
        XCTAssertTrue(r.timedOut)
        XCTAssertFalse(r.ok)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10)
    }

    func testAChildIgnoringSigtermIsKilled() {
        let started = Date()
        // exec, so no grandchild: Linux Foundation's waitUntilExit also waits
        // for any orphan holding its exit-notification socket.
        let r = Shell.run("/bin/sh", ["-c", "trap '' TERM; exec sleep 30"], timeout: 0.3)
        XCTAssertTrue(r.timedOut)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10 + Shell.killGrace)
    }

    func testAMissingExecutableFails() {
        let r = Shell.run("/nonexistent/tool", [])
        XCTAssertEqual(r.status, -1)
        XCTAssertFalse(r.ok)
    }
}

/// PrivateFile: the one owner-only atomic write both credential stores use.
final class PrivateFileTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("cup-private-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func mode(_ url: URL) throws -> Int {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs[.posixPermissions] as! NSNumber).intValue & 0o777
    }

    func testCreatesDirectoryAndFileOwnerOnly() throws {
        let file = dir.appendingPathComponent("sub/a.json")
        try PrivateFile.write(Data("{}".utf8), to: file)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "{}")
        XCTAssertEqual(try mode(file), 0o600)
        XCTAssertEqual(try mode(file.deletingLastPathComponent()), 0o700)
    }

    /// The account store used createFile + replaceItemAt: the replaced file
    /// kept its 0644, so a token rewritten over a world-readable file stayed
    /// world-readable.
    func testReplacingAWiderFileLeavesItOwnerOnly() throws {
        let file = dir.appendingPathComponent("creds.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        _ = FileManager.default.createFile(
            atPath: file.path, contents: Data("old".utf8),
            attributes: [.posixPermissions: 0o644])
        try PrivateFile.write(Data("new".utf8), to: file)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "new")
        XCTAssertEqual(try mode(file), 0o600)
    }

    func testLeavesNoTmpBehind() throws {
        let file = dir.appendingPathComponent("a.json")
        try PrivateFile.write(Data("1".utf8), to: file)
        try PrivateFile.write(Data("2".utf8), to: file)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["a.json"])
    }

    /// A rename over a symlink replaces the link; writing to the resolved
    /// path keeps a dotfile manager's ~/.claude.json link intact.
    func testResolvedFollowsASymlinkChain() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let real = dir.appendingPathComponent("real.json")
        let hop = dir.appendingPathComponent("hop.json")
        let link = dir.appendingPathComponent("link.json")
        try Data("{}".utf8).write(to: real)
        try FileManager.default.createSymbolicLink(at: hop, withDestinationURL: real)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: hop)
        try PrivateFile.write(Data("x".utf8), to: PrivateFile.resolved(link))
        XCTAssertEqual(try String(contentsOf: real, encoding: .utf8), "x")
        XCTAssertEqual(
            try FileManager.default.destinationOfSymbolicLink(atPath: link.path), hop.path)
        let missing = dir.appendingPathComponent("missing.json")
        XCTAssertEqual(PrivateFile.resolved(missing), missing)
    }
}

/// SessionResume: what a resume click may type into a terminal.
final class SessionResumeGuardTests: XCTestCase {
    private let id = "0f3c6c1e-5b7a-4d2e-9a41-7c2b1e8d9f00"

    func testAPlainSessionMayOpen() {
        XCTAssertNil(SessionResume.refusal(cwd: "/Users/me/my project (é)", sessionId: id))
        XCTAssertNil(SessionResume.refusal(cwd: "", sessionId: id.uppercased()))
    }

    func testAControlCharacterInTheDirectoryIsRefused() {
        for bad in ["\n", "\r", "\u{0}", "\u{3}", "\u{1b}", "\u{7f}", "\u{85}", "\u{9f}"] {
            XCTAssertNotNil(
                SessionResume.refusal(cwd: "/tmp/a\(bad)b", sessionId: id),
                "U+\(String(bad.unicodeScalars.first!.value, radix: 16))")
        }
        XCTAssertNil(SessionResume.refusal(cwd: "/tmp/\u{a0}", sessionId: id))
    }

    func testOnlyAUuidShapedSessionIdOpens() {
        for bad in [
            "", "abc", "\(id)\n", "\(id); rm -rf ~", "0f3c6c1e5b7a4d2e9a417c2b1e8d9f00",
            "0f3c6c1e-5b7a-4d2e-9a41-7c2b1e8d9f0g", "-\(id)",
        ] {
            XCTAssertNotNil(SessionResume.refusal(cwd: "/tmp", sessionId: bad), bad)
        }
    }
}

/// Setting: preferences read and written straight through UserDefaults. The
/// owner is main-actor isolated, like the app's view model; the test bodies
/// assume that isolation (Linux XCTest cannot run an isolated method).
final class SettingTests: XCTestCase {
    enum Mode: String { case worst, session }

    final class Owner: SettingsOwner {
        let settingsStore: UserDefaults
        var changes = 0
        var minutesSet: [Int] = []

        @Setting("refreshMinutes", default: 10) var refreshMinutes: Int {
            didSet { minutesSet.append(refreshMinutes) }
        }
        @Setting("alertsEnabled", default: true) var alertsEnabled: Bool
        @Setting("eventCommand", default: "") var eventCommand: String
        @Setting("panelMode", default: Mode.worst) var panelMode: Mode

        init(_ store: UserDefaults) { settingsStore = store }
        func settingWillChange() { changes += 1 }
    }

    private func withOwner(
        prepare: @MainActor (UserDefaults) -> Void = { _ in },
        body: @MainActor (Owner, UserDefaults) -> Void
    ) {
        // XCTest runs test methods on the main thread.
        MainActor.assumeIsolated {
            let suite = "cup-setting-\(UUID().uuidString)"
            let store = UserDefaults(suiteName: suite)!
            defer { store.removePersistentDomain(forName: suite) }
            prepare(store)
            body(Owner(store), store)
        }
    }

    func testMissingKeysReadAsTheirDefaultsWithoutWritingThem() {
        withOwner { o, store in
            XCTAssertEqual(o.refreshMinutes, 10)
            XCTAssertTrue(o.alertsEnabled)
            XCTAssertEqual(o.eventCommand, "")
            XCTAssertEqual(o.panelMode, .worst)
            XCTAssertNil(store.object(forKey: "refreshMinutes"))
        }
    }

    /// Prefs written by the hand-rolled didSet versions (same keys, same
    /// plain values) must read back unchanged.
    func testValuesStoredByEarlierVersionsSurvive() {
        withOwner(
            prepare: { store in
                store.set(30, forKey: "refreshMinutes")
                store.set(false, forKey: "alertsEnabled")
                store.set("say hi", forKey: "eventCommand")
                store.set("session", forKey: "panelMode")
            },
            body: { o, _ in
                XCTAssertEqual(o.refreshMinutes, 30)
                XCTAssertFalse(o.alertsEnabled)
                XCTAssertEqual(o.eventCommand, "say hi")
                XCTAssertEqual(o.panelMode, .session)
            })
    }

    func testWritesReachTheStoreNotifyAndRunDidSet() {
        withOwner { o, store in
            o.refreshMinutes = 5
            o.panelMode = .session
            XCTAssertEqual(store.object(forKey: "refreshMinutes") as? Int, 5)
            XCTAssertEqual(store.string(forKey: "panelMode"), "session")
            XCTAssertEqual(o.changes, 2)
            XCTAssertEqual(o.minutesSet, [5])
        }
    }

    func testAWronglyTypedOrUnknownValueReadsAsTheDefault() {
        withOwner(
            prepare: { store in
                store.set("ten", forKey: "refreshMinutes")
                store.set("sideways", forKey: "panelMode")
            },
            body: { o, _ in
                XCTAssertEqual(o.refreshMinutes, 10)
                XCTAssertEqual(o.panelMode, .worst)
            })
    }
}
