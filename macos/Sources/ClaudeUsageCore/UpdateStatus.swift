import Foundation

// Update status shared between the macOS Settings UI and anything else that
// needs to know whether this install is current. The single source of truth is
// `scripts/auto-update.sh --status --json` - the same script the daily timer
// runs - so the UI can never disagree with what the scheduler actually does.
//
// The point of surfacing `blockedReason`: auto-update deliberately refuses a
// dirty, diverged or detached checkout and only writes the reason to its log.
// Before this, that looked identical to "you are up to date" from the outside.

public struct UpdateStatus: Equatable, Sendable {
    public var checkout: String
    public var installed: String
    public var latest: String
    /// Version of the checkout, which drifts ahead of `installed` after a
    /// manual `git pull` that was never followed by a reinstall.
    public var checkoutVersion: String
    public var updateAvailable: Bool
    /// The code is present but was never installed - `./install.sh update`.
    public var clientsStale: Bool
    /// True when auto-update would decline to act on this checkout.
    public var blocked: Bool
    /// Why it would decline - empty when not blocked.
    public var blockedReason: String
    /// Why the remote lookup found no release - empty when it did. An auth,
    /// DNS or URL failure is not "offline", and reporting every one of them as
    /// "could not reach the remote" hid a permanently broken remote for weeks.
    public var remoteError: String
    /// What the running GNOME Shell loaded. Always empty on macOS, where the
    /// app is replaced and relaunched by the installer.
    public var loadedVersion: String
    /// Installed, but the running process is older - log out and back in.
    public var reloadNeeded: Bool
    /// ISO-8601, or "never".
    public var lastCheck: String
    public var log: String

    public init(
        checkout: String, installed: String, latest: String, updateAvailable: Bool,
        blocked: Bool, blockedReason: String, lastCheck: String, log: String,
        checkoutVersion: String = "", clientsStale: Bool = false,
        remoteError: String = "", loadedVersion: String = "", reloadNeeded: Bool = false
    ) {
        self.checkout = checkout
        self.installed = installed
        self.checkoutVersion = checkoutVersion
        self.clientsStale = clientsStale
        self.latest = latest
        self.updateAvailable = updateAvailable
        self.blocked = blocked
        self.blockedReason = blockedReason
        self.remoteError = remoteError
        self.loadedVersion = loadedVersion
        self.reloadNeeded = reloadNeeded
        self.lastCheck = lastCheck
        self.log = log
    }

    public static func parse(json: Data) -> UpdateStatus? {
        guard let o = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
            return nil
        }
        // installed is the one field with no sensible default: without it there
        // is nothing to report and the caller should show an error instead.
        guard let installed = o["installed"] as? String, !installed.isEmpty else { return nil }
        return UpdateStatus(
            checkout: o["checkout"] as? String ?? "",
            installed: installed,
            latest: o["latest"] as? String ?? "",
            updateAvailable: o["updateAvailable"] as? Bool ?? false,
            blocked: o["blocked"] as? Bool ?? false,
            blockedReason: o["blockedReason"] as? String ?? "",
            lastCheck: o["lastCheck"] as? String ?? "never",
            log: o["log"] as? String ?? "",
            checkoutVersion: o["checkout_version"] as? String ?? "",
            clientsStale: o["clientsStale"] as? Bool ?? false,
            remoteError: o["remoteError"] as? String ?? "",
            loadedVersion: o["loadedVersion"] as? String ?? "",
            reloadNeeded: o["reloadNeeded"] as? Bool ?? false
        )
    }

    /// The update script behind `link` (the fixed link install.sh writes), or
    /// nil when it may not be run. The link and everything it leads to must
    /// belong to `uid` and be writable by nobody else: the link itself, the
    /// script (named auto-update.sh, a regular executable file), its scripts/
    /// directory and the checkout root above it. A link to a checkout another
    /// account controls is refused, not run.
    public static func trustedScript(link: String, uid: UInt32 = UInt32(getuid())) -> String? {
        let fm = FileManager.default
        func owned(_ path: String, _ type: FileAttributeType) -> Bool {
            guard let a = try? fm.attributesOfItem(atPath: path),
                a[.type] as? FileAttributeType == type,
                (a[.ownerAccountID] as? NSNumber)?.uint32Value == uid,
                let mode = (a[.posixPermissions] as? NSNumber)?.uint16Value
            else { return false }
            return type == .typeSymbolicLink || mode & 0o022 == 0
        }
        guard owned(link, .typeSymbolicLink) else { return nil }
        let file = URL(fileURLWithPath: link).resolvingSymlinksInPath()
        let dir = file.deletingLastPathComponent()
        let root = dir.deletingLastPathComponent()
        guard file.lastPathComponent == "auto-update.sh",
            owned(file.path, .typeRegular), fm.isExecutableFile(atPath: file.path),
            owned(dir.path, .typeDirectory), owned(root.path, .typeDirectory)
        else { return nil }
        return file.path
    }

    /// Dotted-version ordering, the rule version_compare() uses in
    /// scripts/auto-update.sh: numeric per component, a leading "v" and any
    /// -prerelease suffix ignored, a missing component read as 0.
    public static func compare(_ a: String, _ b: String) -> Int {
        func parts(_ v: String) -> [Int] {
            let core = v.hasPrefix("v") ? String(v.dropFirst()) : v
            let released = core.split(whereSeparator: { $0 == "-" || $0 == "+" }).first ?? ""
            let n = released.split(separator: ".").map { Int($0.filter(\.isNumber)) ?? 0 }
            return (0..<3).map { $0 < n.count ? n[$0] : 0 }
        }
        let (x, y) = (parts(a), parts(b))
        for i in 0..<3 where x[i] != y[i] { return x[i] < y[i] ? -1 : 1 }
        return 0
    }

    public static func isOlder(_ a: String, than b: String) -> Bool { compare(a, b) < 0 }

    /// One line for the Settings row and the dropdown.
    public var summary: String {
        if updateAvailable { return "Update available: \(installed) → \(latest)" }
        // Stale clients outrank a pause: the pause explains why the daily run
        // is idle, but the actionable fact is that the panel is running old code.
        if clientsStale {
            return "Installed \(installed), checkout \(checkoutVersion) - reinstall the clients"
        }
        if reloadNeeded {
            return "Installed \(installed), running \(loadedVersion) - log out and back in"
        }
        if blocked { return "Paused: \(blockedReason)" }
        if latest.isEmpty {
            return remoteError.isEmpty
                ? "\(installed) (could not reach the remote)" : "\(installed) - \(remoteError)"
        }
        return "Up to date (\(installed))"
    }

    /// Whether the user should be nudged - an available update, or a checkout
    /// auto-update has quietly stopped touching.
    public var needsAttention: Bool {
        updateAvailable || blocked || clientsStale || reloadNeeded
    }
}
