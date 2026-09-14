import ClaudeUsageCore
import Foundation

// Named accounts - the I/O half. Mirrors claude-code/accounts.js: the same
// store (one 0600 file per saved login under Application Support), the same
// switch order, the same refresh contract. The pure decisions (who is active,
// token state, auto-switch) live in ClaudeUsageCore/Accounts.swift.
//
// A login is two things: the credentials blob (the "Claude Code-credentials"
// login-Keychain item, or ~/.claude/.credentials.json when that file exists)
// and the `oauthAccount` block of ~/.claude.json. Switching swaps exactly
// those two and nothing else. Claude Code rotates its tokens as it runs, so
// the live login is written back into its own profile BEFORE anything is
// overwritten; an idle profile is refreshed with its refresh token when it is
// needed, and the result goes to OUR store only. The live login is Claude
// Code's to refresh.

struct SwitchResult: Sendable {
    let from: String?
    let to: String
    let changed: Bool
    let running: Int
    let email: String?
}

enum AccountError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let m) = self { return m }
        return nil
    }
}

enum AccountStore {
    static let tokenEndpoint = URL(string: "https://platform.claude.com/v1/oauth/token")!
    /// Claude Code's public OAuth client - the same id the CLI refreshes with.
    static let clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    /// Where Claude Code has kept its credentials item over time, newest name
    /// first. Read tries each; write updates the one that exists, else creates
    /// the first. The same list as the Node port's KEYCHAIN_SERVICES.
    static let keychainServices = ["Claude Code-credentials", "Claude Code", "claude"]
    private static let usageCacheFile = ".usage-cache.json"
    private static let lastSwitchFile = ".last-switch.json"

    // MARK: paths

