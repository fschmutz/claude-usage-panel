import XCTest

@testable import ClaudeUsageCore

/// The popup header's plan, read from the credentials as the GNOME header
/// does (lib/claudeUsage.js planLabel, same cases in tests/alerts.test.js):
/// the usage endpoint has no plan_label.
final class PlanLabelTests: XCTestCase {
    func testReadsThePlanAndTierFromTheCredentials() {
        XCTAssertEqual(
            PlanLabel.label(oauth: [
                "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x",
            ]), "Max 20x")
        XCTAssertEqual(
            PlanLabel.label(oauth: [
                "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x",
            ]), "Max 5x")
        XCTAssertEqual(
            PlanLabel.label(oauth: [
                "subscriptionType": "pro", "rateLimitTier": "default_claude_ai",
            ]), "Pro")
        XCTAssertEqual(PlanLabel.label(oauth: ["subscriptionType": "team"]), "Team")
    }

    func testEmptyWhenTheLoginDoesNotSay() {
        XCTAssertEqual(PlanLabel.label(oauth: ["subscriptionType": ""]), "")
        XCTAssertEqual(PlanLabel.label(oauth: ["subscriptionType": "  "]), "")
        XCTAssertEqual(PlanLabel.label(oauth: [:]), "")
        XCTAssertEqual(PlanLabel.label(oauth: nil), "")
    }

    func testOnlyATrailingMultiplierIsATier() {
        XCTAssertEqual(
            PlanLabel.label(oauth: ["subscriptionType": "max", "rateLimitTier": "max_x"]), "Max")
        XCTAssertEqual(
            PlanLabel.label(oauth: ["subscriptionType": "max", "rateLimitTier": "20x"]), "Max")
    }
}
