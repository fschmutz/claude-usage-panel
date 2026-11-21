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
`list_accounts` / `save_account` / `switch_account` / `rename_account` so you
can say *"switch me to PERSO"* in the conversation.

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
| --- | --- | --- |
| The OAuth tokens | `~/.claude/.credentials.json` | login Keychain item `Claude Code-credentials` (`Claude Code-credentials-<hash>` when `CLAUDE_CONFIG_DIR` is set, as Claude Code names it) |
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

**An interrupted switch** (a crash or a kill between the two writes) is marked
in the store, so no client takes the half-installed login for either account.
`claudectl account list` shows it (`the switch to NAME did not finish`), and
re-running `claudectl account use NAME` finishes it.

On macOS every client writes the Keychain item with `/usr/bin/security`, the
tool Claude Code created it with, so the item's access list keeps trusting it.
The tokens go on stdin to `security -i` whenever they fit: it reads one command
of under 4096 bytes, about 2 KB of JSON. A larger blob (the item also holds
every MCP server's OAuth tokens, `mcpOAuth`, often tens of KB) goes on the
command line instead, as Claude Code itself does, where `ps` can see it for
the instant the write lasts.

**Claude Code sessions already running keep the old login** until they restart;
`use` tells you how many there are. New sessions, the panels and the MCP tool
see the new account immediately.

## Where the logins are kept

One file per account, mode `0600`, in a `0700` directory:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/claude-usage-panel/accounts/NAME.json`
- macOS: `~/Library/Application Support/claude-usage-panel/accounts/NAME.json`

Names are one path segment: letters, digits, `.` `_` `-`, up to 32 characters,
no leading dot or dash. Names are case-insensitive: `pro` and `PRO` are the
same account (the macOS disk is), so a name differing from a saved one only by
case is refused. `rename NAME NEW` renames one (also a pencil in the GNOME
preferences and a **Rename** button in macOS Settings): the login, its cached
usage and its kept weekly reset move with it, `~/.claude` is not touched, and
NEW must be free ignoring case - changing only the case is fine. A rename runs
under that login's refresh lock and is refused while a switch is unfinished.
It is journaled before the first file moves, so a rename killed half-way is
finished (or undone, if the new file never got written) by the next save,
switch or remove - never left as two names on one login.
`remove NAME` forgets one; `--uninstall accounts` keeps them (delete the
folder yourself).

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

Reading a parked account's usage can therefore rotate that account's tokens -
and nothing else. The live branch returns Claude Code's own token before any
exchange can happen, so polling never touches the credentials Claude Code is
running on, not even when the account being polled *is* the live login.
`tests/accounts-store.test.js` pins all three halves of that: the profile
rotates, `~/.claude/.credentials.json` and `~/.claude.json` do not, and a
refused refresh leaves every one of them as it was.

## What a row says when something is wrong

A stored login's own dates are not the whole story: a token whose `expiresAt`
is hours away can still be one the endpoint turns down. So each row's state
folds the dates together with whatever the last fetch actually said:

| State | Means | The row's one repair |
| --- | --- | --- |
| `valid` | the stored token is good as it stands | - |
| `stale` | it is about to expire; the refresh token handles it on next use | - |
| `expired` | the refresh token is gone or spent | `claude auth login`, then save again |
| `refresh-failed` | the exchange was refused, or the endpoint turned the token down | the same - the saved credentials are finished whatever their dates say |
| `unreachable` | nothing is known to be wrong; the reading is simply missing (a 429, a 5xx, no network) | retry |

A row in one of the first two states shows its usage. A row in any of the
others shows **why it has none** - never the figures from the last poll that
worked, because a broken login must stop looking like a working one.

Every row also says when that account's week restarts: `S 42% · W 12% ↻4d2h`.
The reset is the one fact that stays true after a login breaks, so both panels
keep each account's last one in `<accounts dir>/.weekly-resets.json`
(`{NAME: epochMs}`) until it passes, and a row with no figures still shows it:
`(refresh failed) · W ↻4d2h`.

## Inline notices

Anything that needs doing is said next to the account it is about, with the one
button that fixes it - not in a line at the bottom of the panel, and not in
Settings:

| Notice | When | Its one button |
| --- | --- | --- |
| Incomplete switch to *NAME* | a switch was interrupted between its two writes | **Finish switch** (re-runs it) |
| *NAME*'s credentials and account block disagree | a torn login | **Repair** (reinstalls the profile it says it is) |
| Signed in as *email*, but this login is not saved | the live login was never named | **Save as *name*** - the name a switch would have parked it under |
| *NAME*: login expired / the stored login was refused | see the table above | **Copy sign-in command** (`claude auth login`) |
| *NAME*: no usage reading right now | `unreachable` | **Retry** |

The answer to pressing one of those - and to a switch, a save, a rename or a remove -
appears beside the control that caused it and clears itself after a few seconds
or on the next action.

## Next

With two or more saved logins, the accounts block carries a **Next** control
that walks the saved list in order and wraps, plus one quiet line saying so and
naming where it would go. That order is the same code-point order every client
lists accounts in, so the line describes exactly what the button does. It is a
manual rotation and is unrelated to the auto-switch below, which picks by
headroom rather than by position.

## Auto-switch

Off by default. When it is on (a button in the dropdown's header on both
panels, a switch in the preferences / Settings),
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
claudectl account rename NAME NEW                 rename a saved account
claudectl account remove NAME                     forget a saved account
claudectl account refresh [NAME]                  refresh the stored token(s) now
claudectl account exec NAME -- CMD [ARG...]       run CMD as NAME, the current login untouched
```

`save` refuses a name that already belongs to a different account, and refuses
to save an account that is already saved under another name; `--force`
overrides both. `list --usage` reads every account's limits (refreshing where
needed) and writes the snapshot the status line reads. `refresh` without a
name goes through every saved account even when one fails, and exits 1 if any
did.

