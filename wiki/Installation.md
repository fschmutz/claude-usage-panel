# Installation

One line - it fetches the repo into `~/.local/share/claude-usage-panel` and
auto-detects your OS to install the sensible set:

```bash
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash
```

Pass targets and flags through with `bash -s -- …`:

```bash
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash -s -- statusline mcp
```

Or from a clone: one `install.sh` at the repo root installs, updates, and
uninstalls every client.

| Command | Does |
|---|---|
| `./install.sh` | auto-detect OS → the sensible set |
| `./install.sh gnome` | GNOME Shell extension |
| `./install.sh statusline` | Claude Code status line |
| `./install.sh mcp` | `get_usage` MCP tool → Claude Code + Cursor |
| `./install.sh macos` | build + install the macOS `.app` |
| `./install.sh autoupdate` | daily check for a new release + auto-install |
| `./install.sh sessionping [HH:MM …] [--days=…]` | scheduled `claude` pings that open the 5h session window (opt-in) |
| `./install.sh update [target…]` | reinstall what's already installed (upgrade) |
| `./install.sh update --pull` | `git pull` first, then upgrade |
| `./install.sh --uninstall [target…]` | reverse an install |
| `./install.sh --dry-run [target…]` | print the actions without doing them |
| `./install.sh --list` | show detected + installed targets |

Each target guards its own dependencies and is skipped with a clear message if
they're missing, rather than failing the whole run. Re-running is safe.

## GNOME (Linux)

Requirements: GNOME Shell 45–50, an active Claude Code login.

The `gnome` target copies the extension, compiles its GSettings schema, clears the
global `disable-user-extensions` switch if set, and enables the extension for every
login. Then **log out and back in** - Wayland only loads new extensions at login.

```bash
gnome-extensions info claude-usage-panel@fschmutz.github.io   # State: ACTIVE
```

### From a packaged release

Download the `…shell-extension.zip` asset (not "Source code") from the
[latest release](https://github.com/fschmutz/claude-usage-panel/releases/latest):

```bash
gnome-extensions install --force claude-usage-panel@fschmutz.github.io.shell-extension.zip
```

## macOS

Requirements: macOS 13+, Xcode 15+ or the Swift toolchain.

```bash
./install.sh macos       # build, install to /Applications, and launch it
```

This builds `ClaudeUsagePanel.app`, ad-hoc signs it, copies it to `/Applications`,
and opens it. On first run it **registers itself to start at login** (toggle in
Settings ▸ Start at login). Just want to run it without installing?
`cd macos && swift run`. See [[macOS]] for login-item and Keychain details.

## MCP tool - no clone needed

The `get_usage` tool also installs without touching the repo:

```bash
# Claude Code plugin (inside a session)
/plugin marketplace add fschmutz/claude-usage-panel
/plugin install claude-usage@claude-usage-panel

# or one CLI line
claude mcp add claude-usage -- npx -y github:fschmutz/claude-usage-panel

# Cursor: click "Add to Cursor" on the landing page
```

See [[MCP Tool]].

## Staying up to date

### Automatically (on by default)

Installing from a git checkout also schedules a **daily update check** - the
`autoupdate` target. Once a day it reads the highest released `vX.Y.Z` tag on
`origin`; if that's newer than your `package.json` version it fast-forwards the
checkout and runs `install.sh update`, so every client you have moves to the new
release without you doing anything. A desktop notification says when it lands.

| | |
|---|---|
| Linux | systemd user timer `claude-usage-panel-update.timer` (`OnCalendar=daily`, `Persistent=true`, so a missed day runs at next login) |
| macOS | launchd agent `io.github.fschmutz.claude-usage-panel.update`, daily at 11:17 |
| Neither | a `cron` line tagged `# claude-usage-panel auto-update` |

```bash
scripts/auto-update.sh --status     # installed vs latest, and when it last looked
scripts/auto-update.sh --check      # look now, install nothing (exit 10 = update waiting)
scripts/auto-update.sh              # look now, and install it if there is one
./install.sh --uninstall autoupdate # turn the daily check off
```

It is deliberately timid about your checkout: it **only ever fast-forwards**
(no merge, rebase, reset or stash), and it skips - logging the reason, changing
nothing - when the worktree is dirty, the branch is diverged or detached, there
is no `origin`, or the network is down. It also reinstalls **only** the targets
already installed, so it never adds a client you didn't want. The rolling log
is `~/.local/state/claude-usage-panel/auto-update.log`.

### By hand

```bash
./install.sh update --pull      # git pull, then reinstall whatever you have
```

`update` reinstalls only the targets already present (see `./install.sh --list`),
so it won't add clients you never installed. `--pull` fast-forwards the checkout
first. Per target: the **status line** and **MCP server** take effect next
session; **GNOME** needs a log out / back in (Wayland); **macOS** quits the
running app, replaces it in `/Applications`, and relaunches the new build.

## Session pings

The 5-hour Claude Code session window opens at your **first message** - start
work at 9:00 and a 9-to-5 day fits only two full windows. The opt-in
`sessionping` target schedules a tiny `claude` ping (haiku model, one turn) at
fixed local times so the window opens on *your* schedule - ping at 5:30 and the
same day fits three (5:30-10:30, 10:30-15:30, 15:30-20:30).

```bash
./install.sh sessionping                          # default: 05:30, Mon-Fri
./install.sh sessionping 05:30 10:35              # several pings a day
./install.sh sessionping 06:00 --days=mon,wed,fri # pick the days (or --days=all)
```

It is never part of the auto-detected set - every ping spends one haiku turn of
your plan, so you have to ask for it. To **change the schedule**, just run the
install command again with new times/days; it replaces the previous schedule
in place. A plain `./install.sh update` keeps whatever times and days you
configured.

The same schedule is also editable **in the desktop clients**, on both
platforms: GNOME preferences and the macOS menu-bar app's Settings both carry a
*Session pings* section (on/off, times, weekdays, a **Suggest times** button
that computes the schedule covering your working day, and the coverage it
reaches). Each is a frontend over the same scheduler artifact the installer
writes - the systemd user units on Linux, the launchd agent on macOS - so the
CLI and the UI always agree, and you can use whichever is closer to hand.

**Every client also reports when a ping last fired**: the GNOME and macOS
dropdowns show `Session pings: last 05:30 · next 10:35`, the macOS Settings
window has a *Last ping* row, the status line renders `ping 05:30` (silent
until you schedule pings), and the MCP `get_usage` tool returns a `lastPing`
field. The source is the stamp `scripts/session-ping.sh` writes to
`~/.local/state/claude-usage-panel/last-ping`.

The ping goes through the `claude` CLI (which refreshes the OAuth token if it
expired overnight - the panel's clients never write the token themselves), from
an empty working directory so none of your project context is loaded.

| | |
|---|---|
| Linux | systemd user timer `claude-usage-panel-sessionping.timer` (one `OnCalendar` per time, `Persistent=false`) |
| macOS | launchd agent `io.github.fschmutz.claude-usage-panel.sessionping` (one `StartCalendarInterval` per time) |
| Neither | `cron` lines tagged `# claude-usage-panel session-ping` |

```bash
scripts/session-ping.sh --status      # configured times/days, last ping, log path
scripts/session-ping.sh --force       # ping right now, whatever the day is
./install.sh --uninstall sessionping  # turn it off
```

The day filter lives in the script (the schedulers fire daily), the rolling log
is `~/.local/state/claude-usage-panel/session-ping.log`, and a missing `claude`
CLI makes a ping skip quietly rather than fail.
