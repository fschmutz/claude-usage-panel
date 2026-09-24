# Session tabs

Nine Claude Code sessions across nine repos, and the desktop session dies, the
machine reboots, or a terminal window is closed by mistake. Getting them back
means finding each session id, `cd`-ing into the right directory and running
`claude --resume` nine times. `claudectl session` snapshots the running
sessions and reopens a snapshot the way it was laid out - the same windows,
the same tabs in the same order - each tab in its own directory resuming its
own session:

```bash
claudectl session list    # what is running now (* = the session you type this in)
claudectl session save    # snapshot it (label = the time, or give one: save before-reboot)
claudectl session store   # saved snapshots, newest first
claudectl session open    # reopen the newest one: same windows, one tab per session
```

Both panels put the same thing one click away: the **Reopen** icon in the
dropdown's header (and the button in Settings ▸ Saved sessions) runs
`claudectl session open` on the newest snapshot. It appears only when there is
one - no claudectl, no snapshot, no button.

## Install

`./install.sh cli` puts `claudectl` on your PATH (`~/.local/bin`) and
schedules `claudectl session autosave` every 30 minutes (systemd user timer,
launchd agent or cron, whichever the machine has). Autosave writes an `auto-…`
snapshot only when the set of running sessions changed since the last one, and
keeps the newest 48 (one day). Manual snapshots are never pruned by it.

```bash
systemctl --user list-timers | grep claude-usage-panel-autosave   # Linux: is it scheduled
./install.sh --uninstall cli                                       # CLI + schedule off, snapshots kept
```

## Commands

| `claudectl session …` | What it does |
| --- | --- |
| `list [--json]` | Running sessions: name, session id, state, directory |
| `save [LABEL] [--exclude-self]` | Snapshot the running sessions |
| `store [--json]` | Saved snapshots, newest first, numbered |
| `show [SNAP] [--json]` | What a snapshot holds, and which of its sessions are running |
| `open [SNAP] [--only=A,B] [--skip=A,B] [--force] [--dry-run] [--terminal=BIN\|iterm\|terminal\|tmux] [--windows\|--tmux] [--prompt=TEXT\|--no-prompt]` | Reopen a snapshot in your terminal |
| `purge SNAP... \| --keep=N \| --auto \| --all [--yes]` | Delete snapshots (asks first) |
| `autosave [--keep=N]` | What the schedule runs |

`SNAP` is a label, a unique prefix of one, or its number in `store`; without
one, the newest snapshot is used.

`--exclude-self` (and the `*` marker in `list`) finds the session the command
runs in from `CLAUDE_PID`, which Claude Code sets for every command it runs,
and otherwise walks the parent process chain - the same on every platform.

## What `open` does

- **Your terminal.** The one a session click in the panel opens: on Linux
  the GNOME preference *Terminal used to resume a session*
  (`terminal-command`), then `$TERMINAL`, then the desktop's default
  terminal (`xdg-terminal-exec`, then `x-terminal-emulator`), and only then
  the first installed of Ghostty, kitty, WezTerm, Alacritty, foot,
  gnome-terminal, Konsole, Tilix, xfce4-terminal, xterm; on macOS the app's *Open in* setting (Terminal or
  iTerm). `--terminal=BIN` (or `iterm` / `terminal`) overrides it for one run.
- **Same windows, same tabs.** Sessions come back grouped in the windows
  they were saved from, tabs in their saved order. iTerm, gnome-terminal and
  xfce4-terminal open those windows with native tabs. Every other terminal
  gets one tmux session per saved window (`claudectl`, `claudectl-2`, …),
  each attached in a window of its own, with a tmux window per Claude
  session; without tmux, one terminal window per session (Alacritty, foot
  and xterm have no tabs to open). Terminal.app has no scriptable tabs:
  tmux when installed, else a window per session. `--windows` forces a
  window per session, `--tmux` the tmux layout everywhere, and
  `--terminal=tmux` builds the tmux sessions without opening a terminal
  (over ssh, say). A snapshot saved before placement existed, or from a
  terminal that cannot be placed, reopens in one window.
- **The right directory.** Each tab starts in the directory the session ran
  in and runs `claude --name <name> --resume <id>` through a login shell, the
  same command a panel click runs. When claude exits, the tab stays open on
  a shell in that directory.
- **It knows it was restarted.** Each resumed session gets a first message:
  which snapshot it came from and how long ago, that everything living only
  in the old process is gone (background shells, Monitors, `/loop` and
  scheduled wakeups, watchers on a push or a CI run), and to re-read where it
  stopped, re-check git / CI / the job it was waiting on, reply with a short
  done / interrupted / next status, re-arm its watchers and carry on -
  asking first for anything destructive or outward-facing, as before.
  `--prompt=TEXT` sends your own message instead, `--no-prompt` none.
- **No double resume.** A session still running is skipped (Claude Code
  refuses to resume a live session twice); `--force` tries anyway. A session
  whose directory or transcript is gone is skipped with the reason.

## Where the data comes from

Claude Code keeps a registry of its running sessions, one
`~/.claude/sessions/<pid>.json` per process, holding the session id, the
directory and the name. That file carries the session's *current* id (it moves
on `/clear`, so the id a process was started with can be stale). A registry
file outlives a crash, so each one is checked against the process table: on
Linux the kernel start time of the pid must match the one Claude Code
recorded, which also rejects a pid reused by another process; on macOS the pid
must be alive and running `claude`.

Placement - which window, which tab - is read at save time from each
session's controlling tty (kitty: its pid), most exact source first:

| Source | How | Notes |
| --- | --- | --- |
| tmux | `tmux list-panes -a` | tmux session = window, tmux window = tab, whatever terminal shows it |
| kitty | `kitty @ ls` | only from inside kitty or with `$KITTY_LISTEN_ON`; needs `allow_remote_control` |
| WezTerm | `wezterm cli --no-auto-start list` | never starts a WezTerm server |
| iTerm, Terminal.app | AppleScript over windows ▸ tabs | exact after tabs were dragged; macOS asks once for the Automation permission, so only a `save` you type asks, never the scheduled autosave, and only an app already running |
| iTerm | `ITERM_SESSION_ID` of the process | no permission; set when the tab opens and never updated, so a moved tab is placed where it was born |

tmux, kitty and WezTerm are looked up on `PATH` and in `/opt/homebrew/bin`,
`/usr/local/bin`, `/usr/bin`, `/bin`: the scheduled autosave and the macOS
app run with a PATH that lacks Homebrew. gnome-terminal cannot list its tabs:
those sessions are saved unplaced. Only Claude sessions are restored - a tab
running a plain shell is not.

A window saved from tmux reopens as a tmux session of the same name
(`work`) when the server does not already run one; otherwise, and for every
other window, the first free of `claudectl`, `claudectl-2`, …

Snapshots store the name, the directory, the session id and, when known,
`window` and `tab`, one `0600` JSON file per label:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/claude-usage-panel/tabs/`
- macOS: `~/Library/Application Support/claude-usage-panel/tabs/`
