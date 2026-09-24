import XCTest

@testable import ClaudeUsageCore

/// The popup header's plan, read from the credentials as the GNOME header
/// does: the usage endpoint has no plan_label. Every case comes from
/// tests/fixtures/plan-label.json, the file tests/plan-label.test.js runs
/// through lib/pure/usage.js planLabel, so the two ports cannot drift apart.
final class PlanLabelTests: XCTestCase {
    func testPlanLabelMatchesTheSharedFixture() throws {
        let fixture = try Fixtures.load("plan-label.json")
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]], "plan-label.json cases")
        XCTAssertFalse(cases.isEmpty, "plan-label.json has no cases")
        for c in cases {
            let name = try XCTUnwrap(c["name"] as? String)
            let expected = try XCTUnwrap(c["expected"] as? String, name)
            XCTAssertEqual(PlanLabel.label(oauth: c["oauth"] as? [String: Any]), expected, name)
        }
    }
}
