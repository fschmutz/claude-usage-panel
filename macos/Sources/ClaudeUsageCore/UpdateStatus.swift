import Foundation

// Update status shared between the macOS Settings UI and anything else that
// needs to know whether this install is current. The single source of truth is
// `scripts/auto-update.sh --status --json` - the same script the daily timer
// runs - so the UI can never disagree with what the scheduler actually does.
//
// The point of surfacing `blockedReason`: auto-update deliberately refuses a
// dirty, diverged or detached checkout and only writes the reason to its log.
// Before this, that looked identical to "you are up to date" from the outside.

public struct UpdateStatus: Equatable {
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
    /// ISO-8601, or "never".
    public var lastCheck: String
    public var log: String

    public init(
        checkout: String, installed: String, latest: String, updateAvailable: Bool,
        blocked: Bool, blockedReason: String, lastCheck: String, log: String,
        checkoutVersion: String = "", clientsStale: Bool = false
    ) {
        self.checkout = checkout
        self.installed = installed
        self.checkoutVersion = checkoutVersion
        self.clientsStale = clientsStale
        self.latest = latest
        self.updateAvailable = updateAvailable
        self.blocked = blocked
        self.blockedReason = blockedReason
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
            clientsStale: o["clientsStale"] as? Bool ?? false
        )
    }

    /// One line for the Settings row and the dropdown.
    public var summary: String {
        if updateAvailable { return "Update available: \(installed) → \(latest)" }
        // Stale clients outrank a pause: the pause explains why the daily run
        // is idle, but the actionable fact is that the panel is running old code.
        if clientsStale {
            return "Installed \(installed), checkout \(checkoutVersion) - run ./install.sh update"
        }
        if blocked { return "Paused: \(blockedReason)" }
        if latest.isEmpty { return "\(installed) (could not reach the remote)" }
        return "Up to date (\(installed))"
    }

    /// Whether the user should be nudged - an available update, or a checkout
    /// auto-update has quietly stopped touching.
    public var needsAttention: Bool { updateAvailable || blocked || clientsStale }
}
