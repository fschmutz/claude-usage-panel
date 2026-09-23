# Named accounts

Two Claude subscriptions - a work Max and a personal Pro, say - normally mean
`/logout`, a browser round-trip and a minute lost every time you move between
them. Claude Code has no account switcher of its own
([#35856](https://github.com/anthropics/claude-code/issues/35856)). This one
saves each login under a name and switches in place:

```bash
claudectl account save PRO        # the login you are on now
claude auth login              # sign in to the other account, once
claudectl account save PERSO
claudectl account use PRO         # from now on: no browser, no logout
```

Every client shows the same thing: the GNOME dropdown and the macOS menu list
the saved accounts with each one's usage and switch on a click, the status line
tags the session with its account (`[PRO]`), and the MCP tool grows
`list_accounts` / `save_account` / `switch_account` so you can say *"switch me
to PERSO"* in the conversation.

## Install

`./install.sh cli` puts `claudectl` on your PATH (`~/.local/bin`).
The desktop panels and the MCP server need nothing extra: the same module is
installed alongside them by `./install.sh statusline` / `mcp`, and the GNOME
extension and the macOS app carry their own port of it.

**Off by default in the panels.** Nothing account-related is drawn until you
turn on *Enable named accounts* in the GNOME preferences or the macOS Settings
(Accounts section); the status line shows its `[PRO]` tag only with
`--segments=…,account`. The CLI and the MCP tools work regardless.

## What a switch does

A Claude Code login is exactly two things:

| What | Where (Linux) | Where (macOS) |
|---|---|---|
| The OAuth tokens | `~/.claude/.credentials.json` | login Keychain item `Claude Code-credentials` |
| Who the account is (`oauthAccount`: email, organization, tier) | `~/.claude.json` | `~/.claude.json` |

`use NAME` swaps those two and nothing else - settings, hooks, plugins, MCP
servers, project history all stay. Both paths follow `CLAUDE_CONFIG_DIR` when
it is set. In order:

1. The login you are leaving is written back into its own saved profile. Claude
   Code rotates its tokens as it runs, so the copy taken at `save` time would
   otherwise die with its old refresh token. A login that was never saved is
   parked under a name derived from its email rather than lost.
2. The target's access token is refreshed first if it is stale (see below). A
   refresh that fails leaves your current login untouched.
3. The target's tokens and `oauthAccount` block are installed.

**Claude Code sessions already running keep the old login** until they restart;
`use` tells you how many there are. New sessions, the panels and the MCP tool
see the new account immediately.

## Where the logins are kept

One file per account, mode `0600`, in a `0700` directory:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/claude-usage-panel/accounts/NAME.json`
- macOS: `~/Library/Application Support/claude-usage-panel/accounts/NAME.json`

Names are one path segment: letters, digits, `.` `_` `-`, up to 32 characters,
no leading dot or dash. `remove NAME` forgets one; `--uninstall accounts` keeps
them (delete the folder yourself).

## Token refresh - the one thing written outside `~/.claude`

An access token lives about eight hours. Claude Code refreshes the login it is
on; nobody refreshes the ones it is not on. So when a saved account is needed -
to read its usage for the dropdown, or to switch to it - and its access token
is within five minutes of expiry, the panel exchanges that account's refresh
token for a new pair against Claude Code's own OAuth client
(`platform.claude.com/v1/oauth/token`, `grant_type=refresh_token`) and stores
the result **in its own profile file only**. The live login is never refreshed
by the panel: that stays Claude Code's job, exactly as before.

A refresh token lasts about thirty days. A saved account left untouched longer
than that reads *login expired* everywhere; sign in to it once with
`claude auth login` and `save` it again.

## Auto-switch

Off by default. When it is on (a button in the GNOME dropdown's header, a
toggle next to the accounts on macOS, a switch in the preferences on both),
each poll checks whether the active
account has crossed the threshold (90%, adjustable 50-100) on any limit. If
another saved account has usage at least 15 points under the threshold, the
panel switches to the one with the most headroom, notifies you (`Switched PRO →
PERSO: PRO was at 92% - 2 running sessions keep the old login until
restarted`) and re-polls as the new account. Never twice within five minutes,
never to an account it has no usage for, never when the current login is not a
saved one. The same rule, from the same shared fixture, drives the status
line's hint: `[PRO ⇢ PERSO]` in yellow means *this session is at the threshold
and PERSO has room* - it does not switch by itself; the status line has no
credentials.

## CLI reference

```text
claudectl account list [--usage] [--json]         saved accounts, the active one marked
claudectl account current [--json]                the active account's name (exit 1 if unsaved)
claudectl account save NAME [--force]             save the current login as NAME
claudectl account use NAME [--json]               make NAME the current login
claudectl account remove NAME                     forget a saved account
claudectl account refresh [NAME]                  refresh the stored token(s) now
```

`save` refuses a name that already belongs to a different account, and refuses
to save an account that is already saved under another name; `--force`
overrides both. `list --usage` reads every account's limits (refreshing where
needed) and writes the snapshot the status line reads.

## Where the same logic lives

`claude-code/accounts.js` is the implementation behind the CLI, the MCP server
and the status line. The GNOME extension (`lib/pure.js` + `lib/accounts.js`)
and the macOS app (`ClaudeUsageCore/Accounts.swift` + `AccountStore.swift`)
mirror it; `tests/fixtures/accounts.json` pins the decisions they must agree on
(what a valid profile is, which saved account the live login is, when a token
is valid / stale / expired, and the auto-switch rule). The usage snapshot the
panels write for the status line is one small JSON file next to the profiles.
