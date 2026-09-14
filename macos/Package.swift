// swift-tools-version: 5.9
import PackageDescription

// The SwiftUI menu-bar app is macOS-only; the pure ClaudeUsageCore library
// (Foundation only) builds and unit-tests on any platform, including Linux CI.
// Complete concurrency checking now, while the package is still in Swift 5
// language mode: every value crossing an isolation boundary must be Sendable,
// so the eventual swift-tools-version 6 bump changes nothing.
let strict: [SwiftSetting] = [.enableUpcomingFeature("StrictConcurrency")]

var targets: [Target] = [
    .target(name: "ClaudeUsageCore", swiftSettings: strict),
    .testTarget(
        name: "ClaudeUsageCoreTests", dependencies: ["ClaudeUsageCore"], swiftSettings: strict),
]

#if os(macOS)
    targets.append(
        .executableTarget(
            name: "ClaudeUsagePanel", dependencies: ["ClaudeUsageCore"], swiftSettings: strict))
#endif

let package = Package(
    name: "ClaudeUsagePanel",
    platforms: [.macOS(.v13)],
    targets: targets
)
