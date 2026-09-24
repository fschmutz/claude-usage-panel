// swift-tools-version: 6.0
import PackageDescription

// The SwiftUI menu-bar app is macOS-only; the pure ClaudeUsageCore library
// (Foundation only) builds and unit-tests on any platform, including Linux CI.
// Swift 6 language mode (the tools-version 6 default): complete concurrency
// checking is an error, not a warning.
var targets: [Target] = [
    .target(name: "ClaudeUsageCore"),
    .testTarget(name: "ClaudeUsageCoreTests", dependencies: ["ClaudeUsageCore"]),
]

#if os(macOS)
    targets.append(
        .executableTarget(
            name: "ClaudeUsagePanel", dependencies: ["ClaudeUsageCore"]))
#endif

let package = Package(
    name: "ClaudeUsagePanel",
    platforms: [.macOS(.v13)],
    targets: targets
)
