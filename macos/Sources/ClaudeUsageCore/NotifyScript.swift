import Foundation

/// The `osascript` argument vector for one notification. The text travels as
/// run-handler arguments, never inside the AppleScript source: the body carries
/// API-supplied model names and account emails, and escaping only `"` let a
/// trailing backslash close the string literal and run the rest as script.
/// With argv there is nothing to escape, so no input can change the program.
///
/// The first argument is a fixed word: osascript parses options until its
/// first non-option argument, so a body starting with `-` (an API-supplied
/// model name) would otherwise be read as an osascript flag.
public enum NotifyScript {
    public static let source = [
        "on run argv",
        "display notification (item 2 of argv) with title (item 3 of argv)",
        "end run",
    ]

    public static func arguments(title: String, body: String) -> [String] {
        source.flatMap { ["-e", $0] } + ["notify", body, title]
    }
}
