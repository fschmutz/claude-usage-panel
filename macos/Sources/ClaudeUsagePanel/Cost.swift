import Foundation

// Optional cost layer: the official usage API does not expose dollar cost on
// subscription plans, so we shell out to `ccusage` (computed from the local
// ~/.claude/projects/*.jsonl logs). Mirrors the GNOME extension's lib/cost.js.

struct ActiveCost {
    let costUSD: Double
    let tokens: Int
}

enum Cost {
    /// Run `ccusage blocks --active --json`. Tries a global `ccusage` first,
    /// then falls back to `npx`. Returns nil if unavailable.
    static func fetchActiveCost() async -> ActiveCost? {
        let candidates: [[String]] = [
            ["ccusage", "blocks", "--active", "--json"],
            ["npx", "-y", "ccusage@latest", "blocks", "--active", "--json"],
        ]
        for argv in candidates {
            if let cost = run(argv) { return cost }
        }
        return nil
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
