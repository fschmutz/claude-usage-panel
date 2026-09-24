# Troubleshooting

## The panel doesn't appear (GNOME)

- New extensions load only at login on Wayland. **Log out and back in.**
- Check the global kill switch:

  ```bash
  gsettings get org.gnome.shell disable-user-extensions   # must be false
  gnome-extensions enable claude-usage-panel@fschmutz.github.io
  ```

- Confirm state: `gnome-extensions info claude-usage-panel@fschmutz.github.io` → `State: ACTIVE`.

## "No Claude credentials found"

- **Linux:** sign in with Claude Code (creates `~/.claude/.credentials.json`).
- **macOS:** the token is in the Keychain - allow Keychain access on first launch.
- If the token expired, run any Claude Code command to refresh it.

## Cost shows "unavailable"

Install `ccusage` on your PATH (`npm install -g ccusage`). The panels run only an
installed copy and never download one. Cost is computed by `ccusage`, not the API.

## Cursor section errors

Re-check the Admin API key and that your account is a **team admin** (the Admin API is team-only).

## Clicking Refresh closed the popup

Fixed in v1.2.1 - update and relog.

## It's not updating itself

```bash
scripts/auto-update.sh --status                       # installed vs latest, last check
tail -20 ~/.local/state/claude-usage-panel/auto-update.log
systemctl --user list-timers | grep claude-usage-panel   # Linux
launchctl list | grep claude-usage-panel                 # macOS
```

The log says why, in its own words: the checkout has **local changes** or a
**diverged / detached branch** (it never touches your work), there is **no
newer released tag** yet (a `main` commit is not a release), the machine was
**offline**, the remote lookup failed for a named reason (`fatal: Repository
not found`, `Permission denied (publickey)`), the reinstall failed and is owed
(`update-pending` in the state dir - it retries), or the daily check was never
installed -
`./install.sh autoupdate` adds it, `./install.sh --list` shows whether it's
there. Run `scripts/auto-update.sh` by hand any time to force a check
(`--force` re-runs the install even when nothing is newer).

If `--status` says **"Installed X, running Y"**, the update landed and GNOME
Shell is still running the code it loaded at login: log out and back in. If it
says **"Installed X, checkout Y"**, the code is there but the clients are not -
press Update now, or run `./install.sh update`.

## Logs (GNOME)

```bash
journalctl --user -b 0 | grep claude-usage-panel
```
