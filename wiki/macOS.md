# macOS app

A native SwiftUI `MenuBarExtra` app (SwiftPM, macOS 13+). Menu-bar only - no Dock icon.

## Token in the Keychain

On macOS, Claude Code stores its OAuth token in the **login Keychain**, not in
`~/.claude/.credentials.json`. The app reads it via `security find-generic-password`
(falling back to the file if present). The first read may prompt for Keychain access -
click **Always Allow**.

## Install

```bash
./install.sh macos          # from a checkout: build, install to /Applications, launch
```

Builds `ClaudeUsagePanel.app` (`LSUIElement`, no Dock icon), ad-hoc signs it, copies
it to `/Applications`, and opens it. Version comes from `package.json`.

No checkout? Every release ships the built app and a Homebrew cask pinned to it:

```bash
brew install --cask https://github.com/fschmutz/claude-usage-panel/releases/latest/download/claude-usage-panel.rb
brew upgrade --cask claude-usage-panel
```

The build is ad-hoc signed, not notarized, so the first launch needs
right-click ▸ **Open** (or `xattr -d com.apple.quarantine`). Installed that
way the app has no checkout to update from: Settings ▸ Updates says to run
`brew upgrade`, and tells you when a newer release exists. Unzipping
`ClaudeUsagePanel-macos.zip` by hand works too - the same row then offers a
**Download** button, since nothing else can update that copy.

## Start at login

On first launch the app registers itself as a login item via `SMAppService`
(macOS 13+) - like the GNOME extension auto-enables. Toggle it any time under
**Settings ▸ Start at login**, or remove it in System Settings ▸ General ▸ Login
Items. (Running a bare `swift run`/binary instead? Add it manually via Login Items.)

## Updating

A launchd agent (the `autoupdate` target, installed by default from a checkout)
checks for a new release once a day and installs it for you - see
[[Installation]]. On demand:

```bash
./install.sh update         # or: update --pull
```

Quits the running app, replaces it in `/Applications`, and relaunches the new
build - so the upgrade actually takes effect. `./install.sh --uninstall macos`
removes it; `./install.sh --uninstall autoupdate` stops the daily check.

## Signing / notarization

See [PUBLISHING.md](https://github.com/fschmutz/claude-usage-panel/blob/main/PUBLISHING.md)
for Developer ID signing, `notarytool`, and how the cask
(`Casks/claude-usage-panel.rb`) is pinned to each release.
