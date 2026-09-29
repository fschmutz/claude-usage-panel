import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The usage endpoint's non-2xx contract, against the same fixture the JS
/// ports assert (tests/parity.test.js "usageFailure"). No network: the whole
/// mapping is a pure function of the status and the body, which is the point -
/// the app layer only has to hand it those two.
final class UsageFailureTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        try Fixtures.load("usage-endpoint.json")
    }

    func testLiveLoginMessageIsPinned() throws {
        let fix = try fixture()
        XCTAssertEqual(UsageFailure.authExpiredMessage, fix["authExpiredMessage"] as! String)
    }

    func testEveryStatusMapsLikeTheOtherPorts() throws {
        let fix = try fixture()
        let now = UsageNormalizer.parseDate(fix["now"] as? String)!
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let body = (c["body"] as? [String: Any]).flatMap {
                try? JSONSerialization.data(withJSONObject: $0)
            }
            let got = UsageFailure(
                status: (c["status"] as! NSNumber).intValue, body: body,
                label: c["label"] as? String, retryAfter: c["retryAfter"] as? String, now: now)
            let want = c["expected"] as! [String: Any]
            XCTAssertEqual(got.code.rawValue, want["code"] as! String, name)
            XCTAssertEqual(got.signInAgain, want["signInAgain"] as! Bool, name)
            XCTAssertEqual(got.retryable, want["retryable"] as! Bool, name)
            XCTAssertEqual(got.message, want["message"] as! String, name)
            XCTAssertEqual(
                got.retryAfterSeconds, (want["retryAfterSeconds"] as? NSNumber)?.intValue, name)
        }
    }

    /// A 200 never reaches UsageFailure, but the transient set it leans on is
    /// the one HttpFailure already publishes - keep them the same list.
    func testTransientSetMatchesHttpFailure() {
        for status in [408, 424, 425, 429, 500, 503, 599] {
            XCTAssertTrue(HttpFailure.isTransient(status), "\(status)")
            XCTAssertTrue(UsageFailure(status: status, body: nil).retryable, "\(status)")
        }
        for status in [400, 404, 418, 600] {
            XCTAssertFalse(HttpFailure.isTransient(status), "\(status)")
            XCTAssertFalse(UsageFailure(status: status, body: nil).retryable, "\(status)")
        }
    }
}
