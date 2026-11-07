import Foundation

// The live login as Claude Code writes it, read the one way every port does.
// Mirrors lib/pure/accounts.js parseCredentials / countClaudeProcesses, pinned
// by tests/fixtures/accounts.json (`credentials`, `claudeProcesses`).

extension Accounts {
    /// The credentials blob as every store keeps it, `{claudeAiOauth:
    /// {accessToken, …}}`, from the parsed JSON Claude Code wrote (the file or
    /// the Keychain item). The current nested form is kept as is; the older
    /// flat `access_token` / `token` forms are lifted into it. Nil when there is
    /// no non-empty string access token.
    public static func parseCredentials(_ json: Any?) -> [String: Any]? {
        guard let root = json as? [String: Any] else { return nil }
        let nested = root["claudeAiOauth"] as? [String: Any]
        let oauth = nested ?? root
        let token = firstPresent(oauth, ["accessToken", "access_token", "token"])
        guard let text = token as? String, !text.isEmpty else { return nil }
        if nested != nil, oauth["accessToken"] as? String == text { return root }
        var lifted = oauth
        lifted.removeValue(forKey: "access_token")
        lifted.removeValue(forKey: "token")
        lifted["accessToken"] = text
        return ["claudeAiOauth": lifted]
    }

    /// `??` over keys, like the JS port: the first key that is present and
    /// not JSON null decides, whatever its type.
    private static func firstPresent(_ dict: [String: Any], _ keys: [String]) -> Any? {
        for key in keys {
            if let value = dict[key], !(value is NSNull) { return value }
        }
        return nil
    }

    /// Claude Code processes in a `ps -eo args=` listing: a `claude` binary or
    /// wrapper, or node running the npm package's cli.js. They keep the old
    /// token after a switch.
    public static func countClaudeProcesses(_ ps: String) -> Int {
        let pattern =
            #"(^|/)claude(\s|$)|(^|[\s/])@anthropic-ai/claude-code/cli\.m?js(\s|$)"#
        return ps.split(separator: "\n", omittingEmptySubsequences: false).filter {
            $0.trimmingCharacters(in: .whitespaces)
                .range(of: pattern, options: .regularExpression) != nil
        }.count
    }
}
