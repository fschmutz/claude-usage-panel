import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for the top-bar readout: the Swift core is asserted
/// against the very same fixture the JS port uses (tests/parity.test.js).
final class PanelTextParityTests: XCTestCase {
    func testBudgetMatchesFixture() throws {
        let fix = try Fixtures.load("panel.json")
        XCTAssertEqual(PanelReadout.maxChars, fix["maxChars"] as! Int)
    }

    func testCases() throws {
        let fix = try Fixtures.load("panel.json")
        let max = fix["maxChars"] as! Int
        for c in fix["cases"] as! [[String: Any]] {
            let got = PanelReadout.text(
                account: c["account"] as! String, label: c["label"] as! String,
                percent: c["percent"] as! Int, max: max)
            XCTAssertEqual(got, c["expected"] as! String, c["name"] as! String)
        }
    }
}
