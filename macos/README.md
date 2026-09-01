# Claude Usage Panel - macOS

A native SwiftUI menu-bar app (`MenuBarExtra`) that mirrors the GNOME extension:
Claude Code plan limits (session / weekly / per-model like **Fable**) in the
macOS menu bar, with a designed dropdown, severity colors, reset timers, and
optional session cost via `ccusage`.

Same data source as the GNOME version - reads the local Claude Code OAuth token
(read-only) and calls `https://api.anthropic.com/api/oauth/usage`. On macOS the
token lives in the **login Keychain** (Claude Code stores it there, not in a
file), so the app reads it via `security find-generic-password`; it falls back
to `~/.claude/.credentials.json` if present. The first read may prompt for
Keychain access - click **Always Allow**.

## Settings

Quick toggles (Cost, Alerts, Refresh) sit in the dropdown. A full **Settings**
window (⌘, or the dropdown's **Settings…** button) holds every option:
**Today's sessions** (list today's biggest token spenders in the dropdown, and
which terminal - Automatic / Terminal / iTerm - a resume click opens),
**Session pings** (schedule, suggested times, coverage, and when a ping last
fired), Updates, and the optional **Cursor** team-spend section (toggle + Admin
API key). Preferences persist via `UserDefaults`; the session-ping schedule
lives in the launchd agent it shares with `./install.sh sessionping`.

## Requirements

- macOS 13 Ventura or later
- Xcode 15+ **or** the Swift toolchain (`swift --version`)
- An active Claude Code login (`~/.claude/.credentials.json` present)
- Optional, for cost: Node.js / `npx` (or a global `ccusage`)

## Build & run

```bash
cd macos
swift run          # builds and launches; icon appears in the menu bar
```

For a reusable `.app` bundle, run the unified installer from the repo root
(its version is read from `package.json`):

```bash
./install.sh macos          # build, install to /Applications, launch
```

Upgrades take care of themselves: installing from a checkout also schedules a
daily update check (a launchd agent, the `autoupdate` target), which rebuilds and
relaunches the app when a new release is tagged. By hand it's `./install.sh
update` (or `update --pull`) - it quits the running app, replaces it in
`/Applications`, and relaunches the new build. `./install.sh --uninstall
autoupdate` turns the daily check off.

Or a bare release binary / Xcode:

```bash
swift build -c release      # binary at .build/release/ClaudeUsagePanel
```

Or open the folder in Xcode (`File ▸ Open ▸ macos/`) and Run.

### Start at login

`./install.sh macos` sets this up for you: on first launch the app registers
itself as a login item via `SMAppService` (macOS 13+). Toggle it any time under
**Settings ▸ Start at login**, or remove it in System Settings ▸ General ▸
Login Items. The app is an "accessory" (no Dock icon), so it lives only in the
menu bar. (If you ran a bare `swift run` / binary instead, add it manually via
Login Items ▸ **+**.)

## Layout

| File | Role |
|---|---|
| `Sources/ClaudeUsagePanel/Usage.swift` | token read + endpoint fetch + `limits[]` normalization |
| `Sources/ClaudeUsagePanel/Cost.swift` | optional `ccusage` cost via `Process` |
| `Sources/ClaudeUsagePanel/ClaudeUsagePanelApp.swift` | `MenuBarExtra` app, view model, designed cards, Quit |

## Notes

- The menu bar title shows the worst limit, e.g. `✳ Fable 100%`.
- A per-model card (Fable) is a sub-cap of the weekly all-models pool - that
  usage also counts toward the weekly limit and shares its reset - so the card
  says "Share of the weekly all-models limit" under the countdown.
- Toggle **Cost** and change the **Refresh** interval directly in the dropdown;
  both persist via `UserDefaults`.
- **Quit** terminates the app. Remove it from Login Items to stop it starting
  at login.
- Read-only w.r.t. credentials; one request per refresh to Anthropic's API with
  your own token. No telemetry.

> Note: this app was authored on Linux and has **not** been compiled on a Mac
> yet - build it once with `swift run` and report any type errors. The data
> layer is a direct port of the verified GNOME logic.
