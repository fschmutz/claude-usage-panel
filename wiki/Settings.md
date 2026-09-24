# Settings

## GNOME

Open via the gear button in the dropdown's header, or:

```bash
gnome-extensions prefs claude-usage-panel@fschmutz.github.io
```

Four tabs: **General** (refresh, top bar, alerts, updates), **Accounts**,
**Sessions** (today's sessions and the terminal, saved sessions, session
pings) and **Integrations** (cost, Cursor). The cross at the right of the
dropdown's header is **Quit**: it turns the extension off until you enable it
again (`gnome-extensions enable claude-usage-panel@fschmutz.github.io`).

The header's other icons, right to left: **Settings** (gear), **Refresh now**,
**Reopen** - the newest `claudectl session` snapshot, one tab per session, the
same thing Settings ▸ Saved sessions does and shown only when there is a
snapshot to reopen (see [[Tabs]]) - and, when there is more than one saved
login, **auto-switch**. macOS has the same row in its dropdown.

## macOS

Quick toggles (Cost, Alerts, Refresh) live in the dropdown; a full **Settings** window
(⌘, or the dropdown's **Settings…**) holds every option including Cursor.

## Options

| Option | What it does |
|---|---|
| **Refresh interval** | Minutes between polls (default 10). It is a floor, not a fixed rate: after three polls in which nothing moved the clients back off to at most 15 minutes, a poll is always pulled forward to just after the nearest reset, and both panels also refresh on wake from sleep and when the network comes back. |
| **Top bar shows** (GNOME) | Worst limit, or the current session. |
| **Limit-crossing alerts** | Notify when a limit reaches 90% / 100%. |
| **Run on limit crossing or reset** | A shell command run when a limit crosses 90% / 100% or when its window resets. Placeholders: `%e` event (`threshold` or `reset`), `%l` label, `%p` percent, `%t` threshold, `%k` key, `%%` a literal `%`. Every substituted value is shell-quoted - the label is API text - and an empty setting disables it. Example: `notify-send "Claude %l" "%e at %p%%"`. |
| **Show session cost** | Compute session cost locally via `ccusage`. |
| **Show Cursor usage** | Add the Cursor team-spend section (see [[Cursor Integration]]). |
| **Session pings** | Schedule the `claude` ping that opens the 5h window: on/off, times, weekdays, **Suggest times** for your working day, and the coverage it reaches. Writes the same systemd units / launchd agent as `./install.sh sessionping`, and shows when a ping last fired (see [[Installation]]). |
| **Show today's sessions** | List today's sessions in the dropdown, ranked by the tokens each spent, with a click to resume one (see below). |
| **Enable named accounts** | Off by default: nothing account-related is shown until it is on. Then the saved Claude logins appear: save the current one under a name, remove one, the auto-switch toggle + threshold. The same setting is a button in the GNOME dropdown's header (lit when armed, its hover title saying at which percentage), unless **Show the auto-switch button in the dropdown** is off; on macOS it stays a menu toggle next to the account rows. See [[Accounts]]. |
| **Show the account name in the top bar / menu bar** | Prefix the readout with the active saved account's name: `PRO · Session 42%`. The prefix appears only once you have saved more than one login, and only while the whole readout fits the bar's 20-character budget - a name that would not fit is dropped rather than abbreviated (the dropdown names it in full). |
| **Terminal** | Which terminal a resume click and `claudectl session open` open. GNOME: a binary name; empty means `$TERMINAL`, then the desktop's default terminal (`xdg-terminal-exec`, then `x-terminal-emulator`), then the first installed of ghostty, kitty, wezterm, alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm. macOS: Automatic / Terminal / iTerm. |
| **Saved sessions** (GNOME) | What `claudectl session` keeps: whether the 30-minute autosave is scheduled, the newest snapshot, and **Reopen** to bring it back as tabs (see [[Tabs]]). |

## Resuming today's sessions

The dropdown lists up to five of today's sessions, biggest token spender first,
and clicking one opens your terminal in that project running
`claude --resume <that session id>`.

The tokens are **estimated**: they are folded out of the local transcripts in
`~/.claude/projects` (cache reads excluded, since they bill at a fraction), not
reported by the API - which is why the section says *est.*, like the cost line.
Those transcripts are large, so the clients keep an incremental index in
`~/.cache/claude-usage-panel/sessions.json` (`~/Library/Caches/…` on macOS) and
only ever read the bytes each file has grown by. On a cold cache the header
says *still indexing* for a refresh or two while it catches up.

The same data is available headless: the MCP `get_usage` tool returns a
`sessions` array with a ready-to-run `resumeCommand` for each, and the status
line can show the day's biggest spender with `--segments=…,sessions`.

## Usage history

Every poll in which a limit actually moved appends one line to
`~/.local/state/claude-usage-panel/history.jsonl`
(`~/Library/Application Support/…` on macOS), pruned to 90 days on start. That
is what lets each card say *peak 71% this week · 84% last* long after Claude's
own 30-day cleanup, and what the MCP tool's `trend` field reads. Each line is
filed under the login it was polled as (`"a"`, the `oauthAccount` uuid), so
with several saved accounts a card only ever compares a login against its own
weeks. Delete the file to forget it; both panels write it and the MCP server
only reads it.

Preferences persist in dconf (GNOME) / `UserDefaults` (macOS); the Cursor Admin API key is the exception and lives in the system keyring (libsecret) / the login Keychain.
