import Foundation

// Session-ping schedule shared between the CLI installer (`install.sh
// sessionping`) and the app's Settings UI. Both are frontends over the same
// launchd agent plist: the installer writes it from a heredoc, the app writes
// it from `plistXML` below - byte-identical, so either side can read back and
// rewrite what the other configured (install.sh's `_sp_current_times` parses
// this exact one-interval-per-line shape).

public struct SessionPingSchedule: Equatable, Sendable {
    /// Ping times as zero-padded "HH:MM", in user order (not sorted).
    public var times: [String]
    /// Days the ping fires, `date +%u` numbering: 1 = Monday ... 7 = Sunday.
    public var days: Set<Int>

    public init(times: [String], days: Set<Int>) {
        self.times = times
        self.days = days
    }

    public static let `default` = SessionPingSchedule(times: ["05:30"], days: [1, 2, 3, 4, 5])

    /// The `--days=` value baked into the runner invocation: sorted, comma-joined.
    public var daysArg: String {
        days.sorted().map(String.init).joined(separator: ",")
    }

    public static func isValidTime(_ t: String) -> Bool {
        t.range(of: #"^([01]?[0-9]|2[0-3]):[0-5][0-9]$"#, options: .regularExpression) != nil
    }

    public var isValid: Bool {
        !times.isEmpty && times.allSatisfy(Self.isValidTime)
            && !days.isEmpty && days.allSatisfy { (1...7).contains($0) }
    }
}

public enum SessionPingAgent {
    public static let label = "io.github.fschmutz.claude-usage-panel.sessionping"

    /// XML-escape text going into the plist. A checkout or install path may
    /// legally contain `&`, `<` or `>` - a `Dev & Ops` folder is enough - and
    /// interpolating one raw produces a plist launchd refuses to load, which
    /// surfaces only as the unhelpful "could not load the agent". install.sh's
    /// `_au_xml_escape` escapes the same three characters in the same order
    /// (`&` first, so the substitutions cannot chain), which is what keeps the
    /// two writers byte-identical. Nothing has to unescape: `parse()` reads
    /// through PropertyListSerialization and the shell parsers only ever match
    /// integers and the `--days=` list.
    public static func xmlEscape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Render the launchd agent plist. Must stay byte-identical to the heredoc
    /// in install.sh's `install_sessionping` - the shell side parses it back
    /// with line-oriented sed/grep, not a plist library.
    public static func plistXML(schedule: SessionPingSchedule, runner: String) -> String {
        var intervals = ""
        for t in schedule.times {
            let parts = t.split(separator: ":")
            let h = Int(parts.first ?? "0") ?? 0
            let m = Int(parts.count > 1 ? parts[1] : "0") ?? 0
            intervals +=
                "    <dict><key>Hour</key><integer>\(h)</integer>"
                + "<key>Minute</key><integer>\(m)</integer></dict>\n"
        }
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>\(xmlEscape(label))</string>
              <key>ProgramArguments</key>
              <array>
                <string>/bin/bash</string>
                <string>\(xmlEscape(runner))</string>
                <string>--quiet</string>
                <string>--days=\(schedule.daysArg)</string>
              </array>
              <key>StartCalendarInterval</key>
              <array>
            \(intervals)  </array>
              <key>RunAtLoad</key><false/>
              <key>ProcessType</key><string>Background</string>
              <key>LowPriorityIO</key><true/>
            </dict>
            </plist>

            """
    }

    /// The script a launchd agent runs: `[/bin/bash, <runner>, --flags…]`, so
    /// the first argument after the shell that is not a flag. Shared with the
    /// auto-update agent, which has the same shape.
    public static func runner(in programArguments: [String]) -> String? {
        programArguments.dropFirst().first { !$0.hasPrefix("-") }
    }

    /// Parse an existing agent plist (any formatting - a plist library on this
    /// side, unlike the shell's line parser) back into a schedule plus the
    /// runner script path baked into ProgramArguments.
    public static func parse(plistData: Data) -> (schedule: SessionPingSchedule, runner: String?)? {
        guard
            let obj = try? PropertyListSerialization.propertyList(
                from: plistData, options: [], format: nil) as? [String: Any]
        else { return nil }

        // StartCalendarInterval: an array of Hour/Minute dicts, or (a plist
        // written by hand / an old tool) a single dict.
        var intervals: [[String: Any]] = []
        if let arr = obj["StartCalendarInterval"] as? [[String: Any]] {
            intervals = arr
        } else if let one = obj["StartCalendarInterval"] as? [String: Any] {
            intervals = [one]
        }
        let times = intervals.compactMap { d -> String? in
            guard let h = (d["Hour"] as? NSNumber)?.intValue,
                let m = (d["Minute"] as? NSNumber)?.intValue
            else { return nil }
            return String(format: "%02d:%02d", h, m)
        }
        guard !times.isEmpty else { return nil }

        let args = obj["ProgramArguments"] as? [String] ?? []
        let runner = runner(in: args)
        var days: Set<Int> = [1, 2, 3, 4, 5]
        if let daysArg = args.first(where: { $0.hasPrefix("--days=") }) {
            let parsed = daysArg.dropFirst("--days=".count)
                .split(separator: ",").compactMap { Int($0) }.filter { (1...7).contains($0) }
            if !parsed.isEmpty { days = Set(parsed) }
        }
        return (SessionPingSchedule(times: times, days: days), runner)
    }
}
