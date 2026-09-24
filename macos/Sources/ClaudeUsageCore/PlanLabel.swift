import Foundation

/// The plan the popup header shows, from the login's own credentials: the
/// usage endpoint names no plan. `subscriptionType` is the plan ("max" ->
/// "Max"), and a `rateLimitTier` ending in a multiplier
/// ("default_claude_max_20x") says which tier of it ("Max 20x"). Empty when
/// the login does not say. Mirrors the GNOME lib/pure/usage.js planLabel();
/// pinned by tests/fixtures/plan-label.json.
public enum PlanLabel {
    /// - Parameter oauth: the `claudeAiOauth` block of the credentials.
    public static func label(oauth: [String: Any]?) -> String {
        let type =
            (oauth?["subscriptionType"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        guard let first = type.first else { return "" }
        let plan = first.uppercased() + type.dropFirst()
        guard let tierField = oauth?["rateLimitTier"] as? String,
            let underscore = tierField.lastIndex(of: "_")
        else { return plan }
        let tier = tierField[tierField.index(after: underscore)...]
        let isMultiplier =
            tier.count >= 2 && tier.last == "x"
            && tier.dropLast().allSatisfy { $0.isASCII && $0.isNumber }
        return isMultiplier ? "\(plan) \(tier)" : plan
    }
}
