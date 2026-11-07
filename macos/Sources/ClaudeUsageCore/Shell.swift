import Foundation

/// The one way the app runs a child process. Stdout is drained BEFORE waiting
/// and stderr goes to the null device (or is merged into stdout on request):
/// an unread `Pipe()` deadlocks `waitUntilExit()` the moment the child fills
/// it, which is how every hand-rolled `Process` here used to be one verbose
/// `security` or `ccusage` away from hanging the menu bar.
///
/// Every run has a deadline (`defaultTimeout`, the GNOME lib/proc.js
/// RUN_TIMEOUT_SECONDS): a child still running then is sent SIGTERM, then
/// SIGKILL after `killGrace`, so one hung `ccusage` costs one section one
/// poll instead of stopping the poll loop for good. Foundation only, so it
/// runs and is tested on Linux too.
public enum Shell {
    /// Seconds a child may run before it is terminated.
    public static let defaultTimeout: TimeInterval = 60
    /// Seconds between SIGTERM and SIGKILL for a child that ignores the first.
    public static let killGrace: TimeInterval = 2

    public struct Result: Sendable {
        public let status: Int32
        public let out: String
        /// The child outlived its deadline and was terminated.
        public let timedOut: Bool
        public var ok: Bool { status == 0 && !timedOut }

        public init(status: Int32, out: String, timedOut: Bool = false) {
            self.status = status
            self.out = out
            self.timedOut = timedOut
        }
    }

    /// Set once the child is reaped, so a late deadline never signals a pid
    /// the system may already have handed to another process.
    private final class Watch: @unchecked Sendable {
        private let lock = NSLock()
        private var exited = false
        private var fired = false

        /// Runs `body` only while the child has not been reaped.
        func signalIfRunning(_ body: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            guard !exited else { return }
            fired = true
            body()
        }

        func markExited() {
            lock.lock()
            exited = true
            lock.unlock()
        }

        var timedOut: Bool {
            lock.lock()
            defer { lock.unlock() }
            return fired
        }
    }

    /// Run `exe args…` to completion, or until `timeout` seconds pass. `env`
    /// replaces the child's environment when given; `mergeStderr` folds
    /// stderr into `out` for callers that show the child's complaint to the
    /// user. `stdin`, when given, is written to the child and closed: the way
    /// a secret reaches `security -i` without appearing in any argv.
    public static func run(
        _ exe: String, _ args: [String], env: [String: String]? = nil, mergeStderr: Bool = false,
        stdin: Data? = nil, timeout: TimeInterval = defaultTimeout
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
        // Armed before the first blocking call: a child that never reads its
        // stdin or never closes its stdout is ended by the deadline, which
        // closes its end of the pipes and unblocks both.
        let pid = proc.processIdentifier
        let watch = Watch()
        let queue = DispatchQueue.global(qos: .utility)
        queue.asyncAfter(deadline: .now() + max(0, timeout)) {
            watch.signalIfRunning { _ = kill(pid, SIGTERM) }
            queue.asyncAfter(deadline: .now() + killGrace) {
                watch.signalIfRunning { _ = kill(pid, SIGKILL) }
            }
        }
        // Read to EOF on a thread of its own, not this one: a grandchild that
        // inherited stdout (a shell's background job) keeps the pipe open
        // after the child itself is gone, and must not hold this call past
        // its deadline.
        let sink = Sink()
        let reader = out.fileHandleForReading
        DispatchQueue.global(qos: .utility).async {
            sink.finish(reader.readDataToEndOfFile())
        }
        if let input, let stdin {
            try? input.fileHandleForWriting.write(contentsOf: stdin)
            try? input.fileHandleForWriting.close()
        }
        proc.waitUntilExit()
        watch.markExited()
        // Output still in the pipe arrives at once; only a pipe held open by
        // someone else waits, and not for long.
        let data = sink.waitForEnd(seconds: killGrace) ?? Data()
        return Result(
            status: proc.terminationStatus, out: String(decoding: data, as: UTF8.self),
            timedOut: watch.timedOut)
    }

    /// The child's stdout, read off the calling thread.
    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var buffer: Data?
        private let ended = DispatchSemaphore(value: 0)

        func finish(_ data: Data) {
            lock.lock()
            buffer = data
            lock.unlock()
            ended.signal()
        }

        /// The whole output, or nil when EOF did not come in time.
        func waitForEnd(seconds: TimeInterval) -> Data? {
            guard ended.wait(timeout: .now() + seconds) == .success else { return nil }
            lock.lock()
            defer { lock.unlock() }
            return buffer
        }
    }

    /// Start `exe args…` and do not wait - for notifications and the user's
    /// event command, whose output nobody reads.
    public static func launch(_ exe: String, _ args: [String], extraEnv: [String: String] = [:]) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: exe)
        proc.arguments = args
        if !extraEnv.isEmpty {
            proc.environment = ProcessInfo.processInfo.environment.merging(extraEnv) { _, new in new
            }
        }
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }

    /// A login-ish PATH so Homebrew / Volta / npm global bins resolve from an
    /// app launched by launchd, which inherits none of the shell's PATH.
    public static var toolEnvironment: [String: String] {
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
