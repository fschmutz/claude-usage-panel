# Session tabs

Nine Claude Code sessions across nine repos, and the desktop session dies, the
machine reboots, or a terminal window is closed by mistake. Getting them back
means finding each session id, `cd`-ing into the right directory and running
`claude --resume` nine times. `claudectl session` snapshots the running
sessions and reopens a snapshot as tabs of one terminal window, each tab in its
own directory resuming its own session:

```bash
claudectl session list    # what is running now (* = the session you type this in)
claudectl session save    # snapshot it (label = the time, or give one: save before-reboot)
claudectl session store   # saved snapshots, newest first
claudectl session open    # reopen the newest one: one window, one tab per session
```

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
|---|---|
| `list [--json]` | Running sessions: name, session id, state, directory |
| `save [LABEL] [--exclude-self]` | Snapshot the running sessions |
| `store [--json]` | Saved snapshots, newest first, numbered |
| `show [SNAP] [--json]` | What a snapshot holds, and which of its sessions are running |
| `open [SNAP] [--only=A,B] [--skip=A,B] [--force] [--dry-run] [--terminal=gnome-terminal\|tmux]` | Reopen a snapshot |
| `purge SNAP... \| --keep=N \| --auto \| --all [--yes]` | Delete snapshots (asks first) |
| `autosave [--keep=N]` | What the schedule runs |

`SNAP` is a label, a unique prefix of one, or its number in `store`; without
one, the newest snapshot is used.

## What `open` does

- **One window.** On a desktop with `gnome-terminal`, one new window with a tab
  per session, titled with the session name. Otherwise one detached tmux
  session `claudectl` with a window per session (`tmux attach -t claudectl`).
- **The right directory.** Each tab starts in the directory the session ran
  in and runs `claude --name <name> --resume <id>` through your interactive
  shell, so its PATH (volta, nvm) and aliases apply. When claude exits, the
  tab stays open on a shell in that directory.
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

Snapshots store only the name, the directory and the session id, one `0600`
JSON file per label:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/claude-usage-panel/tabs/`
- macOS: `~/Library/Application Support/claude-usage-panel/tabs/`
