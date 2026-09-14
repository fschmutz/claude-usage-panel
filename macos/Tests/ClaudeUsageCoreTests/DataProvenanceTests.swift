import XCTest

@testable import ClaudeUsageCore

final class DataProvenanceTests: XCTestCase {
    func testBadgesAreShortEnoughForADenseRow() {
        for p in Provenance.allCases {
            XCTAssertFalse(p.badge.isEmpty)
            XCTAssertLessThanOrEqual(p.badge.count, 10, "\(p) badge is too long for the panel")
            XCTAssertFalse(p.explanation.isEmpty)
        }
    }

    // The classification is the load-bearing part: limits are read, cost is
    // computed. Getting this backwards is the exact failure this type exists
    // to prevent.
    func testLimitsAreOfficialAndCostIsNot() {
        XCTAssertEqual(Provenances.limits, .official)
        XCTAssertEqual(Provenances.cost, .estimated)
    }
}
