import ClaudeUsageCore
import Foundation

// Today's sessions on macOS: the same incremental index the GNOME extension and
// the node ports maintain (lib/sessionIndex.js, mcp/server.js), and the same
// resume command - opened here in Terminal or iTerm instead of a Linux emulator.
//
// The transcripts under ~/.claude/projects are append-only and reach tens of
// megabytes each, so each file is folded once and thereafter only from the byte
// offset it was folded to. A per-refresh byte budget caps one pass; `pending`
// says the numbers are still a floor and the next pass continues.

struct SessionIndexFile: Codable {
    var version: Int
    var files: [String: SessionAcc]
}

enum SessionStore {
    static let indexVersion = 1
    static let chunkBudget = 64 << 20  // bytes folded per refresh
    static let rowLimit = 5

    /// Shared with the node ports, which use XDG_CACHE_HOME (or ~/.cache) on
    /// Linux; on macOS both land in the user's Caches directory.
    static var indexURL: URL {
        let base =
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Caches")
        return base.appendingPathComponent("claude-usage-panel/sessions.json")
    }

    static var projectsURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects")
    }

    /// Where scripts/session-ping.sh records its last successful ping - the
    /// same XDG state path it uses on macOS.
    static var lastPingURL: URL {
        let state =
            ProcessInfo.processInfo.environment["XDG_STATE_HOME"]
            .map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/state")
        return state.appendingPathComponent("claude-usage-panel/last-ping")
    }

    static func readLastPing() -> String? {
        guard let raw = try? String(contentsOf: lastPingURL, encoding: .utf8) else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func loadIndex() -> SessionIndexFile {
        guard let data = try? Data(contentsOf: indexURL),
            let parsed = try? JSONDecoder().decode(SessionIndexFile.self, from: data),
            parsed.version == indexVersion
        else { return SessionIndexFile(version: indexVersion, files: [:]) }
        return parsed
    }

    private static func saveIndex(_ index: SessionIndexFile) {
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? FileManager.default.createDirectory(
            at: indexURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: indexURL, options: .atomic)
    }

    private struct Candidate {
        let path: String
        let size: Int
        let mtimeMs: Double
    }

    // Transcripts touched in the last two days - the only ones that can carry
    // tokens spent today.
    private static func candidates(now: Date) -> [Candidate] {
        let cutoff = now.addingTimeInterval(-2 * 86400)
        let fm = FileManager.default
        guard let projects = try? fm.contentsOfDirectory(atPath: projectsURL.path) else {
            return []
        }
        var out: [Candidate] = []
        for project in projects {
            let dir = projectsURL.appendingPathComponent(project)
            guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { continue }
            for name in names where name.hasSuffix(".jsonl") {
                let file = dir.appendingPathComponent(name)
                guard let attrs = try? fm.attributesOfItem(atPath: file.path),
                    let modified = attrs[.modificationDate] as? Date,
                    modified >= cutoff
                else { continue }
                out.append(
                    Candidate(
                        path: file.path,
                        size: (attrs[.size] as? NSNumber)?.intValue ?? 0,
                        mtimeMs: modified.timeIntervalSince1970 * 1000))
            }
        }
        return out
    }

    // Fold the appended tail of one transcript. The read window is cut at the
    // last newline BYTE and the offset advances only that far: a window can end
    // mid-line (and mid-UTF-8 sequence), and folding a half-written turn would
    // count it wrong. The remainder is read again next time.
    private static func foldTail(_ file: Candidate, _ acc: inout SessionAcc, budget: Int, now: Date)
        -> Int
    {
        let start = acc.offset
        guard file.size > start else { return 0 }
        let want = min(budget, file.size - start)
        guard let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: file.path)) else {
            return 0
        }
        defer { try? handle.close() }
        guard (try? handle.seek(toOffset: UInt64(start))) != nil,
            let data = try? handle.read(upToCount: want),
            let cut = data.lastIndex(of: 0x0a)
        else { return 0 }

        let consumed = data.distance(from: data.startIndex, to: cut) + 1
        let text = String(decoding: data[data.startIndex..<data.index(after: cut)], as: UTF8.self)
        let day = SessionFormat.day(now)
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            SessionIndexer.fold(line: String(line), into: &acc, defaultDay: day)
        }
        acc.offset = start + consumed
        acc.carry = ""
        acc.byDay = SessionIndexer.pruneByDay(acc.byDay, now: now)
        return consumed
    }

    /// Update the index and return today's sessions, biggest token spender
    /// first. `pending` means the budget ran out with files still to fold.
    static func refresh(
        now: Date = Date(), limit: Int = rowLimit, budgetBytes: Int = chunkBudget
    ) -> (sessions: [RankedSession], pending: Bool) {
        var index = loadIndex()
        let files = candidates(now: now)
        var budget = budgetBytes
        var pending = false
        var dirty = false

        for file in files {
            var acc = index.files[file.path] ?? SessionAcc()
            // Shrunk below what we already folded: the file was replaced, not
            // appended to. Start it over rather than folding from a stale offset.
            if acc.offset > file.size { acc = SessionAcc() }
            if acc.size == file.size && acc.mtimeMs == file.mtimeMs {
                index.files[file.path] = acc
                continue
            }
            if budget <= 0 {
                pending = true
                index.files[file.path] = acc
                continue
            }
            budget -= foldTail(file, &acc, budget: budget, now: now)
            dirty = true
            if acc.offset >= file.size {
                acc.size = file.size
                acc.mtimeMs = file.mtimeMs
            } else {
                pending = true
            }
            index.files[file.path] = acc
        }

        // Forget files that fell out of the window - the index must not grow for
        // every session ever opened.
        let live = Set(files.map(\.path))
        for path in index.files.keys where !live.contains(path) {
            index.files.removeValue(forKey: path)
            dirty = true
        }
        if dirty { saveIndex(index) }

        return (SessionIndexer.rank(Array(index.files.values), now: now, limit: limit), pending)
    }
}

