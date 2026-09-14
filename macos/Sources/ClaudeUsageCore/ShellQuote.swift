import Foundation

/// POSIX single-quoting for values pasted into a shell command. Labels come
/// from the API and session paths from a log file: quoted, never interpolated
/// bare, in every port.
public enum ShellQuote {
    public static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
