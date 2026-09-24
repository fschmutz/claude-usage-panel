import Foundation

/// The `osascript` argument vector for one notification. The text travels as
/// run-handler arguments, never inside the AppleScript source: the body carries
/// API-supplied model names and account emails, and escaping only `"` let a
/// trailing backslash close the string literal and run the rest as script.
/// With argv there is nothing to escape, so no input can change the program.
public enum NotifyScript {
    public static let source = [
        "on run argv",
        "display notification (item 1 of argv) with title (item 2 of argv)",
        "end run",
    ]

    public static func arguments(title: String, body: String) -> [String] {
        source.flatMap { ["-e", $0] } + [body, title]
    }
}
