// The account store's step sequences, written once for both JavaScript ports:
// the GNOME extension (lib/accounts.js, Gio async) and the Node clients
// (claude-code/accounts.js, node:fs). lib/pure/accounts.js holds the
// decisions; this file holds the ORDER the store carries them out in, which is
// where its token safety lives: the live login synced back before anything is
// overwritten, a refresh only under the profile's lock, the switch marked
// pending before the first live write, a rename journaled before the first
// file moves. The Swift app is its own port (AccountStore.swift).
//
// Every sequence is a generator that yields one I/O step at a time as
// {op, args}; it never touches a file itself. A port answers each op, and a
// driver walks the generator: runAsync awaits every answer (GNOME, where
// nothing may block the Shell, and the Node switch / refresh / rename, which
// wait on the network or the lock), runSync takes the Node port's synchronous
// answers for the plain store reads and writes. One sequence, one step order,
// whichever driver runs it - tests/accounts-store-core.test.js records the
// steps of both ports and compares them.
//
// The port, every op optional only where noted:
//   readJSON(path) -> value | null       exists(path) -> bool
//   list(dir) -> file names, [] when missing
//   writePrivate(path, text)             atomic, created 0600 in a 0700 dir
//   move(from, to) -> bool               false when `from` is missing; overwrites
//   remove(path)                         a missing file is no error
//   mkdirPrivate(dir)                    createExclusive(path, text) -> bool (false: EEXIST)
//   lockInfo(path) -> {text, mtimeMs} | null   readText(path) -> text | null
//   sleep(ms)                            ps() -> `ps -eo args=` text | null
//   liveCredentials() -> creds | null    liveAccount() -> oauthAccount | null
//   readConfig() -> ~/.claude.json as an object ({} when missing; throws when not one)
//   writeConfig(cfg)                     the real file behind any symlink, 0600
//   prepareCredentials(creds) -> handle  everything the credentials write needs, resolved
//   writeCredentials(handle)
//   postToken(body) -> {status, json}    throws on a transport failure
// and three plain functions, never steps: now() (the store clock), uuid(),
// warn(error, message) (optional: a write the store can live without failed).

import {
    PROFILE_VERSION, REFRESH_LOCK, countClaudeProcesses, isTorn, isValidName, liveProfileName, parkName,
    parseProfile, parseRenamePending, refreshFailureCode, refreshLockFile, refreshRaced, refreshedOauth,
    renameBlocksSnapshot, renameHides, renameKey, renameRecovery, renameRefusal, sameJSON, sameName,
    saveRefusal, switchPlan, syncBackPlan, tokenState,
} from './accounts.js';

/** A refresh-lock takeover guard older than this was left by a crashed taker. */
export const TAKEOVER_STALE_MS = 120_000;

/** The store's files beside the profiles. */
export const STORE_FILES = {
    usageCache: '.usage-cache.json',
    weeklyResets: '.weekly-resets.json',
    lastSwitch: '.last-switch.json',
    // {at, from, to}, written before the live login is touched and removed
    // once both halves are in; no port snapshots the live login while it stands
    switchPending: '.switch-pending.json',
    // {at, from, to}, written before the first file of a rename moves and
    // removed once the old one is gone; a stale one is finished or undone by
    // the next store operation (renameRecovery)
    renamePending: '.rename-pending.json',
};

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * An error the UI has to classify rather than just print. `code` is the string
 * accountHealth() reads ('refresh_failed', 'login_expired', 'no_account',
 * 'no_token', 'transient', 'http_error', 'network_error'), so a broken saved
 * login is reported identically by every port.
 */
function coded(code, message) {
    return Object.assign(new Error(message), {code});
}

const step = (op, ...args) => ({op, args});

/** Walk `gen` with a synchronous port; an op that answers a promise is a bug. */
export function runSync(port, gen) {
    let r = gen.next();
    while (!r.done) {
        const {op, args} = r.value;
        let value, failure = null;
        try {
            value = port[op](...args);
        } catch (e) {
            failure = {e};
        }
        if (value && typeof value.then === 'function')
            throw new Error(`account store: ${op} answered a promise on the synchronous driver`);
        r = failure ? gen.throw(failure.e) : gen.next(value);
    }
    return r.value;
}

