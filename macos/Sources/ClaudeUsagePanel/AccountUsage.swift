import ClaudeUsageCore
import Foundation

// Named accounts, the token and usage half of AccountStore: exchange a stored
// login's refresh token, pick the token a saved account's usage is read with,
// fetch that usage, and keep the status line's usage cache. Mirrors
// claude-code/accounts-usage.js; the store half is AccountStore.swift.
//
// Two rules decide everything below:
//   - A saved name that resolves to the live login is NEVER refreshed. Its
//     refresh token is the one Claude Code holds; spending it here would
//     rotate Claude Code's login, and the next syncBack would write the spent
//     token back over the live one. When the live token cannot be read (a
//     locked Keychain, a credentials file caught mid-rewrite) the answer is
//     `no_token`, never a refresh of the stored copy.
//   - A refresh token is single-use, and several processes poll one store.
//     The exchange runs under the per-profile lock file every port uses
//     (Accounts.RefreshLock), re-reads the profile once it holds it, and never
//     spends a token another process has already spent (refreshRaced).

/// What one saved account's usage came back as. Never a thrown error: a row
/// for an account that cannot be read is still a row, and the code is what
/// decides whether that row says "login expired", "refresh failed" or just
/// "no reading right now" (Notices.health). `live` says the token used was
/// the live login's, whose refusal is Claude Code's to refresh.
struct AccountUsage: Sendable {
    let cards: [LimitCard]?
    let errorCode: String?
    let message: String?
    var live = false

    static let unread = AccountUsage(cards: nil, errorCode: nil, message: nil)
}

