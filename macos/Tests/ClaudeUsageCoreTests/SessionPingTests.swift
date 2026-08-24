import Foundation
import XCTest

@testable import ClaudeUsageCore

final class SessionPingScheduleTests: XCTestCase {
    func testTimeValidation() {
        XCTAssertTrue(SessionPingSchedule.isValidTime("05:30"))
        XCTAssertTrue(SessionPingSchedule.isValidTime("5:30"))
        XCTAssertTrue(SessionPingSchedule.isValidTime("23:59"))
        XCTAssertFalse(SessionPingSchedule.isValidTime("24:00"))
        XCTAssertFalse(SessionPingSchedule.isValidTime("10:99"))
        XCTAssertFalse(SessionPingSchedule.isValidTime("ten"))
    }

    func testValidity() {
        XCTAssertTrue(SessionPingSchedule.default.isValid)
        XCTAssertFalse(SessionPingSchedule(times: [], days: [1]).isValid)
        XCTAssertFalse(SessionPingSchedule(times: ["06:00"], days: []).isValid)
        XCTAssertFalse(SessionPingSchedule(times: ["06:00"], days: [8]).isValid)
    }

    func testDaysArgIsSortedAndCommaJoined() {
        XCTAssertEqual(SessionPingSchedule(times: ["06:00"], days: [5, 1, 3]).daysArg, "1,3,5")
    }
}

final class SessionPingAgentTests: XCTestCase {
    let schedule = SessionPingSchedule(times: ["06:00", "11:00"], days: [1, 2, 3, 4, 5])

    // install.sh's `_sp_current_times` and session-ping.sh's `--status` parse
    // the plist with line-oriented sed - the emitted shape is a contract, not
    // a formatting choice. Pin it byte for byte.
    func testPlistMatchesInstallShFormat() {
        let xml = SessionPingAgent.plistXML(schedule: schedule, runner: "/x/session-ping.sh")
        let expected = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>io.github.fschmutz.claude-usage-panel.sessionping</string>
              <key>ProgramArguments</key>
              <array>
                <string>/bin/bash</string>
                <string>/x/session-ping.sh</string>
                <string>--quiet</string>
                <string>--days=1,2,3,4,5</string>
              </array>
              <key>StartCalendarInterval</key>
              <array>
                <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
                <dict><key>Hour</key><integer>11</integer><key>Minute</key><integer>0</integer></dict>
              </array>
              <key>RunAtLoad</key><false/>
              <key>ProcessType</key><string>Background</string>
              <key>LowPriorityIO</key><true/>
            </dict>
            </plist>

            """
        XCTAssertEqual(xml, expected)
    }

    func testRoundTrip() throws {
        let xml = SessionPingAgent.plistXML(schedule: schedule, runner: "/x/session-ping.sh")
        let parsed = try XCTUnwrap(SessionPingAgent.parse(plistData: Data(xml.utf8)))
        XCTAssertEqual(parsed.schedule, schedule)
        XCTAssertEqual(parsed.runner, "/x/session-ping.sh")
    }

    func testParseToleratesSingleIntervalDictAndMissingDays() throws {
        // The autoupdate agent's shape: one bare StartCalendarInterval dict,
        // no --days argument - days fall back to Mon-Fri.
        let xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>x</string>
              <key>ProgramArguments</key>
              <array><string>/bin/bash</string><string>/x/run.sh</string><string>--quiet</string></array>
              <key>StartCalendarInterval</key>
              <dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>30</integer></dict>
            </dict>
            </plist>
            """
        let parsed = try XCTUnwrap(SessionPingAgent.parse(plistData: Data(xml.utf8)))
        XCTAssertEqual(parsed.schedule.times, ["05:30"])
        XCTAssertEqual(parsed.schedule.days, [1, 2, 3, 4, 5])
        XCTAssertEqual(parsed.runner, "/x/run.sh")
    }

    func testParseRejectsGarbage() {
        XCTAssertNil(SessionPingAgent.parse(plistData: Data("nope".utf8)))
        XCTAssertNil(
            SessionPingAgent.parse(
                plistData: Data(
                    "<plist version=\"1.0\"><dict></dict></plist>".utf8)))
    }
}
