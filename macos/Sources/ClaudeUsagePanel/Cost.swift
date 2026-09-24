import Foundation

// Optional cost layer: the official usage API does not expose dollar cost on
// subscription plans, so we shell out to `ccusage` (computed from the local
// ~/.claude/projects/*.jsonl logs). Mirrors the GNOME extension's lib/cost.js.
// Only an installed `ccusage` runs: no `npx ccusage@latest` fallback, which
// fetched and ran the newest unpinned npm release on every poll.

struct ActiveCost {
    let costUSD: Double
    let tokens: Int
}

enum Cost {
    static let argv = ["ccusage", "blocks", "--active", "--json"]

    /// Run `ccusage blocks --active --json`. Returns nil if unavailable.
    static func fetchActiveCost() async -> ActiveCost? {
        run(argv)
    }

    private static func run(_ argv: [String]) -> ActiveCost? {
        let r = Shell.run("/usr/bin/env", argv, env: Shell.toolEnvironment)
        guard r.ok,
            let json = try? JSONSerialization.jsonObject(with: Data(r.out.utf8)) as? [String: Any],
            let blocks = json["blocks"] as? [[String: Any]],
            let first = blocks.first
        else { return nil }
        return ActiveCost(
            costUSD: (first["costUSD"] as? NSNumber)?.doubleValue ?? 0,
            tokens: (first["totalTokens"] as? NSNumber)?.intValue ?? 0)
    }
}
