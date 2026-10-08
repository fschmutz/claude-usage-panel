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

Run `./install.sh cost`: it installs the `ccusage` version pinned in
`.github/ccusage/package.json` (through Volta when you have it, else
`npm install -g`) and turns the cost line on; `./install.sh update` keeps it on
the pin. The panels run only an installed copy and never download one, and
they look in `~/.volta/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin` and
`/usr/local/bin` - an nvm global is on none of them, so the target refuses it.
Cost is computed by `ccusage` from your local logs, not by the API.

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

## A pause row never reaches SAFE

`claudectl session pause-status` names where each session stands (see the
state table in [[Pause]]):

- **no waiter yet**: the session started before `./install.sh pause`, or is
  mid-turn. It gets the request on its next tool call or turn; an idle one
  cannot be woken until then. Send it any message, or restart it.
- **delivered, working through the protocol** for a long time: the session has
  the text but has not run `report`. Look at that session; a model may treat
  hook text as untrusted and ask you first.
- **request expired before delivery** / **no verdict within the hour**: the
  request is more than an hour old. Send a new one.
- **superseded**: a newer request (a per-session Pause, a panel click) replaced
  it before that session answered. `pause-status` shows the newer one.
- **sent from inside a Claude Code session**: the request was typed in a
  Claude session's Bash, so each session asks you before pausing. Send it from
  a terminal or a panel instead.
- Nothing at all after the install: check that `~/.claude/settings.json` has
  the `pause-hook.js` entries under SessionStart, Stop and PreToolUse
  (`./install.sh --list` shows the target), then open a new session.

## Logs (GNOME)

```bash
journalctl --user -b 0 | grep claude-usage-panel
```
