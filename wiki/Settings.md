# Settings

## GNOME

Open via the dropdown's **Settings**, or:

```bash
gnome-extensions prefs claude-usage-panel@fschmutz.github.io
```

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
| **Terminal** | Which terminal a resume click opens. GNOME: a binary name, empty means autodetect (`$TERMINAL`, then ghostty, kitty, wezterm, alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm). macOS: Automatic / Terminal / iTerm. |

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
own 30-day cleanup, and what the MCP tool's `trend` field reads. Delete the
file to forget it; both panels write it and the MCP server only reads it.

Preferences persist in dconf (GNOME) / `UserDefaults` (macOS); the Cursor Admin API key is the exception and lives in the system keyring (libsecret) / the login Keychain.
