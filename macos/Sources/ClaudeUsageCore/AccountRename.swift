import Foundation

// Renaming a saved account. Mirrors the GNOME extension's lib/pure.js
// (renameRefusal, renameKey, parseRenamePending, renameHides,
// renameBlocksSnapshot, renameRecovery); tests/fixtures/accounts.json pins them.

/// Why a saved account cannot be renamed (see `Accounts.renameRefusal`).
/// `.rename-pending.json`: a rename journaled before its first file moved.
public struct RenamePending: Equatable, Sendable {
    public let at: Double
    public let from: String
    public let to: String

    public init(at: Double, from: String, to: String) {
        self.at = at
        self.from = from
        self.to = to
    }
}

/// What to do with a rename journal left on disk (see `Accounts.renameRecovery`).
public struct RenameRecovery: Equatable, Sendable {
    public enum Action: String, Sendable { case drop, wait, finish, rollback }
    public let action: Action
    public let removeFrom: Bool
    public let moveBack: Bool

    public init(action: Action, removeFrom: Bool = false, moveBack: Bool = false) {
        self.action = action
        self.removeFrom = removeFrom
        self.moveBack = moveBack
    }
}

public struct RenameRefusal: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case invalid, missing, pending, taken
    }
    public let kind: Kind
    /// The profile the refusal is about: the missing name, the pending
    /// switch's target, or the profile that holds the name.
    public let profile: String?
    public let email: String?

    public init(kind: Kind, profile: String?, email: String?) {
        self.kind = kind
        self.profile = profile
        self.email = email
    }
}

extension Accounts {
    /// Why saved account `from` cannot be renamed `to` right now, or nil when
    /// it can: `invalid`, `missing`, `pending` (an unfinished switch, by its
    /// target), then `taken` (another profile holds `to`, ignoring case - a
    /// change of case on `from` itself is allowed). The same name is nil.
    public static func renameRefusal(
        profiles: [AccountProfile], from: String, to: String, pendingTo: String?
    ) -> RenameRefusal? {
        guard isValidName(to) else {
            return RenameRefusal(kind: .invalid, profile: nil, email: nil)
        }
        guard profiles.contains(where: { $0.name == from }) else {
            return RenameRefusal(kind: .missing, profile: from, email: nil)
        }
        if let pendingTo { return RenameRefusal(kind: .pending, profile: pendingTo, email: nil) }
        guard let taken = profiles.first(where: { $0.name != from && sameName($0.name, to) })
        else { return nil }
        return RenameRefusal(kind: .taken, profile: taken.name, email: taken.email)
    }

    /// A name-keyed store map ({NAME: value}) with `from`'s entry moved to
    /// `to`. Anything that is not a JSON object is an empty map.
    public static func renameKey(_ map: Any?, from: String, to: String) -> [String: Any] {
        var out = map as? [String: Any] ?? [:]
        if from != to, let value = out.removeValue(forKey: from) { out[to] = value }
        return out
    }

    /// A journal younger than this may still be in flight in another process:
    /// the age the refresh lock it runs under goes stale at.
    public static let renameStaleMs: Double = RefreshLock.staleMs

    /// The journal as {at, from, to}, or nil when it is unusable.
    public static func parseRenamePending(_ raw: Any?) -> RenamePending? {
        guard let o = raw as? [String: Any], let n = o["at"] as? NSNumber, !isJSONBool(n),
            n.doubleValue.isFinite, let from = o["from"] as? String, let to = o["to"] as? String,
            isValidName(from), isValidName(to), from != to
        else { return nil }
        return RenamePending(at: n.doubleValue, from: from, to: to)
    }

    /// The name a listing hides while a rename stands: `from`, once `to` is on
    /// disk beside it. Never on a change of case.
    public static func renameHides(names: [String], pending: RenamePending?) -> String? {
        guard let p = pending, !sameName(p.from, p.to), names.contains(p.from), names.contains(p.to)
        else { return nil }
        return p.from
    }

    /// No sync-back may write either name of a standing rename.
    public static func renameBlocksSnapshot(pending: RenamePending?, name: String?) -> Bool {
        guard let p = pending, let name else { return false }
        return sameName(name, p.from) || sameName(name, p.to)
    }

    /// Wait while fresh; then finish what was written (`removeFrom` when the
    /// old file still stands) or undo what was not (`moveBack` for a change of
    /// case whose file was already renamed). `atFrom` / `atTo`: the `name` in
    /// the file at each path, nil when absent or unreadable.
    public static func renameRecovery(
        pending: RenamePending?, atFrom: String?, atTo: String?, nowMs: Double
    ) -> RenameRecovery {
        guard let p = pending else { return RenameRecovery(action: .drop) }
        if nowMs - p.at < renameStaleMs { return RenameRecovery(action: .wait) }
        let caseOnly = sameName(p.from, p.to)
        if atTo == p.to {
            return RenameRecovery(action: .finish, removeFrom: !caseOnly && atFrom == p.from)
        }
        return RenameRecovery(action: .rollback, moveBack: caseOnly && atTo == p.from)
    }
}
