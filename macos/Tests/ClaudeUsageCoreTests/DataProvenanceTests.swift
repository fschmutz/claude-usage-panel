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

    // The classification is the load-bearing part: limits are read, cost and
    // forecasts are computed. Getting this backwards is the exact failure this
    // type exists to prevent.
    func testLimitsAreOfficialAndDerivedValuesAreNot() {
        XCTAssertEqual(Provenances.limits, .official)
        XCTAssertEqual(Provenances.cost, .estimated)
        XCTAssertEqual(Provenances.forecast, .estimated)
    }

    func testSourcedCarriesProvenanceAndCompares() {
        let a = Sourced(42, .official)
        XCTAssertEqual(a.value, 42)
        XCTAssertTrue(a.isOfficial)
        XCTAssertFalse(Sourced(42, .estimated).isOfficial)
        XCTAssertEqual(a, Sourced(42, .official))
        XCTAssertNotEqual(a, Sourced(42, .estimated))
    }
}
