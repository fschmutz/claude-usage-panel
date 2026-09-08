import Foundation
import XCTest

@testable import ClaudeUsageCore

final class UsageNormalizerTests: XCTestCase {
    func testLimitsArrayIncludesPerModelAndSorts() {
        let cards = UsageNormalizer.normalize([
            "limits": [
                [
                    "kind": "weekly_scoped", "percent": 100, "severity": "critical",
                    "resets_at": "2026-07-07T06:00:00Z", "is_active": true,
                    "scope": ["model": ["display_name": "Fable"]],
                ],
                ["kind": "session", "percent": 42, "severity": "normal", "is_active": false],
                ["kind": "weekly_all", "percent": 72, "severity": "normal"],
            ]
        ])
        XCTAssertEqual(cards.map(\.id), ["session", "weekly_all", "weekly_scoped:Fable"])
        let fable = cards.first { $0.id == "weekly_scoped:Fable" }
        XCTAssertEqual(fable?.label, "Weekly · Fable")
        XCTAssertEqual(fable?.percent, 100)
        XCTAssertEqual(fable?.severity, .critical)
        XCTAssertEqual(fable?.active, true)
    }

    func testLegacyFallback() {
        let cards = UsageNormalizer.normalize([
            "five_hour": ["utilization": 10, "resets_at": "x"],
            "seven_day": ["utilization": 55],
        ])
        XCTAssertEqual(cards.count, 2)
        XCTAssertEqual(cards[0].id, "session")
        XCTAssertTrue(cards[0].active)
        XCTAssertEqual(cards[1].percent, 55)
    }

    func testEmptyPayloads() {
        XCTAssertTrue(UsageNormalizer.normalize([:]).isEmpty)
        XCTAssertTrue(UsageNormalizer.normalize(["limits": [[String: Any]]()]).isEmpty)
    }

    /// Fable draws from the weekly all-models pool, so its card is a sub-cap that
    /// shares the pooled reset - the API only fills the scoped `resets_at` once
    /// Fable has been used in the window.
    func testScopedLimitInheritsPooledResetAndCarriesNote() {
        let cards = UsageNormalizer.normalize([
            "limits": [
                [
                    "kind": "weekly_all", "group": "weekly", "percent": 28,
                    "resets_at": "2026-07-28T06:00:00Z", "is_active": true,
                ],
                [
                    "kind": "weekly_scoped", "group": "weekly", "percent": 0,
                    "resets_at": NSNull(), "is_active": false,
                    "scope": ["model": ["display_name": "Fable"]],
                ],
            ]
        ])
        let fable = cards.first { $0.id == "weekly_scoped:Fable" }
        XCTAssertEqual(fable?.group, "weekly")
        XCTAssertEqual(fable?.scoped, true)
        XCTAssertEqual(fable?.resetsAt, UsageNormalizer.parseDate("2026-07-28T06:00:00Z"))
        XCTAssertEqual(UsageNormalizer.poolNote(fable!), "Share of the weekly all-models limit")
        let weekly = cards.first { $0.id == "weekly_all" }!
        XCTAssertEqual(weekly.scoped, false)
        XCTAssertEqual(UsageNormalizer.poolNote(weekly), "")
    }

    func testPercentClampAndRound() {
        let cards = UsageNormalizer.normalize([
            "limits": [["kind": "session", "percent": 142.6]]
        ])
        XCTAssertEqual(cards.first?.percent, 100)
    }
}

/// Cross-port parity: assert the Swift normalizer against the very same fixture
/// file the JS ports use (tests/parity.test.js). One shared contract, three
/// implementations - if any drifts on the semantic core, a port's suite reddens.
final class NormalizeParityTests: XCTestCase {
    func testMatchesSharedFixtures() throws {
        // #filePath → …/macos/Tests/ClaudeUsageCoreTests/CoreTests.swift; climb to repo root.
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ClaudeUsageCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // macos
            .deletingLastPathComponent()  // repo root
        let url = root.appendingPathComponent("tests/fixtures/normalize.json")
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let cases = (obj as! [String: Any])["cases"] as! [[String: Any]]

        for c in cases {
            let name = c["name"] as? String ?? "?"
            let input = c["input"] as! [String: Any]
            let expected = c["expected"] as! [[String: Any]]
            let cards = UsageNormalizer.normalize(input)
            XCTAssertEqual(cards.count, expected.count, "count - \(name)")
            for (i, e) in expected.enumerated() where i < cards.count {
                let card = cards[i]
                XCTAssertEqual(
                    card.id.components(separatedBy: ":")[0], e["kind"] as? String, "kind - \(name)")
                XCTAssertEqual(card.group, e["group"] as? String, "group - \(name)")
                XCTAssertEqual(card.scoped, e["scoped"] as? Bool, "scoped - \(name)")
                XCTAssertEqual(card.percent, e["percent"] as? Int, "percent - \(name)")
                XCTAssertEqual(
                    card.severity.rawValue, e["severity"] as? String, "severity - \(name)")
                XCTAssertEqual(card.active, e["active"] as? Bool, "active - \(name)")
                XCTAssertEqual(
                    card.resetsAt, UsageNormalizer.parseDate(e["resetsAt"] as? String),
                    "resetsAt - \(name)")
            }
        }
    }
}

