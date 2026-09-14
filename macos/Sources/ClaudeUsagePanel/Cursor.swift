import ClaudeUsageCore
import Foundation

// Optional Cursor layer: query the Cursor Admin API for team spend.
// Auth is HTTP Basic with the admin API key as the username (empty password).
// Pure spend math lives in ClaudeUsageCore (CursorMath, unit-tested).

enum CursorAPI {
    private static let base = "https://api.cursor.com"

    private static func basicAuth(_ key: String) -> String {
        "Basic " + Data("\(key):".utf8).base64EncodedString()
    }

    private static func post(_ path: String, key: String, body: [String: Any]) async throws
        -> [String: Any]
    {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = "POST"
        req.setValue(basicAuth(key), forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 25

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 403 {
            throw NSError(
                domain: "Cursor", code: status,
                userInfo: [NSLocalizedDescriptionKey: "API key rejected"])
        }
        guard (200..<300).contains(status) else {
            throw NSError(
                domain: "Cursor", code: status,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \(status)"])
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private static func startOfTodayMs() -> Int {
        let cal = Calendar.current
        let midnight = cal.startOfDay(for: Date())
        return Int(midnight.timeIntervalSince1970 * 1000)
    }

    static func fetch(key: String) async throws -> CursorSummary {
        let spend = try await post("/teams/spend", key: key, body: ["page": 1, "pageSize": 100])
        let rows =
            (spend["teamMemberSpend"] as? [[String: Any]])
            ?? (spend["spend"] as? [[String: Any]]) ?? []

        var todayUSD: Double?
        do {
            let ev = try await post(
                "/teams/filtered-usage-events", key: key,
                body: [
                    "startDate": startOfTodayMs(),
                    "endDate": Int(Date().timeIntervalSince1970 * 1000),
                    "page": 1, "pageSize": 100,
                ])
            let events =
                (ev["usageEvents"] as? [[String: Any]])
                ?? (ev["events"] as? [[String: Any]]) ?? []
            todayUSD = CursorMath.summarizeToday(events)
        } catch {
            todayUSD = nil
        }

        return CursorMath.summarizeSpend(rows, todayUSD: todayUSD)
    }
}
