import Foundation

// Awake, part two: the floors' platform half and every command the feature
// runs. Mirrors the second half of the GNOME extension's lib/pure/awake.js;
// tests/fixtures/awake.json pins both. Split out of Awake.swift (which holds
// the session arithmetic, the state and the recovery journal) only because no
// file in this repo is over 700 lines.

extension Awake {
    // MARK: Platform commands

    /// The child that holds the idle/sleep assertion. It is a CHILD on
    /// purpose: the kernel releases the assertion when it exits, so a holder
    /// that is SIGKILLed cannot leave the Mac awake forever.
    public static func inhibitArgv(
        platform: String, seconds: Int = Awake.maxSeconds, pid: Int = 0,
        who: String = "claude-usage-panel", why: String = "Claude Code is working"
    ) -> [String]? {
        let secs = String(max(1, seconds))
        if platform == "darwin" { return ["/usr/bin/caffeinate", "-i", "-w", String(pid)] }
        if platform == "linux" {
            return [
                "systemd-inhibit", "--what=idle:sleep", "--mode=block", "--who=\(who)",
                "--why=\(why)", "sleep", secs,
            ]
        }
        return nil
    }

    /// Closed-lid mode, which is the dangerous half and is off by default.
    /// `sudo -n` NEVER prompts: without the sudoers rule it fails fast with a
    /// readable error instead of hanging on a password prompt.
    public static func lidArgv(
        platform: String, on: Bool, seconds: Int = Awake.maxSeconds,
        who: String = "claude-usage-panel",
        why: String = "Claude Code is working with the lid closed"
    ) -> [String]? {
        if platform == "darwin" {
            return ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-a", "disablesleep", on ? "1" : "0"]
        }
        if platform == "linux" {
            // Nothing to run for "off": the inhibitor is a child, and letting
            // it go is the release.
            guard on else { return nil }
            return [
                "systemd-inhibit", "--what=handle-lid-switch", "--mode=block", "--who=\(who)",
                "--why=\(why)", "sleep", String(max(1, seconds)),
            ]
        }
        return nil
    }

    /// Low Power Mode, macOS only (Linux has no single equivalent).
    public static func lowPowerArgv(platform: String, on: Bool) -> [String]? {
        guard platform == "darwin" else { return nil }
        return ["/usr/bin/sudo", "-n", "/usr/bin/pmset", "-b", "lowpowermode", on ? "1" : "0"]
    }