final class CursorMathTests: XCTestCase {
    func testSpendWithoutLimit() {
        let s = CursorMath.summarizeSpend([
            ["email": "a@x", "overallSpendCents": 100_000],
            ["email": "b@x", "overallSpendCents": 25000],
        ])
        XCTAssertEqual(s.cycleUSD, 1250)
        XCTAssertEqual(s.members, 2)
        XCTAssertNil(s.percent)
        XCTAssertEqual(s.top?.email, "a@x")
        XCTAssertEqual(s.top?.usd, 1000)
    }

    func testSpendWithLimitGivesGauge() {
        let s = CursorMath.summarizeSpend([
            ["email": "a@x", "overallSpendCents": 6000, "monthlyLimitDollars": 100],
            ["email": "b@x", "overallSpendCents": 0, "monthlyLimitDollars": 100],
        ])
        XCTAssertEqual(s.cycleUSD, 60)
        XCTAssertEqual(s.limitUSD, 200)
        XCTAssertEqual(s.percent, 30)
    }

    func testToday() {
        XCTAssertEqual(
            CursorMath.summarizeToday([["chargedCents": 150], ["chargedCents": 89]]), 2.39)
        XCTAssertEqual(CursorMath.summarizeToday([]), 0)
    }
}

/// Extra-usage + unknown-kind-label parity against the fixture the JS ports
/// assert (tests/parity.test.js).
final class ExtraUsageParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/extra-usage.json")
        return try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
    }

    func testMatchesSharedFixtures() throws {
        for c in try fixture()["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let got = ExtraUsage.normalize(c["payload"] as! [String: Any])
            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, "expected nil - \(name)")
                continue
            }
            let extra = try XCTUnwrap(got, "expected extra usage - \(name)")
            XCTAssertEqual(extra.percent, (e["percent"] as! NSNumber).intValue, "percent - \(name)")
            XCTAssertEqual(extra.severity.rawValue, e["severity"] as! String, "severity - \(name)")
            XCTAssertEqual(
                extra.usedAmount, (e["usedAmount"] as! NSNumber).doubleValue,
                accuracy: 0.0001, "used - \(name)")
            if let limit = e["limitAmount"] as? NSNumber {
                XCTAssertEqual(
                    try XCTUnwrap(extra.limitAmount), limit.doubleValue,
                    accuracy: 0.0001, "limit - \(name)")
            } else {
                XCTAssertNil(extra.limitAmount, "limit nil - \(name)")
            }
            XCTAssertEqual(extra.currency, e["currency"] as! String, "currency - \(name)")
            XCTAssertEqual(extra.detail, e["detail"] as! String, "detail - \(name)")
        }
    }

    func testLabelsUnknownKinds() throws {
        for l in try fixture()["labels"] as! [[String: Any]] {
            let kind = l["kind"] as! String
            XCTAssertEqual(UsageNormalizer.kindLabel(kind), l["expected"] as! String, kind)
        }
    }
}

/// Clock-pace parity: used-vs-elapsed against the same fixture the JS ports
/// assert (tests/parity.test.js).
final class ClockPaceParityTests: XCTestCase {
    func testMatchesSharedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/pace.json")
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let fix = obj as! [String: Any]
        let now = Date(timeIntervalSince1970: (fix["now"] as! NSNumber).doubleValue / 1000)
        XCTAssertEqual(UsageClock.tolerance, (fix["tolerance"] as! NSNumber).intValue)