extension AccountStore {
    /// Never the shared session: the exchange carries a refresh token in and
    /// its replacement back out, and URLSession.shared caches on disk.
    private static let refreshSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 10
        return URLSession(configuration: config)
    }()

    // MARK: the refresh lock

    /// O_EXCL create, 0600. The lock carries a random id so a holder only
    /// ever removes its own lock, never one a waiter took over after it went
    /// stale.
    private static func acquireRefreshLock(_ name: String) async throws -> (url: URL, id: String) {
        let url = directory.appendingPathComponent(Accounts.refreshLockFile(name))
        let id = UUID().uuidString
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let start = Date()
        while true {
            let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            if fd >= 0 {
                let bytes = Array(id.utf8)
                _ = bytes.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
                close(fd)
                return (url, id)
            }
            guard errno == EEXIST else {
                throw AccountError.message("could not lock \(name) for its token refresh")
            }
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
            // Released between the two calls: try again at once.
            guard let modified = attributes?[.modificationDate] as? Date else { continue }
            if Date().timeIntervalSince(modified) * 1000 > Accounts.RefreshLock.staleMs {
                try? FileManager.default.removeItem(at: url)  // a crashed holder
                continue
            }
            if Date().timeIntervalSince(start) * 1000 > Accounts.RefreshLock.waitMs {
                throw AccountError.coded(
                    code: "transient",
                    message: "\(name): another refresh of this login is still running - try again")
            }
            try await Task.sleep(nanoseconds: UInt64(Accounts.RefreshLock.pollMs) * 1_000_000)
        }
    }

    private static func releaseRefreshLock(_ lock: (url: URL, id: String)) {
        guard let text = try? String(contentsOf: lock.url, encoding: .utf8), text == lock.id
        else { return }
        try? FileManager.default.removeItem(at: lock.url)
    }

    // MARK: token refresh (our store only)

    /// The token exchange itself: the new OAuth block, or a coded throw.
    private static func exchange(_ profile: AccountProfile, refreshToken: String) async throws
        -> [String: Any]
    {
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
            (data, response) = try await Self.refreshSession.data(for: req)
        } catch {
            throw AccountError.coded(
                code: "network_error",
                message: "\(profile.name): token refresh failed - \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let code = Accounts.refreshFailureCode(status)
            let hint = code == "refresh_failed" ? " - log in again and save it" : ""
            throw AccountError.coded(
                code: code,
                message: "\(profile.name): token refresh rejected (HTTP \(status))\(hint)")
        }
        guard
            let oauth = Accounts.refreshedOauth(
                profile.oauth, body: try? JSONSerialization.jsonObject(with: data), nowMs: nowMs())
        else {
            throw AccountError.coded(
                code: "refresh_failed",
                message: "\(profile.name): token refresh returned no access token")
        }
        return oauth
    }

    /// Exchange the profile's refresh token for a new access token and store
    /// the result, under the profile's refresh lock. When another process
    /// refreshed it first, the stored result is returned and no token is
    /// spent. Never touches the live login.
    static func refresh(_ profile: AccountProfile) async throws -> AccountProfile {
        guard let refreshToken = profile.refreshToken else {
            throw AccountError.coded(
                code: "login_expired",
                message: "\(profile.name): no refresh token - log in again and save it")
        }
        let lock = try await acquireRefreshLock(profile.name)
        defer { releaseRefreshLock(lock) }
        guard let current = read(profile.name) else {
            throw AccountError.coded(
                code: "no_account", message: "no saved account named \(profile.name)")
        }
        if Accounts.refreshRaced(sent: profile.oauth, stored: current.oauth) { return current }
        let oauth: [String: Any]
        do {
            oauth = try await exchange(profile, refreshToken: refreshToken)
        } catch let error as AccountError where error.code == "refresh_failed" {
            // A writer that took no lock may have spent it: a spent token
            // whose replacement is on disk is fine.
            if let again = read(profile.name),
                Accounts.refreshRaced(sent: profile.oauth, stored: again.oauth)
            {
                return again
            }
            throw error
        }
        var credentials = current.credentials
        credentials["claudeAiOauth"] = oauth
        return try write(current.with(credentials: credentials, savedAt: stamp()))
    }

    /// Where a saved account's access token came from. `live` means Claude
    /// Code's own credentials, which this app never writes; the other two come
    /// out of OUR store, and a refresh writes only there.
    enum TokenSource { case live, store, refreshed }

    /// A usable access token for a saved account: the live one when that
    /// account is the active login (Claude Code keeps it fresh), else the
    /// stored one, refreshed first when stale.
    ///
    /// THE RULE: a name that resolves to the live login returns the live token
    /// or throws `no_token`; it never reaches the refresh below, whatever its
    /// stored copy says. A refresh from here writes one profile file and
    /// nothing else - never ~/.claude/.credentials.json, never the Keychain.
    static func accessTokenFor(_ name: String) async throws -> (
        token: String, source: TokenSource
    ) {
        guard let profile = read(name) else {
            throw AccountError.coded(
                code: "no_account", message: "no saved account named \(name)")
        }
        if liveAccountName() == name {
            guard let token = liveToken(readLiveCredentials()) else {
                throw AccountError.coded(
                    code: "no_token",
                    message: "\(name): the live login cannot be read right now - try again")
            }
            return (token, .live)
        }
        switch profile.tokenState(nowMs: nowMs()) {
        case .valid: return (profile.accessToken, .store)
        case .stale: return (try await refresh(profile).accessToken, .refreshed)
        case .expired:
            throw AccountError.coded(
                code: "login_expired",
                message: "\(name): login expired - run `claude auth login` on it and save it again")
        }
    }

    // MARK: per-account usage

    /// Normalized usage for one saved account, with the code a row needs to
    /// say WHY there is none. A token taken from the live login is Claude
    /// Code's to keep fresh, so its refusal is reported as the live login's
    /// (no label, so the message keeps the "run any Claude Code command"
    /// hint); a stored or refreshed token is the profile's, so its failure
    /// names the profile. Same rule as claude-code/login-usage.js.
    static func usageFor(_ name: String, endpoint: any UsageEndpoint = ClaudeUsage.live)
        async -> AccountUsage
    {
        let token: String
        let source: TokenSource
        do {
            (token, source) = try await accessTokenFor(name)
        } catch {
            return AccountUsage(
                cards: nil, errorCode: (error as? AccountError)?.code ?? "no_token",
                message: error.localizedDescription)
        }
        let live = source == .live
        do {
            let result = try await endpoint.usage(token: token, label: live ? nil : name)
            return AccountUsage(cards: result.cards, errorCode: nil, message: nil, live: live)
        } catch let e as UsageError {
            return AccountUsage(
                cards: nil, errorCode: e.code, message: e.localizedDescription, live: live)
        } catch {
            return AccountUsage(
                cards: nil, errorCode: "network_error", message: error.localizedDescription,
                live: live)
        }
    }

    // The panels drop the latest per-account worst limit here so the status
    // line (no network, no credentials) can hint at a freer account. Same file
    // and shape as the node ports; every figure is an honest reading at `now`.
    static var usageCacheURL: URL { directory.appendingPathComponent(usageCacheFile) }

    static func writeUsageCache(_ usage: [String: [LimitCard]], now: Date = Date()) {
        var accounts: [String: Any] = [:]
        for (name, cards) in usage {
            accounts[name] = Accounts.usageCacheEntry(cards, now: now).json
        }
        let obj: [String: Any] = ["at": now.timeIntervalSince1970 * 1000, "accounts": accounts]
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
        try? writePrivate(data, to: usageCacheURL)
    }
}
