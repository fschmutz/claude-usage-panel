import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The top-bar gauge, against the same fixture the JS port asserts
/// (tests/parity.test.js "panelGauge").
final class PanelGaugeTests: XCTestCase {
    func testColorsArePinned() throws {
        let fix = try Fixtures.load("gauge.json")
        let colors = fix["colors"] as! [String: String]
        XCTAssertEqual(colors.count, PanelGauge.colors.count)
        for (tone, hex) in PanelGauge.colors {
            XCTAssertEqual(colors[tone.rawValue], hex, tone.rawValue)
        }
    }

    func testCases() throws {
        let fix = try Fixtures.load("gauge.json")
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let reading = c["reading"] as! [String: Any]
            let got = PanelGauge.of(
                known: reading["known"] as! Bool,
                percent: (reading["percent"] as? NSNumber)?.intValue,
                severity: Severity(rawValue: c["severity"] as! String) ?? .normal,
                exhaustsBeforeReset: c["exhaustsBeforeReset"] as! Bool)
            let want = c["expected"] as! [String: Any]
            XCTAssertEqual(got.fraction, (want["fraction"] as! NSNumber).doubleValue, name)
            XCTAssertEqual(got.tone.rawValue, want["tone"] as! String, name)
        }
    }
}