    /// Same root as the usage warehouse, so every client reads one store.
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/claude-usage-panel/accounts")
    }

    private static var configDir: URL {
        if let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude")
    }

    static var credentialsURL: URL { configDir.appendingPathComponent(".credentials.json") }

    /// ~/.claude.json follows CLAUDE_CONFIG_DIR when that is set.
    static var claudeConfigURL: URL {
        if let dir = ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir).appendingPathComponent(".claude.json")
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
            ".claude.json")
    }

    private static func profileURL(_ name: String) -> URL {
        directory.appendingPathComponent("\(name).json")
    }

    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private static func stamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    // MARK: private, atomic files

    // Atomic, private write: a tmp file in the same dir CREATED 0600 (never a
    // world-readable instant), then moved over the target.
    private static func writePrivate(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try fm.createDirectory(
            at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let tmp = dir.appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
        guard
            fm.createFile(
                atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
        else { throw AccountError.message("could not write \(url.path)") }
        if fm.fileExists(atPath: url.path) {
            _ = try fm.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: url)
        }
    }

    private static func readJSON(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func pretty(_ obj: Any) throws -> Data {
        var data = try JSONSerialization.data(
            withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])
        data.append(0x0a)
        return data
    }

    // MARK: store

    /// Every valid profile, in code-point name order. Unreadable files skip.
    static func list() -> [AccountProfile] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
        else { return [] }
        var out: [AccountProfile] = []
        for file in names where file.hasSuffix(".json") && !file.hasPrefix(".") {
            guard let p = AccountProfile.parse(readJSON(directory.appendingPathComponent(file))),
                "\(p.name).json" == file
            else { continue }
            out.append(p)
        }
        return Accounts.sortedByName(out)
    }

    static func read(_ name: String) -> AccountProfile? {
        guard Accounts.isValidName(name),
            let p = AccountProfile.parse(readJSON(profileURL(name))), p.name == name
        else { return nil }
        return p
    }

    @discardableResult
    static func write(_ profile: AccountProfile) throws -> AccountProfile {
        try writePrivate(pretty(profile.toJSON()), to: profileURL(profile.name))
        return profile
    }

    static func remove(_ name: String) throws {
        guard read(name) != nil else {
            throw AccountError.message("no saved account named \(name)")
        }
        try FileManager.default.removeItem(at: profileURL(name))
    }

    // MARK: the live login

    private static func parseCredentials(_ data: Data) -> [String: Any]? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let oauth = json["claudeAiOauth"] as? [String: Any],
            oauth["accessToken"] is String
        else { return nil }
        return json
    }

    private static func security(_ args: [String]) -> Shell.Result {
        Shell.run("/usr/bin/security", args)
    }

    /// The Keychain item Claude Code uses on this Mac: its service name and
    /// the account attribute it was stored under (the login user's name, but
    /// reuse whatever Claude Code wrote so the item we update is the one it
    /// reads). Nil when no item exists under any known name.
    private static func keychainItem() -> (service: String, account: String)? {
        let acct = try? NSRegularExpression(pattern: #""acct"<blob>="([^"]*)""#)
        for service in keychainServices {
            let r = security(["find-generic-password", "-s", service])
            guard r.ok else { continue }
            let range = NSRange(r.out.startIndex..., in: r.out)
            if let m = acct?.firstMatch(in: r.out, range: range),
                let g = Range(m.range(at: 1), in: r.out)
            {
                return (service, String(r.out[g]))
            }
            return (service, NSUserName())
        }
        return nil
    }

    /// The credentials Claude Code holds now (file, else the login Keychain).
    static func readLiveCredentials() -> [String: Any]? {
        if let data = try? Data(contentsOf: credentialsURL), let creds = parseCredentials(data) {
            return creds
        }
        guard let item = keychainItem() else { return nil }
        let r = security(["find-generic-password", "-s", item.service, "-w"])
        guard r.ok else { return nil }
        return parseCredentials(Data(r.out.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
    }

    private static func writeLiveCredentials(_ credentials: [String: Any], encoded data: Data)
        throws
    {
        if FileManager.default.fileExists(atPath: credentialsURL.path) {
            try writePrivate(data, to: credentialsURL)
            return
        }
        // -U updates the existing item in place, so Claude Code's ACL on it stays.
        let item = keychainItem() ?? (keychainServices[0], NSUserName())
        let r = security([
            "add-generic-password", "-U", "-a", item.account, "-s", item.service,
            "-w", String(decoding: data, as: UTF8.self),
        ])
        guard r.ok else {
            throw AccountError.message(
                "could not write the Keychain item (security exit \(r.status))")
        }
    }

    /// The `oauthAccount` block of ~/.claude.json, or nil.
    static func readLiveAccount() -> [String: Any]? {
        (readJSON(claudeConfigURL) as? [String: Any])?["oauthAccount"] as? [String: Any]
    }

    /// ~/.claude.json with `oauthAccount` replaced - read and validated BEFORE
    /// anything is written, so a switch cannot fail between its two writes.
    private static func configWithAccount(_ account: [String: Any]) throws -> [String: Any] {
        var cfg: [String: Any] = [:]
        if let existing = readJSON(claudeConfigURL) {
            guard let dict = existing as? [String: Any] else {
                throw AccountError.message("\(claudeConfigURL.path) is not a JSON object")
            }
            cfg = dict
        }
        cfg["oauthAccount"] = account
        return cfg
    }

    /// The saved name of the live login, or nil when it was never saved.
    static func liveAccountName() -> String? {
        Accounts.activeName(profiles: list(), live: readLiveAccount())
    }

    private static func sameJSON(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        guard let da = try? JSONSerialization.data(withJSONObject: a, options: [.sortedKeys]),
            let db = try? JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
        else { return false }
        return da == db
    }

    /// Write the live login back into its own profile, so the tokens Claude
    /// Code rotated since the last switch are the ones we keep.
    @discardableResult
    static func syncBack() throws -> String? {
        guard let creds = readLiveCredentials(), let account = readLiveAccount(),
            let name = Accounts.activeName(profiles: list(), live: account)
        else { return nil }
        if let stored = read(name), sameJSON(stored.credentials, creds),
            sameJSON(stored.account, account)
        {
            return name
        }
        try write(
            AccountProfile(name: name, savedAt: stamp(), account: account, credentials: creds))
        return name
    }

    /// Save the live login as `name`. Refuses to shadow another account's
    /// name or to save one account twice, unless `force`.
    @discardableResult
    static func saveCurrent(_ name: String, force: Bool = false) throws -> AccountProfile {
        guard Accounts.isValidName(name) else {
            throw AccountError.message(
                "invalid name \"\(name)\": letters, digits, . _ - only, up to 32 characters")
        }
        guard let creds = readLiveCredentials() else {
            throw AccountError.message(
                "no Claude Code login to save - run `claude auth login` first")
        }
        let account = readLiveAccount() ?? [:]
        let profiles = list()
        if let existing = profiles.first(where: { $0.name == name }), !force,
            let liveUuid = account["accountUuid"] as? String,
            let storedUuid = existing.accountUuid, storedUuid != liveUuid
        {
            throw AccountError.message(
                "\(name) is already \(existing.email ?? "another account") - pick another name or force"
            )
        }
        let others = profiles.filter { $0.name != name }
        if let twin = Accounts.activeName(profiles: others, live: account), !force {
            throw AccountError.message(
                "this login is already saved as \(twin) - remove it first or force")
        }
        return try write(
            AccountProfile(name: name, savedAt: stamp(), account: account, credentials: creds))
    }

    /// A live login that was never saved must not be lost by a switch: park it
    /// under a name derived from its email ("admin", then "admin-2" ...).
    private static func parkUnsavedLogin() throws -> String? {
        guard let creds = readLiveCredentials(), let account = readLiveAccount() else { return nil }
        let taken = Set(list().map(\.name))
        let local = (account["emailAddress"] as? String ?? "account").split(separator: "@").first
        var base = String(local ?? "account").unicodeScalars.map { scalar -> Character in
            let ok =
                CharacterSet.alphanumerics.contains(scalar) || "._-".unicodeScalars.contains(scalar)
            return ok && scalar.isASCII ? Character(scalar) : "-"
        }
        while let first = base.first, first == "." || first == "-" { base.removeFirst() }
        var name = String(base.prefix(28))
        if name.isEmpty { name = "account" }
        let root = name
        var n = 2
        while taken.contains(name) {
            name = "\(root)-\(n)"
            n += 1
        }
        return try write(
            AccountProfile(name: name, savedAt: stamp(), account: account, credentials: creds)
        ).name
    }

    /// Claude Code processes alive right now - they keep the old token.
    static func runningClaudeCount() -> Int {
        Shell.run("/bin/ps", ["-eo", "args="]).out.split(separator: "\n").filter {
            $0.trimmingCharacters(in: .whitespaces)
                .range(of: #"(^|/)claude(\s|$)"#, options: .regularExpression) != nil
        }.count
    }

    // MARK: token refresh (our store only)

    /// Exchange the profile's refresh token for a new access token and store
    /// the result. Never touches the live login.
    static func refresh(_ profile: AccountProfile) async throws -> AccountProfile {
        guard let refreshToken = profile.refreshToken else {
            throw AccountError.message(
                "\(profile.name): no refresh token - log in again and save it")
        }
        var req = URLRequest(url: tokenEndpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": clientId,
        ])
        req.timeoutInterval = 10
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw AccountError.message(
                "\(profile.name): token refresh failed - \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let hint = (status == 400 || status == 401) ? " - log in again and save it" : ""
            throw AccountError.message(
                "\(profile.name): token refresh rejected (HTTP \(status))\(hint)")
        }
        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let access = body["access_token"] as? String, !access.isEmpty
        else {
            throw AccountError.message("\(profile.name): token refresh returned no access token")
        }
        var oauth = profile.oauth
        oauth["accessToken"] = access
        if let expiresIn = (body["expires_in"] as? NSNumber)?.doubleValue {
            oauth["expiresAt"] = nowMs() + expiresIn * 1000
        }
        if let rotated = body["refresh_token"] as? String, !rotated.isEmpty {
            oauth["refreshToken"] = rotated
        }
        if let scope = body["scope"] as? String {
            oauth["scopes"] = scope.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        }
        var credentials = profile.credentials
        credentials["claudeAiOauth"] = oauth
        return try write(profile.with(credentials: credentials, savedAt: stamp()))
    }

    /// A usable access token for a saved account: the live one when that
    /// account is the active login (Claude Code keeps it fresh), else the
    /// stored one, refreshed first when stale.
    static func accessTokenFor(_ name: String) async throws -> String {
        guard let profile = read(name) else {
            throw AccountError.message("no saved account named \(name)")
        }
        if liveAccountName() == name, let live = readLiveCredentials(),
            let token = (live["claudeAiOauth"] as? [String: Any])?["accessToken"] as? String
        {
            return token
        }
        switch profile.tokenState(nowMs: nowMs()) {
        case .valid: return profile.accessToken
        case .stale: return try await refresh(profile).accessToken
        case .expired:
            throw AccountError.message(
                "\(name): login expired - run `claude auth login` on it and save it again")
        }
    }

    // MARK: switch

    /// Make `name` the live login. Order matters: the live login is synced
    /// back (or parked under a new name if it was never saved) BEFORE anything
    /// is overwritten; the target is refreshed and the config validated BEFORE
    /// anything is installed, so a failure leaves the current login untouched;
    /// and the account block goes in BEFORE the credentials - if the second
    /// write still failed, the live pair would name the old account with its
    /// old tokens, which a later syncBack leaves alone.
    static func switchTo(_ name: String) async throws -> SwitchResult {
        guard var target = read(name) else {
            throw AccountError.message("no saved account named \(name)")
        }
        let from = try syncBack() ?? parkUnsavedLogin()
        if from == name {
            return SwitchResult(
                from: from, to: name, changed: false, running: runningClaudeCount(),
                email: target.email)
        }
        switch target.tokenState(nowMs: nowMs()) {
        case .expired:
            throw AccountError.message(
                "\(name): login expired - run `claude auth login` on it and save it again")
        case .stale: target = try await refresh(target)
        case .valid: break
        }
        let config = try configWithAccount(target.account)
        let credentials = try JSONSerialization.data(withJSONObject: target.credentials)
        try writePrivate(pretty(config), to: claudeConfigURL)
        try writeLiveCredentials(target.credentials, encoded: credentials)
        writeLastSwitch(from: from, to: name)
        return SwitchResult(
            from: from, to: name, changed: true, running: runningClaudeCount(), email: target.email)
    }

    // MARK: last switch (the auto-switch cooldown, shared by every client)

    // Store state, not process state: a switch made by the CLI, the MCP tool
    // or the other panel counts against the cooldown too. Same file and shape
    // as the node ports.
    static var lastSwitchURL: URL { directory.appendingPathComponent(lastSwitchFile) }

    private static func writeLastSwitch(from: String?, to: String) {
        let obj: [String: Any] = ["at": nowMs(), "from": from as Any? ?? NSNull(), "to": to]
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? writePrivate(data, to: lastSwitchURL)
    }

    /// When the last switch happened (any client), or nil if never.
    static func readLastSwitchMs() -> Double? {
        ((readJSON(lastSwitchURL) as? [String: Any])?["at"] as? NSNumber)?.doubleValue
    }

    // MARK: per-account usage

    /// Normalized usage for one saved account.
    static func usageFor(_ name: String) async throws -> [LimitCard] {
        let token = try await accessTokenFor(name)
        return try await ClaudeUsage.fetch(token: token).cards
    }

    // The panels drop the latest per-account worst limit here so the status
    // line (no network, no credentials) can hint at a freer account. Same file
    // and shape as the node ports.
    static var usageCacheURL: URL { directory.appendingPathComponent(usageCacheFile) }

    static func writeUsageCache(_ usage: [String: [LimitCard]]) {
        var accounts: [String: Any] = [:]
        for (name, cards) in usage {
            accounts[name] = [
                "worst": Accounts.worstPercent(cards) as Any? ?? NSNull(),
                "session": cards.first { $0.id == "session" }?.percent as Any? ?? NSNull(),
                "weekly": cards.first { $0.id == "weekly_all" }?.percent as Any? ?? NSNull(),
            ]
        }
        let obj: [String: Any] = ["at": nowMs(), "accounts": accounts]
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? writePrivate(data, to: usageCacheURL)
    }
}
