import Foundation

/// The one way this app runs a child process. Stdout is drained BEFORE waiting
/// and stderr goes to the null device (or is merged into stdout on request):
/// an unread `Pipe()` deadlocks `waitUntilExit()` the moment the child fills
/// it, which is how every hand-rolled `Process` here used to be one verbose
/// `security` or `ccusage` away from hanging the menu bar.
enum Shell {
    struct Result {
        let status: Int32
        let out: String
        var ok: Bool { status == 0 }
    }

    /// Run `exe args…` to completion. `env` replaces the child's environment
    /// when given; `mergeStderr` folds stderr into `out` for callers that show
    /// the child's complaint to the user.
    /// `stdin`, when given, is written to the child and closed: the way a
    /// secret reaches `security -i` without appearing in any argv.
    static func run(
        _ exe: String, _ args: [String], env: [String: String]? = nil, mergeStderr: Bool = false,
        stdin: Data? = nil
    ) -> Result {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = args
        if let env { proc.environment = env }
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = mergeStderr ? out : FileHandle.nullDevice
        let input = stdin.map { _ in Pipe() }
        proc.standardInput = input ?? FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return Result(status: -1, out: "")
        }
        if let input, let stdin {
            try? input.fileHandleForWriting.write(contentsOf: stdin)
            try? input.fileHandleForWriting.close()
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return Result(status: proc.terminationStatus, out: String(decoding: data, as: UTF8.self))
    }

    /// Start `exe args…` and do not wait - for notifications and the user's
    /// event command, whose output nobody reads.
    static func launch(_ exe: String, _ args: [String]) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = args
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    /// A login-ish PATH so Homebrew / Volta / npm global bins resolve from an
    /// app launched by launchd, which inherits none of the shell's PATH.
    static var toolEnvironment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extra = [
            "/opt/homebrew/bin", "/usr/local/bin",
            NSHomeDirectory() + "/.volta/bin",
            NSHomeDirectory() + "/.npm-global/bin",
        ]
        env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
        return env
    }
}
