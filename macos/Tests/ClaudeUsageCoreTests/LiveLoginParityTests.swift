import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The live-login readers against tests/fixtures/accounts.json `credentials`
/// and `claudeProcesses` (tests/accounts-contract.test.js runs the same cases
/// through lib/pure/accounts.js).
final class LiveLoginParityTests: XCTestCase {
    private func section(_ key: String) throws -> [[String: Any]] {
        let fix = try Fixtures.load("accounts.json")
        return (fix[key] as! [String: Any])["cases"] as! [[String: Any]]
    }

    func testParseCredentials() throws {
        for c in try section("credentials") {
            let name = c["name"] as! String
            let got = Accounts.parseCredentials(c["raw"])
            if c["expected"] is NSNull {
                XCTAssertNil(got, name)
            } else {
                XCTAssertTrue(Accounts.sameJSON(got as Any, c["expected"]!), name)
            }
        }
    }

    func testCountClaudeProcesses() throws {
        for c in try section("claudeProcesses") {
            XCTAssertEqual(
                Accounts.countClaudeProcesses(c["ps"] as! String),
                (c["expected"] as! NSNumber).intValue, c["name"] as? String ?? "")
        }
    }
}
