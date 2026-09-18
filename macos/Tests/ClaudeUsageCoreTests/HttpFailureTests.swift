import Foundation
import XCTest

@testable import ClaudeUsageCore

/// HTTP-failure parity against the fixture both JS ports assert (tests/parity.test.js).
final class HttpFailureParityTests: XCTestCase {
    func testMatchesSharedFixtures() throws {
        let fix = try Fixtures.load("httpfailure.json")
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let body = (c["body"] as? [String: Any]).flatMap {
                try? JSONSerialization.data(withJSONObject: $0)
            }
            let got = HttpFailure(status: (c["status"] as! NSNumber).intValue, body: body)
            let e = c["expected"] as! [String: Any]
            XCTAssertEqual(got.message, e["message"] as! String, name)
            XCTAssertEqual(got.transient, (e["code"] as! String) == "transient", name)
        }
        for s in fix["transient"] as! [NSNumber] {
            XCTAssertTrue(HttpFailure.isTransient(s.intValue), "\(s)")
        }
        for s in fix["notTransient"] as! [NSNumber] {
            XCTAssertFalse(HttpFailure.isTransient(s.intValue), "\(s)")
        }
        // A body that is not JSON at all adds nothing.
        XCTAssertEqual(HttpFailure(status: 424, body: Data("<html>".utf8)).message, "HTTP 424")
    }
}
