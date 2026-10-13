import Foundation

// Renaming a saved account. Mirrors the GNOME extension's lib/pure.js
// (renameRefusal, renameKey); tests/fixtures/accounts.json pins both.

/// Why a saved account cannot be renamed (see `Accounts.renameRefusal`).
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
}
