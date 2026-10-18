import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for Awake: the Swift core is asserted against the very
/// same fixture the JS port uses (tests/awake.test.js).
final class AwakeParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("awake.json") }

    private func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber else { return nil }
        return n.doubleValue
    }

    private func session(_ raw: Any?) -> AwakeSession? { Awake.parseSession(raw) }

    func testConstants() throws {
        let fix = try fixture()
        XCTAssertEqual(Awake.version, (fix["version"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.holds, fix["holds"] as! [String])
        XCTAssertEqual(Awake.endReasons, fix["endReasons"] as! [String])
        XCTAssertEqual(Awake.journalKeys, fix["journalKeys"] as! [String])
        XCTAssertEqual(Awake.thermalStates, fix["thermalStates"] as! [String])
        XCTAssertEqual(Awake.minSeconds, (fix["minSeconds"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.maxSeconds, (fix["maxSeconds"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.backstopGraceMs, num(fix["backstopGraceMs"]))
        XCTAssertEqual(Awake.pollSeconds, (fix["pollSeconds"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.sudoCommands, fix["sudoCommands"] as! [[String]])
        // Every enum case the contract names must round-trip from its string.
        for raw in fix["holds"] as! [String] { XCTAssertNotNil(AwakeHold(rawValue: raw)) }
        for raw in fix["endReasons"] as! [String] { XCTAssertNotNil(AwakeEndReason(rawValue: raw)) }
        for raw in fix["thermalStates"] as! [String] {
            XCTAssertNotNil(AwakeThermal(rawValue: raw))
        }
        let defaults = fix["defaults"] as! [String: Any]
        XCTAssertEqual(
            Awake.defaults.lowPowerFloor, (defaults["lowPowerFloor"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.defaults.endFloor, (defaults["endFloor"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.defaults.maxSeconds, (defaults["maxSeconds"] as! NSNumber).intValue)
        XCTAssertEqual(Awake.defaults.thermalRules, defaults["thermalRules"] as! Bool)
    }

    func testParseDuration() throws {
        for c in try fixture()["parseDuration"] as! [[String: Any]] {
            let text = c["text"] as! String
            let want = (c["expected"] as? NSNumber)?.intValue
            XCTAssertEqual(Awake.parseDuration(text), want, "\(text)")
        }
    }

    func testFormatDuration() throws {
        for c in try fixture()["formatDuration"] as! [[String: Any]] {
            let seconds = num(c["seconds"])!
            XCTAssertEqual(Awake.formatDuration(seconds), c["expected"] as? String, "\(seconds)")
        }
    }

    func testCountdown() throws {
        for c in try fixture()["countdown"] as! [[String: Any]] {
            let ms = num(c["remainingMs"])!
            XCTAssertEqual(Awake.countdown(remainingMs: ms), c["expected"] as? String, "\(ms)")
        }
    }

    func testClampDuration() throws {
        for c in try fixture()["clampDuration"] as! [[String: Any]] {
            let seconds = (c["seconds"] as! NSNumber).intValue
            let maxSeconds = (c["maxSeconds"] as! NSNumber).intValue
            XCTAssertEqual(
                Awake.clampDuration(seconds, maxSeconds: maxSeconds),
                (c["expected"] as! NSNumber).intValue, "\(seconds)/\(maxSeconds)")
        }
    }

    func testNormalizeConfig() throws {
        for (i, c) in (try fixture()["normalizeConfig"] as! [[String: Any]]).enumerated() {
            let raw = c["config"] as! [String: Any]
            let input = AwakeConfig(
                lowPowerFloor: (raw["lowPowerFloor"] as? NSNumber)?.intValue
                    ?? Awake.defaults.lowPowerFloor,
                endFloor: (raw["endFloor"] as? NSNumber)?.intValue ?? Awake.defaults.endFloor,
                maxSeconds: (raw["maxSeconds"] as? NSNumber)?.intValue ?? Awake.defaults.maxSeconds,
                thermalRules: (raw["thermalRules"] as? Bool) ?? true)
            let want = c["expected"] as! [String: Any]
            let got = Awake.normalizeConfig(input)
            XCTAssertEqual(got.lowPowerFloor, (want["lowPowerFloor"] as! NSNumber).intValue, "\(i)")
            XCTAssertEqual(got.endFloor, (want["endFloor"] as! NSNumber).intValue, "\(i)")
            XCTAssertEqual(got.maxSeconds, (want["maxSeconds"] as! NSNumber).intValue, "\(i)")
            XCTAssertEqual(got.thermalRules, want["thermalRules"] as! Bool, "\(i)")
        }
    }

    func testNewSession() throws {
        let fix = try fixture()
        let now = num(fix["nowMs"])!
        for (i, c) in (fix["newSession"] as! [[String: Any]]).enumerated() {
            let args = c["args"] as! [String: Any]
            let want = c["expected"] as! [String: Any]
            let got = Awake.newSession(
                nowMs: now, seconds: (args["seconds"] as? NSNumber)?.intValue,
                whileSessions: args["whileSessions"] as! Bool, lid: args["lid"] as! Bool)
            XCTAssertEqual(got.startedAt, num(want["startedAt"]), "\(i)")
            XCTAssertEqual(got.endsAt, num(want["endsAt"]), "\(i)")
            XCTAssertEqual(got.timed, want["timed"] as! Bool, "\(i)")
            XCTAssertEqual(got.whileSessions, want["whileSessions"] as! Bool, "\(i)")
            XCTAssertEqual(got.lid, want["lid"] as! Bool, "\(i)")
        }
    }

    func testParseSession() throws {
        for (i, c) in (try fixture()["parseSession"] as! [[String: Any]]).enumerated() {
            let got = Awake.parseSession(c["raw"])
            guard let want = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, "case \(i)")
                continue
            }
            let s = try XCTUnwrap(got, "case \(i)")
            XCTAssertEqual(s.startedAt, num(want["startedAt"]), "\(i)")
            XCTAssertEqual(s.endsAt, num(want["endsAt"]), "\(i)")
            XCTAssertEqual(s.timed, want["timed"] as! Bool, "\(i)")
            XCTAssertEqual(s.whileSessions, want["whileSessions"] as! Bool, "\(i)")
            XCTAssertEqual(s.lid, want["lid"] as! Bool, "\(i)")
            XCTAssertEqual(s.owner?.pid ?? 0, (want["ownerPid"] as! NSNumber).intValue, "\(i)")
            XCTAssertEqual(s.owner?.kind ?? "", want["ownerKind"] as? String, "\(i)")
        }
    }

    func testExtend() throws {
        let fix = try fixture()
        let now = num(fix["nowMs"])!
        for (i, c) in (fix["extend"] as! [[String: Any]]).enumerated() {
            let s = try XCTUnwrap(session(c["session"]), "case \(i)")
            let extra = (c["extraSeconds"] as! NSNumber).intValue
            let got = Awake.extend(s, by: extra, nowMs: now)
            XCTAssertEqual(got?.endsAt, num(c["expectedEndsAt"]), "\(i)")
        }
        XCTAssertNil(Awake.extend(nil, by: 3600, nowMs: now))
    }

    func testState() throws {
        let fix = try fixture()
        let now = num(fix["nowMs"])!
        for c in fix["state"] as! [[String: Any]] {
            let name = c["name"] as! String
            let want = c["expected"] as! [String: Any]
            let state = Awake.state(
                session: session(c["session"]), sessions: (c["sessions"] as! NSNumber).intValue,
                nowMs: now)
            XCTAssertEqual(state.active, want["active"] as! Bool, name)
            XCTAssertEqual(state.holds.map(\.rawValue), want["holds"] as! [String], name)
            XCTAssertEqual(state.countdown, want["countdown"] as? String, name)
            XCTAssertEqual(state.endReason?.rawValue, want["endReason"] as? String, name)
            XCTAssertEqual(Awake.badge(state), want["badge"] as? String, name)
        }
    }

    func testEndReasonWithNoSession() {
        XCTAssertEqual(Awake.endReason(nil, nowMs: 0), .user)
    }

    func testFloors() throws {
        for c in try fixture()["floors"] as! [[String: Any]] {
            let name = c["name"] as! String
            let input = c["input"] as! [String: Any]
            let raw = input["config"] as? [String: Any] ?? [:]
            let config = AwakeConfig(
                lowPowerFloor: (raw["lowPowerFloor"] as? NSNumber)?.intValue
                    ?? Awake.defaults.lowPowerFloor,
                endFloor: (raw["endFloor"] as? NSNumber)?.intValue ?? Awake.defaults.endFloor,
                maxSeconds: Awake.defaults.maxSeconds,
                thermalRules: (raw["thermalRules"] as? Bool) ?? true)
            let battery = AwakeBattery(
                percent: (input["percent"] as? NSNumber)?.intValue,
                charging: input["charging"] as! Bool,
                hasBattery: input["hasBattery"] as! Bool)
            let got = Awake.floorActions(
                battery: battery,
                unreadableMisses: (input["unreadableMisses"] as? NSNumber)?.intValue ?? 0,
                thermal: AwakeThermal(rawValue: input["thermal"] as? String ?? "nominal")!,
                lidClosed: (input["lidClosed"] as? Bool) ?? false,
                lowPowerSetByUs: (input["lowPowerSetByUs"] as? Bool) ?? false,
                config: config)
            XCTAssertEqual(got, Self.actions(c["expected"] as! [[String: Any]]), name)
        }
    }

    /// The fixture's action objects as the Swift enum.
    private static func actions(_ raw: [[String: Any]]) -> [AwakeFloorAction] {
        raw.compactMap { entry in
            switch entry["action"] as? String {
            case "end":
                return AwakeEndReason(rawValue: entry["reason"] as? String ?? "").map {
                    AwakeFloorAction.end(reason: $0)
                }
            case "low-power-on":
                return AwakeLowPowerCause(rawValue: entry["cause"] as? String ?? "").map {
                    AwakeFloorAction.lowPowerOn(cause: $0)
                }
            case "low-power-off":
                return .lowPowerOff
            default:
                return nil
            }
        }
    }

    func testLowPowerCauseRanking() {
        XCTAssertEqual(
            Awake.lowPowerCause(percent: 5, charging: false, thermal: .serious, lidClosed: true),
            .thermal)
        XCTAssertEqual(
            Awake.lowPowerCause(percent: 5, charging: false, thermal: .nominal, lidClosed: true),
            .battery)
        XCTAssertEqual(
            Awake.lowPowerCause(percent: 100, charging: true, lidClosed: true), .lid)
        XCTAssertNil(Awake.lowPowerCause(percent: 100, charging: true))
    }

    func testJournal() throws {
        for c in try fixture()["journal"] as! [[String: Any]] {
            let name = c["name"] as! String
            let parsed = Awake.parseJournal(c["raw"])
            XCTAssertEqual(parsed != nil, c["parsed"] as! Bool, name)
            XCTAssertEqual(Awake.journalDirty(parsed), c["dirty"] as! Bool, name)
            XCTAssertEqual(Awake.recoverySteps(parsed), c["steps"] as! [String], name)
        }
    }

    func testJournalEntryIsCleanUntilSomethingIsOwned() {
        let entry = Awake.journalEntry(
            nowMs: 1000, endsAt: 2000, owner: AwakeOwner(pid: 9, host: "h", kind: "cli"))
        XCTAssertFalse(Awake.journalDirty(entry))
        XCTAssertEqual(entry.owner.pid, 9)
        XCTAssertEqual(Awake.recoverySteps(entry), [])
    }

    func testBackstopDue() throws {
        for c in try fixture()["backstopDue"] as! [[String: Any]] {
            let name = c["name"] as! String
            let journal = Awake.parseJournal(c["journal"])
            XCTAssertEqual(
                Awake.backstopDue(journal, nowMs: num(c["nowMs"])!, force: c["force"] as! Bool),
                c["expected"] as! Bool, name)
        }
    }

    func testRecoveryNotice() throws {
        for c in try fixture()["recoveryNotice"] as! [[String: Any]] {
            let name = c["name"] as! String
            let got = Awake.recoveryNotice(
                Awake.parseJournal(c["journal"]), nowMs: num(c["nowMs"])!)
            guard let want = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            XCTAssertEqual(got?.codes, want["codes"] as? [String], name)
            XCTAssertEqual(got?.endedAgoMs, num(want["endedAgoMs"]), name)
            XCTAssertEqual(got?.endedAgo, want["endedAgo"] as? String, name)
        }
    }

    func testInhibitArgv() throws {
        for c in try fixture()["inhibitArgv"] as! [[String: Any]] {
            let platform = c["platform"] as! String
            let args = c["args"] as! [String: Any]
            let got = Awake.inhibitArgv(
                platform: platform, seconds: (args["seconds"] as! NSNumber).intValue,
                pid: (args["pid"] as! NSNumber).intValue)
            XCTAssertEqual(got, c["expected"] as? [String], platform)
        }
    }

    func testLidArgv() throws {
        for c in try fixture()["lidArgv"] as! [[String: Any]] {
            let platform = c["platform"] as! String
            let seconds =
                ((c["args"] as? [String: Any])?["seconds"] as? NSNumber)?.intValue
                ?? Awake.maxSeconds
            let got = Awake.lidArgv(
                platform: platform, on: c["on"] as! Bool, seconds: seconds)
            XCTAssertEqual(got, c["expected"] as? [String], platform)
        }
    }

    func testLowPowerArgv() throws {
        for c in try fixture()["lowPowerArgv"] as! [[String: Any]] {
            let platform = c["platform"] as! String
            let got = Awake.lowPowerArgv(platform: platform, on: c["on"] as! Bool)
            XCTAssertEqual(got, c["expected"] as? [String], platform)
        }
    }

    func testSudoersBody() throws {
        let fix = try fixture()["sudoersBody"] as! [String: Any]
        XCTAssertEqual(
            Awake.sudoersBody(user: fix["user"] as! String), fix["expected"] as? String)
    }

    func testParseSleepDisabled() throws {
        for (i, c) in (try fixture()["sleepDisabled"] as! [[String: Any]]).enumerated() {
            XCTAssertEqual(
                Awake.parseSleepDisabled(c["output"] as? String), c["expected"] as? Bool, "\(i)")
        }
    }

    func testParsePmsetBattery() throws {
        for (i, c) in (try fixture()["pmsetBattery"] as! [[String: Any]]).enumerated() {
            let want = c["expected"] as! [String: Any]
            let got = Awake.parsePmsetBattery(c["output"] as? String)
            XCTAssertEqual(got.percent, (want["percent"] as? NSNumber)?.intValue, "\(i)")
            XCTAssertEqual(got.charging, want["charging"] as! Bool, "\(i)")
            XCTAssertEqual(got.hasBattery, want["hasBattery"] as! Bool, "\(i)")
        }
    }

    func testParseSysfsBattery() throws {
        for (i, c) in (try fixture()["sysfsBattery"] as! [[String: Any]]).enumerated() {
            let input = c["input"] as! [String: Any]
            let want = c["expected"] as! [String: Any]
            let got = Awake.parseSysfsBattery(
                capacity: input["capacity"] as? String, status: input["status"] as? String,
                present: (input["present"] as? Bool) ?? true)
            XCTAssertEqual(got.percent, (want["percent"] as? NSNumber)?.intValue, "\(i)")
            XCTAssertEqual(got.charging, want["charging"] as! Bool, "\(i)")
            XCTAssertEqual(got.hasBattery, want["hasBattery"] as! Bool, "\(i)")
        }
    }

    func testThermalFromMillidegrees() throws {
        for c in try fixture()["thermalMilli"] as! [[String: Any]] {
            let milli = num(c["milli"])!
            XCTAssertEqual(
                Awake.thermal(millidegrees: milli).rawValue, c["expected"] as? String, "\(milli)")
        }
    }

    func testThermalFromSpeedLimit() throws {
        for (i, c) in (try fixture()["thermalSpeedLimit"] as! [[String: Any]]).enumerated() {
            XCTAssertEqual(
                Awake.thermal(speedLimitOutput: c["output"] as? String).rawValue,
                c["expected"] as? String, "\(i)")
        }
    }

    func testIsHold() {
        XCTAssertTrue(Awake.isHold("timer"))
        XCTAssertTrue(Awake.isHold("sessions"))
        XCTAssertFalse(Awake.isHold("forever"))
    }
}