        for c in fix["cases"] as! [[String: Any]] {
            let name = c["name"] as? String ?? "?"
            let raw = c["card"] as! [String: Any]
            let card = LimitCard(
                id: name, label: name,
                percent: (raw["percent"] as! NSNumber).intValue, severity: .normal,
                resetsAt: UsageNormalizer.parseDate(raw["resetsAt"] as? String), active: true,
                group: raw["group"] as! String, scoped: false)
            let got = UsageClock.pace(card, now: now)

            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, "expected nil - \(name)")
                continue
            }
            let pace = try XCTUnwrap(got, "expected a pace - \(name)")
            XCTAssertEqual(
                pace.elapsedPercent, (e["elapsedPercent"] as! NSNumber).intValue,
                "elapsed - \(name)")
            XCTAssertEqual(
                pace.deltaPoints, (e["deltaPoints"] as! NSNumber).intValue, "delta - \(name)")
            XCTAssertEqual(pace.state.rawValue, e["state"] as! String, "state - \(name)")
        }
    }

    func testFormatOnlySpeaksWhenAhead() {
        XCTAssertEqual(
            UsageClock.format(ClockPace(elapsedPercent: 60, deltaPoints: 25, state: .ahead)),
            "60% of the window gone - 25 pts ahead of the clock")
        XCTAssertEqual(
            UsageClock.format(ClockPace(elapsedPercent: 60, deltaPoints: 2, state: .even)), "")
        XCTAssertEqual(UsageClock.format(nil), "")
    }
}

/// Forecast parity: the burn-rate projection against the same fixture the three
/// JS copies assert (tests/parity.test.js). Numbers must match exactly - the
/// fixture is designed away from rounding boundaries so double math agrees
/// across languages.
final class ForecastParityTests: XCTestCase {
    func testMatchesSharedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = root.appendingPathComponent("tests/fixtures/forecast.json")
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        let fix = obj as! [String: Any]
        let now = (fix["now"] as! NSNumber).doubleValue
        let cases = fix["cases"] as! [[String: Any]]

        for c in cases {
            let name = c["name"] as? String ?? "?"
            let samples = (c["samples"] as! [[NSNumber]]).map {
                (t: $0[0].doubleValue, p: $0[1].doubleValue)
            }
            let resetsAt = UsageNormalizer.parseDate(c["resetsAt"] as? String)
            let got = UsageForecast.forecast(samples: samples, resetsAt: resetsAt, nowMs: now)

            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, "expected nil - \(name)")
                continue
            }
            let fc = try XCTUnwrap(got, "expected a forecast - \(name)")
            XCTAssertEqual(
                fc.pctPerHour, (e["pctPerHour"] as! NSNumber).doubleValue,
                accuracy: 0.001, "pace - \(name)")
            XCTAssertEqual(
                fc.projectedFullAt,
                UsageNormalizer.parseDate(e["projectedFullAt"] as? String),
                "projectedFullAt - \(name)")
            XCTAssertEqual(
                fc.exhaustsBeforeReset, e["exhaustsBeforeReset"] as? Bool,
                "exhausts - \(name)")
            if let m = e["marginHours"] as? NSNumber {
                XCTAssertEqual(
                    try XCTUnwrap(fc.marginHours), m.doubleValue,
                    accuracy: 0.001, "margin - \(name)")
            } else {
                XCTAssertNil(fc.marginHours, "margin nil - \(name)")
            }
        }
    }

    func testFormat() {
        let fc = Forecast(
            pctPerHour: 1.8,
            projectedFullAt: UsageNormalizer.parseDate("2026-08-02T03:40:00Z")!,
            exhaustsBeforeReset: true, marginHours: -34.3)
        // Weekday/time render in the local zone; assert the shape.
        let s = UsageForecast.format(fc)
        XCTAssertTrue(s.hasPrefix("↗ 1.8%/h - full ~"), s)
        XCTAssertTrue(s.hasSuffix(", 1d10h before reset"), s)
        XCTAssertEqual(
            UsageForecast.format(
                Forecast(
                    pctPerHour: 0.6, projectedFullAt: Date(),
                    exhaustsBeforeReset: false, marginHours: 12)),
            "↗ 0.6%/h - lasts past reset")
        XCTAssertEqual(
            UsageForecast.format(
                Forecast(
                    pctPerHour: 4, projectedFullAt: Date(),
                    exhaustsBeforeReset: false, marginHours: nil)),
            "↗ 4%/h")
        XCTAssertEqual(UsageForecast.format(nil), "")
    }
}