    /// The sudoers file `./install.sh awakelid` writes, for this user only.
    public static func sudoersBody(user: String) -> String {
        var lines = [
            "# Installed by claude-usage-panel (./install.sh awakelid).",
            "# Exactly four commands, nothing else. Remove with "
                + "./install.sh --uninstall awakelid.",
        ]
        for argv in sudoCommands {
            lines.append("\(user) ALL=(root) NOPASSWD: \(argv.joined(separator: " "))")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The first `SleepDisabled` line of `pmset -g`: true for 1, false for 0,
    /// nil when there is no such line or its value is anything else. nil is
    /// NOT "off": output we cannot read is not proof the bit was set.
    public static func parseSleepDisabled(_ output: String?) -> Bool? {
        for rawLine in (output ?? "").split(whereSeparator: \.isNewline) {
            let parts = rawLine.trimmingCharacters(in: .whitespaces)
                .split(whereSeparator: { $0 == " " || $0 == "\t" })
            guard parts.first == "SleepDisabled" else { continue }
            guard parts.count >= 2 else { return nil }
            if parts[1] == "1" { return true }
            if parts[1] == "0" { return false }
            return nil
        }
        return nil
    }

    /// `pmset -g batt`: the percentage, whether it is charging, and whether
    /// there is a battery at all.
    public static func parsePmsetBattery(_ output: String?) -> AwakeBattery {
        let text = output ?? ""
        let drawing = firstGroup(text, #"Now drawing from '([^']+)'"#)
        let onAC = drawing.map { matches($0, #"(?i)ac"#) } ?? false
        let line = firstMatch(text, #"InternalBattery[^\n]*"#) ?? ""
        guard !line.isEmpty else {
            return AwakeBattery(percent: nil, charging: true, hasBattery: false)
        }
        let percent = firstGroup(line, #"(\d{1,3})%"#).flatMap(Int.init).map {
            min(100, max(0, $0))
        }
        // The battery line is the honest one: it says discharging even while
        // the adapter is plugged in but not actually charging.
        let charging: Bool
        if matches(line, #"(?i)discharging"#) {
            charging = false
        } else if matches(line, #"(?i)charging|charged|AC attached"#) {
            charging = true
        } else {
            charging = onAC
        }
        return AwakeBattery(percent: percent, charging: charging, hasBattery: true)
    }

    /// Linux `/sys/class/power_supply/BAT*`. Either file missing or
    /// unreadable is an unreadable battery, not a full one.
    public static func parseSysfsBattery(
        capacity: String?, status: String?, present: Bool = true
    ) -> AwakeBattery {
        guard present else { return AwakeBattery(percent: nil, charging: true, hasBattery: false) }
        let raw = (capacity ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let percent = matches(raw, #"^\d{1,3}$"#) ? Int(raw).map { min(100, $0) } : nil
        let state = (status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return AwakeBattery(
            percent: percent,
            charging: state == "charging" || state == "full" || state == "not charging",
            hasBattery: true)
    }

    /// A thermal state from the hottest Linux thermal zone, in millidegrees.
    /// The thresholds are a heuristic: there is no portable "serious" bit.
    public static func thermal(
        millidegrees: Double, serious: Double = 85_000, critical: Double = 95_000
    ) -> AwakeThermal {
        guard millidegrees.isFinite, millidegrees > 0 else { return .nominal }
        if millidegrees >= critical { return .critical }
        if millidegrees >= serious { return .serious }
        if millidegrees >= serious - 10_000 { return .fair }
        return .nominal
    }

    /// macOS `pmset -g therm`: `CPU_Speed_Limit` is 100 on a cool Mac and
    /// drops as the SMC throttles it, mapped onto the same four states.
    public static func thermal(speedLimitOutput output: String?) -> AwakeThermal {
        guard let raw = firstGroup(output ?? "", #"CPU_Speed_Limit\s*=\s*(\d+)"#),
            let limit = Int(raw)
        else { return .nominal }
        if limit >= 100 { return .nominal }
        if limit >= 75 { return .fair }
        if limit >= 50 { return .serious }
        return .critical
    }

    #if os(macOS)
        /// The thermal state from what macOS itself reports, for the app
        /// layer. macOS-only: Linux Foundation has no ThermalState, and the
        /// Linux port reads a thermal zone instead.
        public static func thermal(processState: ProcessInfo.ThermalState) -> AwakeThermal {
            switch processState {
            case .nominal: return .nominal
            case .fair: return .fair
            case .serious: return .serious
            case .critical: return .critical
            @unknown default: return .nominal
            }
        }
    #endif

    /// Is `hold` one of the two the contract knows?
    public static func isHold(_ hold: String) -> Bool { holds.contains(hold) }

    // MARK: Helpers

    static func finite(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, !Accounts.isJSONBool(n), n.doubleValue.isFinite
        else { return nil }
        return n.doubleValue
    }

    static func intOr(_ value: Any?, _ fallback: Int) -> Int {
        guard let n = value as? NSNumber, !Accounts.isJSONBool(n),
            n.doubleValue == Double(n.intValue)
        else { return fallback }
        return n.intValue
    }

    static func parseOwner(_ raw: Any?) -> AwakeOwner? {
        guard let obj = raw as? [String: Any] else { return nil }
        let pid = intOr(obj["pid"], 0)
        return AwakeOwner(
            pid: pid > 0 ? pid : 0, host: obj["host"] as? String ?? "",
            kind: obj["kind"] as? String ?? "")
    }

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }

    static func firstMatch(_ s: String, _ pattern: String) -> String? {
        guard let r = s.range(of: pattern, options: .regularExpression) else { return nil }
        return String(s[r])
    }

    static func firstGroup(_ s: String, _ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern),
            let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
            m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: s)
        else { return nil }
        return String(s[r])
    }
}
