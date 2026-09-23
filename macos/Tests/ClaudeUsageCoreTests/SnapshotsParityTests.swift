import XCTest

@testable import ClaudeUsageCore

/// The claudectl snapshot summary, asserted against the fixture the GNOME port
/// runs in tests/parity.test.js.
final class SnapshotsParityTests: XCTestCase {
    func testFixture() throws {
        let fix = try Fixtures.load("snapshots.json")
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let files = (c["files"] as! [[String: Any]]).map {
                (label: $0["label"] as! String, json: $0["data"] as Any?)
            }
            let got = Snapshots.summarize(files)
            let expect = c["expect"] as! [String: Any]
            XCTAssertEqual(got.count, (expect["count"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.autos, (expect["autos"] as! NSNumber).intValue, name)
            if let newest = expect["newest"] as? [String: Any] {
                XCTAssertEqual(got.newest?.label, newest["label"] as? String, name)
                XCTAssertEqual(
                    got.newest?.savedAtMs, (newest["savedAt"] as! NSNumber).doubleValue, name)
                XCTAssertEqual(got.newest?.names, newest["names"] as? [String], name)
            } else {
                XCTAssertNil(got.newest, name)
            }
        }
    }
}