// MARK: - Opening one in a terminal

enum TerminalLauncher {
    /// Which terminal a resume click opens. "auto" prefers iTerm when it is
    /// installed, since someone who has it rarely wants Terminal.app.
    enum Choice: String, CaseIterable {
        case auto, terminal, iterm

        var label: String {
            switch self {
            case .auto: return "Automatic"
            case .terminal: return "Terminal"
            case .iterm: return "iTerm"
            }
        }
    }

    static func itermInstalled() -> Bool {
        FileManager.default.fileExists(atPath: "/Applications/iTerm.app")
    }

    /// AppleScript that opens a new window running `command`. The command is
    /// already POSIX-quoted by SessionResume; this escapes it once more for the
    /// AppleScript string literal it is embedded in.
    static func script(for choice: Choice, command: String) -> String {
        let escaped =
            command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let useITerm = choice == .iterm || (choice == .auto && itermInstalled())
        if useITerm {
            return """
                tell application "iTerm"
                  activate
                  set w to (create window with default profile)
                  tell current session of w to write text "\(escaped)"
                end tell
                """
        }
        return """
            tell application "Terminal"
              activate
              do script "\(escaped)"
            end tell
            """
    }

    /// Open `session` in a terminal. Returns an error line for the UI, or nil.
    @discardableResult
    static func open(session: RankedSession, choice: Choice) -> String? {
        let command = SessionResume.command(cwd: session.cwd, sessionId: session.sessionId)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script(for: choice, command: command)]
        proc.standardOutput = Pipe()
        let errors = Pipe()
        proc.standardError = errors
        do {
            try proc.run()
        } catch {
            return "Could not open a terminal: \(error.localizedDescription)"
        }
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            let text = String(
                decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            return text.isEmpty ? "The terminal refused to open." : text
        }
        return nil
    }
}