`exec` runs one command as a saved login without switching:
`claudectl account exec PERSO -- claude -p "list my routines"`. The command
gets a throwaway `CLAUDE_CONFIG_DIR` (mode 0700, in the per-user scratch dir)
holding only PERSO's credentials and account block, plus the pause waiter
hooks when `./install.sh pause` is in (so the session can be paused and gets
[`claudectl session send`](Pause.md#messages-between-sessions) messages) - no
other settings, hooks or MCP servers - and `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` are dropped
from its environment. A stale token is refreshed first; a token the command
rotates is written back to PERSO, never to the current login; the dir (and on
macOS its own Keychain item) is removed when the command exits, and one left
by a run that died is synced back and removed by the next `exec`. The current
login itself is refused: Claude Code holds its single-use refresh token.
Claude Code repoints Chrome's native-messaging manifest
(`NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`)
into its config dir; `exec` records it before the run and puts it back after
(a run that died is healed by the next `exec`, to the live login's
`~/.claude/chrome/chrome-native-host`), so Claude-in-Chrome keeps working
for every other session. Two
long `exec` runs of the same NAME at once can both rotate its token; keep
concurrent runs short.

## An isolated Chrome per account

`claudectl account chrome [NAME] [--url=U]` opens Google Chrome with a profile
of its own for NAME (the current login when NAME is left out), kept (mode 0700) under
`<state dir>/claude-usage-panel/chrome/NAME`. The main Chrome profile is never
read or written. Claude-in-Chrome pairs a browser with the Claude Code
sessions of the same claude.ai account, so a session on NAME (the current
login, or `claudectl account exec NAME -- claude`) drives this window and no
other.

Every launch prints what the profile holds (claude.ai: signed in / NOT signed
in / unknown, from its `sessionKey` cookie; extension: installed / MISSING,
from its entry in the profile's Preferences and the folder it names) and opens
the claude.ai sign-in tab only when it is signed out. Sign in as NAME once
(the stored login is an API token, not a claude.ai web session, and no
password goes through a tool); it stays in the profile.

A missing extension is installed before Chrome starts, with no click: its
files are copied from a profile of the main Chrome that has it (offline, the
version already in use), else downloaded as a CRX from the Web Store's update
service, and the profile's `Default/Preferences` gets the entry Chrome writes
for a Web Store install, granting exactly the permissions the extension's
manifest declares. Measured on branded Chrome 158 (Linux, 2026-11-20): the
extension loads at the next start and stays. What does not work, measured:
`--load-extension` (removed from branded Chrome 137+), an `External
Extensions/<id>.json` in the user-data-dir, the Web Store tab of a fresh
profile (it stops on consent.google.com), and policy (system-wide, root).
Nothing is written while that profile's Chrome runs (Chrome rewrites its
Preferences on exit): close it and rerun. On macOS the install is not proven,
so the Web Store tab opens there instead, as it does after a failed install.

The extension keeps its own claude.ai sign-in (an OAuth login in its
`chrome.storage.local`), separate from the website's session, and Claude Code
pairs only with a signed-in extension: a fresh install is NOT CONNECTED until
then. While its storage holds none of the keys a signed-in extension writes
(`tokenOrg`, `tokenScope`; names only, never a value),
each launch opens the extension's own page
(`chrome-extension://<id>/sidepanel.html`): click Sign in, then Authorize on
claude.ai, once. `--check` names it as the reason.
Every launch
lays the extension's native-messaging manifest inside the profile, naming the
live login's `~/.claude/chrome/chrome-native-host`. Claude Code writes that
host on its first `/chrome`; until then the command refuses.

`claudectl account chrome [NAME] --check [--json]` opens nothing: it asks
Claude-in-Chrome as NAME (`claude -p --chrome` calling `tabs_context_mcp`,
read as stream-json; through `account exec` when NAME is not the current
login) and prints CONNECTED, NOT CONNECTED or INCONCLUSIVE, exit 0 only when
connected. When not, it lists the reasons read from the files: the live
native host, each manifest, the extension in NAME's profile and in the main
Chrome's profiles, the claude.ai sign-in, whether each Chrome runs (its
`SingletonLock` pid); "signed in to another account" is the inference left
once those are fine. It then probes every other saved account, one after the
other, to say which one the extensions answer: the main Chrome for certain
only when that account's own Chrome is not running with the extension. Each
probe is a short `claude -p` run on that account, up to 2 minutes.

Sign in with the link claude.ai mails, never a password: open
`claudectl account chrome NAME --url=https://claude.ai/login`, type the
account's email by hand (claude.ai refuses a page driven over DevTools), then
open the link from the mail with `claudectl account chrome NAME --url=<link>`.
Each link works once. Google sign-in is not needed, and cannot be automated
either: Google rejects a DevTools-driven Chrome with "This browser or app may
not be secure" (measured 2026-11-09).

## A fresh sign-in for a dead login

A saved login whose refresh token is gone (`expired`) or refused
(`refresh-failed`) cannot be refreshed: only a new sign-in helps.
`claudectl account login NAME` does it without touching the current login:
`claude auth login --email <NAME's email>` runs in a throwaway config dir, and
its browser step opens in NAME's own Chrome (`account chrome`, above), which is
already signed in to claude.ai as NAME. Click Authorize there; the CLI's
localhost callback ends the login by itself and the new credentials go into
NAME's profile. No code is pasted. NAME's Chrome must hold a claude.ai
session first (a live `sessionKey` cookie, read by name and date only from a
copy of the profile's cookie store); signed out, the command stops at once and
names the sign-in step instead of waiting. The page opens alone
(`account chrome --only`), never with the sign-in or Web Store tabs. A sign-in that comes back as another
account is not saved, and the current login is refused (Claude Code holds it:
run `claude auth login` directly).

`claudectl account login --expired` does the same for every saved login a new
sign-in would repair (it fetches usage first, so a refused token counts),
one after the other; one that fails or times out does not stop the rest.
`--wait=S` gives up on a missing click after S seconds (default 600),
`--dry-run` only says what would run. With claudectl installed, the panels'
"Copy sign-in command" button copies `claudectl account login NAME`; without
it, `claude auth login`, which replaces the current login.

## When a percentage is not shown

A bar shows `–` and draws empty, rather than a number, in two cases: when the
payload carried no figure for that limit at all (the endpoint ships kinds
nobody has enabled as null placeholders, and drawing those as 0% reads as a
full tank), and in the minutes after a window's reset instant has passed, while
the endpoint is still returning the old window's figure. The same rule runs in
the GNOME dropdown, the macOS popup, both top bars and the status line, and is
pinned by `tests/fixtures/reading.json`.

## Where the same logic lives

`claude-code/accounts.js` is the implementation behind the CLI, the MCP server
and the status line. The GNOME extension (`lib/pure.js` + `lib/accounts.js`)
and the macOS app (`ClaudeUsageCore/Accounts.swift` + `AccountStore.swift`)
mirror it; `tests/fixtures/accounts.json` pins the decisions they must agree on
(what a valid profile is, which saved account the live login is, when a token
is valid / stale / expired, and the auto-switch rule). The usage snapshot the
panels write for the status line is one small JSON file next to the profiles.

The row states, the inline notices, the button-local answers and the rotation
are their own shared contract - `lib/pure/notices.js` (the GNOME panel, the CLI
and the MCP server all import it) and `ClaudeUsageCore/Notices.swift` - pinned
by `tests/fixtures/notices.json`.
The sentences and button labels are deliberately per-port, because they are
translated; what the fixture pins is which notice appears, in what order, how
loud it is, and what its one repair does.