/** Walk `gen`, awaiting every answer of `port`. */
export async function runAsync(port, gen) {
    let r = gen.next();
    while (!r.done) {
        const {op, args} = r.value;
        let value, failure = null;
        try {
            value = await port[op](...args);
        } catch (e) {
            failure = {e};
        }
        r = failure ? gen.throw(failure.e) : gen.next(value);
    }
    return r.value;
}

/** The saved name a readSnapshot's live login is (token first; liveProfileName). */
export function activeIn(snap) {
    return liveProfileName(snap.profiles, snap.liveCreds?.claudeAiOauth.accessToken ?? null, snap.liveAccount);
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The sequences over one port. `dir` is the accounts directory; `hints` lets a
 * port name its own command in two refusals (finishSwitch(name),
 * removeFirst(name)).
 */
export function openStoreCore(port, {dir, hints = {}}) {
    const at = file => `${dir}/${file}`;
    const profilePath = name => at(`${name}.json`);
    const stamp = () => new Date(port.now()).toISOString();
    const finishSwitch = hints.finishSwitch ?? (name => `switch to ${name} again`);
    const removeFirst = hints.removeFirst ?? (name => `remove ${name} first`);
    const wall = () => Date.now(); // the lock runs on wall time: a store clock may be pinned

    // ── Profiles ────────────────────────────────────────────────────────────

    function* readPendingRename() {
        return parseRenamePending(yield step('readJSON', at(STORE_FILES.renamePending)));
    }

    /** Every valid profile, by name in code-point order. */
    function* listProfiles() {
        const out = [];
        for (const file of yield step('list', dir)) {
            if (!file.endsWith('.json') || file.startsWith('.'))
                continue;
            const profile = parseProfile(yield step('readJSON', at(file)));
            if (profile && `${profile.name}.json` === file)
                out.push(profile);
        }
        const hidden = renameHides(out.map(p => p.name), yield* readPendingRename());
        return out.filter(p => p.name !== hidden).sort(byName);
    }

    function* readProfile(name) {
        if (!isValidName(name))
            return null;
        const profile = parseProfile(yield step('readJSON', profilePath(name)));
        return profile?.name === name ? profile : null;
    }

    function* writeProfile(profile) {
        const clean = parseProfile(profile);
        if (!clean)
            throw new Error('not a valid profile');
        yield step('writePrivate', profilePath(clean.name), `${JSON.stringify(clean, null, 2)}\n`);
        return clean;
    }

    function* readPendingSwitch() {
        const p = yield step('readJSON', at(STORE_FILES.switchPending));
        return p && typeof p === 'object' && isValidName(p.to) ? p : null;
    }

    // A renamed account keeps its cached usage and its kept weekly reset.
    function* renameCacheEntries(from, to) {
        const cache = yield step('readJSON', at(STORE_FILES.usageCache));
        if (cache?.accounts && Object.hasOwn(cache.accounts, from)) {
            yield step('writePrivate', at(STORE_FILES.usageCache),
                JSON.stringify({...cache, accounts: renameKey(cache.accounts, from, to)}));
        }
        const resets = yield step('readJSON', at(STORE_FILES.weeklyResets));
        if (resets && Object.hasOwn(resets, from))
            yield step('writePrivate', at(STORE_FILES.weeklyResets), JSON.stringify(renameKey(resets, from, to)));
    }

    function* move(from, to) {
        if (!(yield step('move', from, to)))
            throw Object.assign(new Error(`no such file: ${from}`), {code: 'ENOENT'});
    }

    /** Finish or undo a rename a crash left behind; a fresh one is left
     *  alone (it may be running in another process). */
    function* recoverRename() {
        if (!(yield step('exists', at(STORE_FILES.renamePending))))
            return;
        const pending = yield* readPendingRename();
        const names = pending ? {
            atFrom: parseProfile(yield step('readJSON', profilePath(pending.from)))?.name ?? null,
            atTo: parseProfile(yield step('readJSON', profilePath(pending.to)))?.name ?? null,
        } : {};
        const plan = renameRecovery(pending, names, port.now());
        if (plan.action === 'wait')
            return;
        if (plan.removeFrom)
            yield step('remove', profilePath(pending.from));
        if (plan.moveBack)
            yield* move(profilePath(pending.to), profilePath(pending.from));
        if (plan.action === 'finish')
            yield* renameCacheEntries(pending.from, pending.to);
        yield step('remove', at(STORE_FILES.renamePending));
    }

    function* removeProfile(name) {
        yield* recoverRename();
        if (!(yield* readProfile(name)))
            throw new Error(`no saved account named ${name}`);
        yield step('remove', profilePath(name));
    }

    // ── The refresh lock ────────────────────────────────────────────────────
    // O_EXCL create, 0600. The lock carries a random id so a holder only ever
    // removes its own lock, never one a waiter took over after it went stale.

    // A stale lock is removed only under a second O_EXCL guard
    // (`<lock>.takeover`): holding it, the taker re-reads the lock and removes
    // it only if it is still exactly the one judged (same body, same mtime).
    // Takeovers go one at a time and a lock created since is never touched;
    // moving it aside and putting a mistaken move back left a window where a
    // third caller's create made the put-back fail: two holders. Same rule as
    // claude-code/excl-lock.js, the awake backstop and the Swift lock. A guard
    // older than TAKEOVER_STALE_MS was left by a crashed taker.
    function* takeOverStale(file, judged) {
        const guard = `${file}.takeover`;
        if (!(yield step('createExclusive', guard, ''))) {
            const held = yield step('lockInfo', guard);
            if (held && wall() - held.mtimeMs > TAKEOVER_STALE_MS) {
                try {
                    yield step('remove', guard);
                } catch {
                    // gone meanwhile
                }
            }
            return false;
        }
        try {
            const now = yield step('lockInfo', file);
            const same = Boolean(now && now.text === judged.text && now.mtimeMs === judged.mtimeMs);
            if (same)
                yield step('remove', file);
            return same;
        } finally {
            try {
                yield step('remove', guard);
            } catch {
                // already gone
            }
        }
    }

    function* acquireLock(name) {
        const file = at(refreshLockFile(name));
        const id = port.uuid();
        yield step('mkdirPrivate', dir);
        const start = wall();
        for (;;) {
            if (yield step('createExclusive', file, id))
                return {file, id};
            const judged = yield step('lockInfo', file);
            if (!judged)
                continue; // released between the two calls: try again at once
            if (wall() - judged.mtimeMs > REFRESH_LOCK.staleMs) {
                yield* takeOverStale(file, judged); // a crashed holder
                continue;
            }
            if (wall() - start > REFRESH_LOCK.waitMs)
                throw coded('transient', `${name}: another refresh of this login is still running - try again`);
            yield step('sleep', REFRESH_LOCK.pollMs);
        }
    }

    function* releaseLock({file, id}) {
        try {
            if ((yield step('readText', file)) === id)
                yield step('remove', file);
        } catch {
            // already gone
        }
    }

    /** Run the generator `body` holding `name`'s refresh lock. */
    function* withLock(name, body) {
        const lock = yield* acquireLock(name);
        try {
            return yield* body();
        } finally {
            yield* releaseLock(lock);
        }
    }

    // ── Rename ──────────────────────────────────────────────────────────────

    function renameError(from, to, refusal) {
        switch (refusal.kind) {
        case 'invalid':
            return new Error(`invalid name "${to}": letters, digits, . _ - only, up to 32 characters`);
        case 'missing':
            return new Error(`no saved account named ${from}`);
        case 'pending':
            return new Error(`the switch to ${refusal.profile} did not finish - ` +
                `${finishSwitch(refusal.profile)} completes it, then rename`);
        default:
            return new Error(`${refusal.profile} already exists - names ignore case, pick another name`);
        }
    }

    /**
     * Rename saved account `from` to `to`, under `from`'s refresh lock so a
     * refresh cannot write the old file back. The live login is matched by its
     * token and account, never by name, so nothing in ~/.claude changes. The
     * new file is written before the old one goes; a change of case moves the
     * file itself, since writing over a case-insensitive name keeps the old
     * spelling.
     */
    function* renameProfile(from, to) {
        yield* recoverRename();
        function* check() {
            const standing = yield* readPendingRename();
            if (standing)
                throw new Error(`a rename of ${standing.from} is in progress - try again in a moment`);
            const refusal = renameRefusal(yield* listProfiles(), from, to, yield* readPendingSwitch());
            if (refusal)
                throw renameError(from, to, refusal);
        }
        yield* check();
        if (from === to)
            return yield* readProfile(from);
        return yield* withLock(from, function* () {
            yield* check(); // a switch or a save may have landed while we waited
            const profile = yield* readProfile(from);
            const caseOnly = sameName(from, to);
            // Journaled first: a crash anywhere below is finished or undone by
            // the next store operation, never left as twins or an unlisted file.
            yield step('writePrivate', at(STORE_FILES.renamePending), JSON.stringify({at: port.now(), from, to}));
            let renamed;
            let moved = false;
            try {
                if (caseOnly) {
                    yield* move(profilePath(from), profilePath(to));
                    moved = true;
                }
                renamed = yield* writeProfile({...profile, name: to});
            } catch (e) {
                // A file named `to` that still says `from` is listed by no port:
                // put the name back before failing. A move that itself failed
                // left only the journal. A put-back that fails keeps the
                // journal for recoverRename; the write error is the one reported.
                let restored = !moved;
                if (moved) {
                    try {
                        yield* move(profilePath(to), profilePath(from));
                        restored = true;
                    } catch {
                        // journal kept
                    }
                }
                if (restored)
                    yield step('remove', at(STORE_FILES.renamePending));
                throw e;
            }
            if (!caseOnly)
                yield step('remove', profilePath(from));
            yield* renameCacheEntries(from, to);
            yield step('remove', at(STORE_FILES.renamePending));
            return renamed;
        });
    }

    // ── The live login ──────────────────────────────────────────────────────

    /**
     * What one poll needs, read once: the profiles, the live credentials and
     * account block, and the two journals. Every per-poll decision is then
     * made on it instead of re-reading ~/.claude.json per question. `live`
     * ({creds, account}) is a live login the caller already read this poll.
     */
    function* readSnapshot(live = null) {
        yield* recoverRename();
        const profiles = yield* listProfiles();
        const liveCreds = live ? live.creds : yield step('liveCredentials');
        const liveAccount = live ? live.account : yield step('liveAccount');
        const pendingSwitch = yield* readPendingSwitch();
        const pendingRename = yield* readPendingRename();
        return {profiles, liveCreds, liveAccount, pendingSwitch, pendingRename};
    }

    function* liveAccountName() {
        const profiles = yield* listProfiles();
        const creds = yield step('liveCredentials');
        return liveProfileName(profiles, creds?.claudeAiOauth.accessToken ?? null, yield step('liveAccount'));
    }

    function* snapshotLive(name) {
        const account = (yield step('liveAccount')) ?? {};
        return yield* writeProfile({
            version: PROFILE_VERSION, name, savedAt: stamp(), account,
            credentials: yield step('liveCredentials'),
        });
    }

    /**
     * Write the live login back into its own profile, so the tokens Claude
     * Code rotated since the last switch are the ones we keep. Returns the
     * profile name, or null when the live login is not a saved one. A torn
     * login, one without an account block, or one an unfinished switch left
     * behind is named but never written (syncBackPlan). With `snap` (a
     * readSnapshot) nothing is read twice; a profile it writes replaces the
     * one in `snap.profiles`.
     */
    function* syncBack(snap = null) {
        if (!snap)
            yield* recoverRename();
        const creds = snap ? snap.liveCreds : yield step('liveCredentials');
        if (!creds)
            return null;
        const account = snap ? snap.liveAccount : yield step('liveAccount');
        const profiles = snap ? snap.profiles : yield* listProfiles();
        const plan = syncBackPlan(profiles, {token: creds.claudeAiOauth.accessToken, account},
            snap ? snap.pendingSwitch : yield* readPendingSwitch());
        if (plan.pendingDone) {
            yield step('remove', at(STORE_FILES.switchPending));
            if (snap)
                snap.pendingSwitch = null;
        }
        if (!plan.name || !plan.snapshot)
            return plan.name;
        const stored = profiles.find(p => p.name === plan.name);
        const same = stored && sameJSON(stored.credentials, creds) && sameJSON(stored.account, account);
        // A rename that started since the plan could see the old name gone:
        // the snapshot would bring it back beside the new one.
        if (!same && !renameBlocksSnapshot(yield* readPendingRename(), plan.name) &&
            (yield* readProfile(plan.name))) {
            const written = yield* snapshotLive(plan.name);
            if (snap)
                snap.profiles = profiles.map(p => (p.name === written.name ? written : p));
        }
        return plan.name;
    }

    /** Save the live login as `name`. `force` overrules a name that already
     *  holds a different account, never a case variant or a twin (saveRefusal). */
    function* saveCurrent(name, {force = false} = {}) {
        yield* recoverRename();
        if (!isValidName(name))
            throw new Error(`invalid name "${name}": letters, digits, . _ - only, up to 32 characters`);
        if (!(yield step('liveCredentials')))
            throw new Error('no Claude Code login to save - run `claude auth login` first');
        const account = (yield step('liveAccount')) ?? {};
        const refusal = saveRefusal(yield* listProfiles(), name, account, force);
        if (refusal?.kind === 'variant')
            throw new Error(`${refusal.profile} already exists - names ignore case, use ${refusal.profile}`);
        if (refusal?.kind === 'taken')
            throw new Error(`${name} is already ${refusal.email ?? 'another account'} - pick another name or --force`);
        if (refusal) {
            throw new Error(`this login (${account.emailAddress ?? 'no email'}) is already saved as ` +
                `${refusal.profile} - ${removeFirst(refusal.profile)} if you meant to rename it`);
        }
        return yield* snapshotLive(name);
    }

    // A live login that was never saved must not be lost by a switch: park it
    // under a name derived from its email ("admin", then "admin-2" …).
    function* parkUnsavedLogin() {
        const account = yield step('liveAccount');
        if (!(yield step('liveCredentials')) || !account)
            return null;
        const taken = (yield* listProfiles()).map(p => p.name);
        return (yield* snapshotLive(parkName(account.emailAddress, taken))).name;
    }

    /** Claude Code processes alive right now - they keep the old token. */
    function* runningClaudeCount() {
        return countClaudeProcesses(yield step('ps'));
    }

    // ── Token refresh (our store only) ──────────────────────────────────────

    // The token exchange itself: the new OAuth block, or a coded throw.
    function* exchange(name, oauth) {
        let reply;
        try {
            reply = yield step('postToken', {
                grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID,
            });
        } catch (e) {
            throw coded('network_error', `${name}: token refresh failed - ${e.message}`);
        }
        if (!(reply.ok ?? (reply.status >= 200 && reply.status < 300))) {
            const code = refreshFailureCode(reply.status);
            throw coded(code, `${name}: token refresh rejected (HTTP ${reply.status})` +
                (code === 'refresh_failed' ? ' - log in again and save it' : ''));
        }
        const next = refreshedOauth(oauth, reply.json, port.now());
        if (!next)
            throw coded('refresh_failed', `${name}: token refresh returned no access token`);
        return next;
    }

    /**
     * Exchange the profile's refresh token for a new access token and store
     * the result, under the profile's refresh lock. When another process
     * refreshed it first, the stored result is returned and no token is spent.
     * Throws a coded error on failure. Never touches the live login.
     */
    function* refreshProfile(profile) {
        const sent = profile.credentials.claudeAiOauth;
        if (!sent.refreshToken)
            throw coded('login_expired', `${profile.name}: no refresh token - log in again and save it`);
        return yield* withLock(profile.name, function* () {
            const current = yield* readProfile(profile.name);
            if (!current)
                throw coded('no_account', `no saved account named ${profile.name}`);
            if (refreshRaced(sent, current.credentials.claudeAiOauth))
                return current;
            let next;
            try {
                next = yield* exchange(profile.name, sent);
            } catch (e) {
                // A process that took no lock may have spent it: a spent token
                // whose replacement is on disk is fine.
                const again = e.code === 'refresh_failed' ? yield* readProfile(profile.name) : null;
                if (again && refreshRaced(sent, again.credentials.claudeAiOauth))
                    return again;
                throw e;
            }
            // The rotated tokens go into OUR store and nowhere else: writing the
            // live credentials from here would rotate the token Claude Code is
            // running on.
            return yield* writeProfile({
                ...current, savedAt: stamp(),
                credentials: {...current.credentials, claudeAiOauth: next},
            });
        });
    }

    /**
     * A usable access token for a saved account: the live one when that
     * account is the active login (Claude Code keeps it fresh), else the
     * stored one, refreshed first when stale. With `snap` the profile, the
     * active name and the live credentials come from it.
     *
     * THE RULE: a name that resolves to the live login returns the live token
     * or throws `no_token`; it never reaches the refresh below, whatever its
     * stored copy says.
     */
    function* accessTokenFor(name, snap = null) {
        const profile = snap ? snap.profiles.find(p => p.name === name) ?? null : yield* readProfile(name);
        if (!profile)
            throw coded('no_account', `no saved account named ${name}`);
        if ((snap ? activeIn(snap) : yield* liveAccountName()) === name) {
            const live = snap ? snap.liveCreds : yield step('liveCredentials');
            if (live)
                return {token: live.claudeAiOauth.accessToken, source: 'live'};
            throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
        }
        switch (tokenState(profile, port.now())) {
        case 'valid':
            return {token: profile.credentials.claudeAiOauth.accessToken, source: 'store'};
        case 'stale': {
            const fresh = yield* refreshProfile(profile);
            return {token: fresh.credentials.claudeAiOauth.accessToken, source: 'refreshed'};
        }
        default:
            throw coded('login_expired', `${name}: login expired - run \`claude auth login\` on it and save it again`);
        }
    }

    // ── Switch ──────────────────────────────────────────────────────────────

    // Make `profile` the live login: validate ~/.claude.json and resolve the
    // credentials write BEFORE the first write, mark the switch pending, then
    // the account block, then the credentials, then clear the mark. Whatever
    // fails in between leaves the mark, and no port snapshots the live login
    // while it stands - even once Claude Code has rotated the old token past
    // any match - until a switch finishes the job. The config is read again
    // right before it is written, so a key Claude Code wrote while the
    // credentials write was being prepared survives.
    function* installLogin(profile, from) {
        yield step('readConfig');
        const credentials = yield step('prepareCredentials', profile.credentials);
        yield step('writePrivate', at(STORE_FILES.switchPending),
            JSON.stringify({at: port.now(), from: from ?? null, to: profile.name}));
        const cfg = yield step('readConfig');
        yield step('writeConfig', {...cfg, oauthAccount: profile.account});
        yield step('writeCredentials', credentials);
        yield step('remove', at(STORE_FILES.switchPending));
    }

    // The last switch is store state, so a switch made by the CLI, the MCP
    // tool or the other panel counts toward every caller's auto-switch cooldown.
    function* writeLastSwitch({from, to}) {
        try {
            yield step('writePrivate', at(STORE_FILES.lastSwitch), JSON.stringify({at: port.now(), from: from ?? null, to}));
        } catch (e) {
            if (!port.warn)
                throw e;
            port.warn(e, 'could not record the account switch');
        }
    }

    function* readLastSwitchMs() {
        const when = (yield step('readJSON', at(STORE_FILES.lastSwitch)))?.at;
        return Number.isFinite(when) ? when : null;
    }

    /**
     * Make `name` the live login. Order matters: the live login is synced back
     * (or parked under a new name if it was never saved) BEFORE anything is
     * overwritten, and the target is refreshed BEFORE it is installed, so a
     * refresh failure leaves the current login untouched. Re-running after an
     * interrupted switch finishes it.
     */
    function* switchTo(name) {
        let target = yield* readProfile(name);
        if (!target)
            throw new Error(`no saved account named ${name}`);
        // The live login by its account block, with credentials we cannot
        // read: refreshing or reinstalling the stored copy would spend or
        // overwrite the refresh token Claude Code is running on.
        if (!(yield step('liveCredentials')) && (yield* liveAccountName()) === name)
            throw coded('no_token', `${name}: the live login cannot be read right now - try again`);
        const synced = yield* syncBack();
        const plan = switchPlan({
            name, synced, pending: yield* readPendingSwitch(),
            torn: isTorn(yield* listProfiles(), name, yield step('liveAccount')), state: tokenState(target, port.now()),
        });
        const from = plan.park ? yield* parkUnsavedLogin() : plan.from;
        const email = target.account.emailAddress ?? null;
        if (plan.action === 'stay' || plan.action === 'repair') {
            if (plan.action === 'repair')
                yield* installLogin(target, from); // finish an interrupted switch
            return {from, to: name, changed: false, running: yield* runningClaudeCount(), email};
        }
        if (plan.action === 'expired')
            throw new Error(`${name}: login expired - run \`claude auth login\` on it and save it again`);
        if (plan.action === 'refresh')
            target = yield* refreshProfile(target);
        yield* installLogin(target, from);
        yield* writeLastSwitch({from, to: name});
        return {from, to: name, changed: true, running: yield* runningClaudeCount(), email};
    }

    return {
        listProfiles, readProfile, writeProfile, readPendingSwitch, readPendingRename, recoverRename,
        removeProfile, renameProfile, renameCacheEntries, readSnapshot, liveAccountName, syncBack,
        saveCurrent, runningClaudeCount, acquireLock, takeOverStale, releaseLock, withLock, refreshProfile,
        accessTokenFor, writeLastSwitch, readLastSwitchMs, switchTo,
    };
}
