import Foundation
import XCTest

@testable import ClaudeUsageCore

/// Honest readings, against the same fixture the JS ports assert
/// (tests/parity.test.js "usageReading" / "percentKnown").
final class UsageReadingTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("reading.json") }

    private func date(_ iso: String) -> Date {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)!
    }

    func testEmDashIsPinned() throws {
        let fix = try fixture()
        XCTAssertEqual(UsageReading.noReading, fix["noReading"] as! String)
    }

    /// A payload that carried no number for a limit produces a card with
    /// `percentKnown == false`, not a card sitting at 0 %.
    func testNormalizeMarksWhichPercentsAreReal() throws {
        let fix = try fixture()
        for c in fix["normalize"] as! [[String: Any]] {
            let name = c["name"] as! String
            let got = UsageNormalizer.normalize(c["input"] as! [String: Any])
            let want = c["expected"] as! [[String: Any]]
            XCTAssertEqual(got.count, want.count, name)
            for (card, e) in zip(got, want) {
                XCTAssertEqual(card.id.components(separatedBy: ":")[0], e["kind"] as! String, name)
                XCTAssertEqual(card.percent, (e["percent"] as! NSNumber).intValue, name)
                XCTAssertEqual(card.percentKnown, e["percentKnown"] as! Bool, name)
            }
        }
    }

    func testReadings() throws {
        let fix = try fixture()
        let now = date(fix["now"] as! String)
        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as! String
            let raw = c["card"] as! [String: Any]
            let card = LimitCard(
                id: "session", label: "Current session",
                percent: (raw["percent"] as! NSNumber).intValue, severity: .normal,
                resetsAt: UsageNormalizer.parseDate(raw["resetsAt"] as? String), active: true,
                group: "session", scoped: false, percentKnown: raw["percentKnown"] as! Bool)
            let e = c["expected"] as! [String: Any]
            let want = UsageReading(
                known: e["known"] as! Bool, percent: (e["percent"] as? NSNumber)?.intValue,
                fill: (e["fill"] as! NSNumber).intValue, text: e["text"] as! String,
                reason: (e["reason"] as? String).map { UsageReading.Reason(rawValue: $0)! })
            XCTAssertEqual(UsageReading.of(card, now: now), want, name)
        }
    }

    /// Which card the menu-bar title shows - the same pick as the GNOME top
    /// bar and the Linux status bar, ties included.
    func testPanelCardPicksLikeTheOtherPorts() throws {
        let fix = try fixture()
        let now = date(fix["now"] as! String)
        for c in fix["panelCard"] as! [[String: Any]] {
            let name = c["name"] as! String
            let cards = (c["cards"] as! [[String: Any]]).map { raw in
                LimitCard(
                    id: raw["key"] as! String, label: raw["key"] as! String,
                    percent: (raw["percent"] as! NSNumber).intValue, severity: .normal,
                    resetsAt: UsageNormalizer.parseDate(raw["resetsAt"] as? String),
                    active: true, percentKnown: raw["percentKnown"] as! Bool)
            }
            let mode = PanelCard.Mode(rawValue: c["mode"] as! String)!
            XCTAssertEqual(
                PanelCard.pick(cards, mode: mode, now: now)?.id, c["expected"] as? String, name)
        }
    }
}
