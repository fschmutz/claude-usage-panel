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

`claudectl account chrome NAME [--url=U]` opens Google Chrome with a profile of
its own for NAME, kept (mode 0700) under
`<state dir>/claude-usage-panel/chrome/NAME`. The main Chrome profile is never
read or written. Claude-in-Chrome pairs a browser with the Claude Code
sessions of the same claude.ai account, so a session on NAME (the current
login, or `claudectl account exec NAME -- claude`) drives this window and no
other.

The first launch opens two tabs: claude.ai sign-in and the extension's Web
Store page. Sign in as NAME and add the extension, once; both stay in the
profile. This step cannot be automated. The stored login is an API token,
not a claude.ai web session, and no password goes through a tool. Branded
Chrome also ignores `--load-extension` (137+), and force-install policy is
system-wide. Later launches open `--url` (default claude.ai). Every launch
lays the extension's native-messaging manifest inside the profile, naming the
live login's `~/.claude/chrome/chrome-native-host`. Claude Code writes that
host on its first `/chrome`; until then the command refuses.

`--fill-google` fills the Google sign-in of that window (for a Google
Workspace account such as eng@ behind "Continue with Google") from a
password manager. You run it in your own terminal through a wrapper that
unlocks the vault (the master password typed at its prompt) and puts one
item's username and password in the child's environment only, as
`CLAUDECTL_LOGIN_USER` / `CLAUDECTL_LOGIN_PASSWORD`, then locks the vault on
every exit:

```bash
trap 'bw lock' EXIT INT TERM
my-bw-inject --item work-google -- claudectl account chrome WORK --fill-google
```

claudectl
deletes both from its environment before Chrome starts. It asks you to type
`yes` at a prompt naming the origin and the keys, never the values. Then it
fills the email and the password only on `https://accounts.google.com`, which
it checks again right before each field, through DevTools on 127.0.0.1 for
this run, and logs `filled <field> from <key>`. No value is ever printed or
copied. 2FA stays on your phone. A Chrome of that profile already open is
refused (close it first: DevTools only starts with the window).

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
