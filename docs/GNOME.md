# GNOME Shell extension

The GNOME client puts your Claude plan usage in the top bar: a glyph colored by
the worst limit's severity, and a designed dropdown with one card per limit -
session, weekly, and per-model (Fable, Opus…) - each with a percent, severity
color, sparkline trend, and reset countdown. Desktop notifications fire when
any limit first crosses 90% or 100%.

Per-model cards read "Share of the weekly all-models limit" under the
countdown: that usage draws from the weekly pool (on Max, up to 50% of the
weekly allowance may go to Fable) rather than adding a pool of its own.

Requires GNOME Shell 45–50.

## Install

```bash
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash -s -- gnome
```

or from a checkout: `./install.sh gnome`. Either way the installer copies the
extension, compiles its schema, clears the global `disable-user-extensions`
switch if set, and enables it to auto-start on every login.

Then **log out and back in** - Wayland loads new extensions only at login - and
confirm:

```bash
gnome-extensions info claude-usage-panel@fschmutz.github.io   # State: ACTIVE
```

Or install from a packaged release instead:

```bash
# download the .shell-extension.zip from the Releases page, then:
gnome-extensions install --force claude-usage-panel@fschmutz.github.io.shell-extension.zip
```

An extensions.gnome.org listing is planned - see [PUBLISHING.md](../PUBLISHING.md).

## Settings

<img src="settings.png" alt="Preferences window" width="420">

Open via the dropdown's **Settings**, or:

```bash
gnome-extensions prefs claude-usage-panel@fschmutz.github.io
```

- **Refresh interval** - minutes between polls (default 10).
- **Top bar shows** - worst limit or current session.
- **Limit-crossing alerts** - notify at 90% / 100%.
- **Show session cost** - optional local [`ccusage`](https://github.com/ryoppippi/ccusage)
  cost (needs Node.js / `npx`).
- **Today's sessions** - toggle the dropdown list of today's sessions (biggest
  token spender first, click to resume one in a terminal), plus the **Terminal**
  to open. Empty means autodetect: `$TERMINAL`, then ghostty, kitty, wezterm,
  alacritty, foot, gnome-terminal, konsole, tilix, xfce4-terminal, xterm.
- **Session pings** - schedule the one-turn `claude` ping that opens the 5-hour
  window (on/off, times, weekdays, working day, **Suggest times**, coverage,
  last ping). It writes the same systemd user units as
  `./install.sh sessionping`, so the CLI and this dialog stay one schedule.
- **Cursor (optional)** - toggle + Admin API key (create one at cursor.com →
  your team → Settings → Admin API). Calls `api.cursor.com` (`/teams/spend`,
  `/teams/filtered-usage-events`) and shows the billing-cycle spend, today's
  spend, and the top spender - with a colored % gauge when the team has a
  monthly spend limit set. Cursor is usage-based, so it shows spend rather than
  a percentage otherwise. Off by default; the key is stored in the system keyring (libsecret).

## Updating

Installing from a checkout also schedules a **daily update check** (the
`autoupdate` target - a systemd user timer), so new releases install themselves;
you still need to log out / back in for the shell to load the new code. By hand:

```bash
./install.sh update --pull      # git pull, then reinstall whatever you have
```

then log out / back in (Wayland). `./install.sh --uninstall gnome` removes it,
`./install.sh --uninstall autoupdate` stops the daily check.

## Developing

Wayland can't hot-reload an extension. Test in a nested shell:

```bash
dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800 --unsafe-mode --wayland
```

The pure logic lives in `lib/pure.js` (unit-tested under plain `node`, parity
with the other ports enforced by `tests/parity.test.js`); `extension.js` and
`lib/claudeUsage.js` are the Shell/network layer. See [CONTRIBUTING.md](../CONTRIBUTING.md).
