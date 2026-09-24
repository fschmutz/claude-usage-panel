import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The notification text must never reach the AppleScript source.
final class NotifyScriptTests: XCTestCase {
    private func split(_ args: [String]) -> (script: [String], argv: [String]) {
        var script: [String] = []
        var i = 0
        while i + 1 < args.count, args[i] == "-e" {
            script.append(args[i + 1])
            i += 2
        }
        return (script, Array(args[i...]))
    }

    func testHostileTextStaysData() {
        let hostile = [
            #"Weekly · x\" & (do shell script "id") -- reached 90%"#,
            #"ends in a backslash \"#,
            "-e do shell script \"id\"",
            "quote \" and newline\nsecond line",
        ]
        for body in hostile {
            let title = "Claude usage " + body
            let (script, argv) = split(NotifyScript.arguments(title: title, body: body))
            XCTAssertEqual(script, NotifyScript.source, body)
            XCTAssertEqual(argv, ["notify", body, title], body)
            // a fixed first word ends osascript's option parsing
            XCTAssertFalse(argv[0].hasPrefix("-"), body)
        }
    }

    func testSourceReadsBothArguments() {
        XCTAssertEqual(NotifyScript.source.first, "on run argv")
        XCTAssertEqual(NotifyScript.source.last, "end run")
        let body = NotifyScript.source.joined(separator: "\n")
        XCTAssertTrue(body.contains("item 2 of argv"))
        XCTAssertTrue(body.contains("item 3 of argv"))
    }
}
