import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The shared fixtures under tests/fixtures/, resolved from this file's
/// location (…/macos/Tests/ClaudeUsageCoreTests/TestSupport.swift).
enum Fixtures {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // ClaudeUsageCoreTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // macos
        .deletingLastPathComponent()  // repo root
        .appendingPathComponent("tests/fixtures")

    static func load(_ name: String) throws -> [String: Any] {
        let url = root.appendingPathComponent(name)
        return try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
            "\(name) is not a JSON object")
    }
}

extension LimitCard {
    /// A card with only the fields a test cares about.
    static func stub(
        id: String, percent: Int, label: String? = nil, group: String = "session",
        severity: Severity = .normal, resetsAt: Date? = nil, active: Bool = true
    ) -> LimitCard {
        LimitCard(
            id: id, label: label ?? id, percent: percent, severity: severity,
            resetsAt: resetsAt, active: active, group: group, scoped: false)
    }
}
