<div align="center">

# Claude Usage Panel

**See your Claude Code plan usage at a glance — in the GNOME top bar, the macOS menu bar, or right under your Claude Code prompt.**

Session, weekly, and **per-model** limits (Fable, Opus…) — the same numbers as `/usage`, always visible, auto-refreshing. Plus an optional **Cursor** team-spend section.

![GNOME Shell 45–50](https://img.shields.io/badge/GNOME%20Shell-45--50-4A86CF?logo=gnome&logoColor=white)
![macOS 13+](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white)
![Swift 6.1](https://img.shields.io/badge/Swift-6.1-F05138?logo=swift&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-3DA639)
![pre-commit](https://img.shields.io/badge/pre--commit-enabled-FAB040?logo=pre-commit&logoColor=white)
![Read-only](https://img.shields.io/badge/credentials-read--only-2ea44f)

<img src="docs/screenshot.png" alt="Claude Usage Panel dropdown: session, weekly, and per-model Fable limits with sparklines and an optional Cursor section" width="380">

</div>

---

## Contents

- [Why this one](#why-this-one)
- [Features](#features)
- [Screenshots](#screenshots)
- [Install — GNOME (Linux)](#install--gnome-linux)
- [Install — macOS](#install--macos)
- [Install — Claude Code status line](#install--claude-code-status-line)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Cursor (optional)](#cursor-optional)
- [Privacy](#privacy)
- [Development](#development)
- [Roadmap](#roadmap)
- [License](#license)

## Why this one

Most Claude usage indicators read the endpoint's legacy `five_hour` / `seven_day`
fields and show only the aggregate session + weekly pair. This one reads the
modern **`limits[]` array**, so it shows **every** limit the Claude app shows —
including **per-model weekly limits** (Fable, Opus…) that the others miss — on
**both Linux and macOS**, with native UI on each (no Electron).

## Features

| | |
|---|---|
| 📊 **All plan limits** | Session, weekly (all models), and per-model (Fable, Opus…) — one card each |
| 🎨 **Severity colors** | normal / warning / **critical**, straight from the API — reflected in the top-bar glyph too |
| 🔔 **Limit-crossing alerts** | Desktop notification when any limit first hits 90% or 100% |
| 📈 **Usage sparkline** | A tiny history graph per limit so you see the trend |
| ⏳ **Reset timers** | `Resets in 3h 06m`, `Resets in 4d 2h` |
| 💲 **Optional session cost** | Computed locally via [`ccusage`](https://github.com/ryoppippi/ccusage) |
| 🟣 **Optional Cursor spend** | Team cycle spend / today / top spender via the Cursor Admin API |
| 🔒 **Read-only & private** | Uses your existing local token, never writes it, talks only to `api.anthropic.com` |
| 🖥️ **Cross-platform** | Native GNOME Shell extension **and** native SwiftUI menu-bar app |
| ⌨️ **Terminal status line** | Optional condensed one-line view **under the Claude Code prompt** — zero-dependency Node |

## Screenshots

| Dropdown | Settings |
|---|---|
| <img src="docs/screenshot.png" alt="Dropdown" width="360"> | <img src="docs/settings.png" alt="Settings" width="360"> |

## Install — GNOME (Linux)

From source:

```bash
git clone https://github.com/fschmutz/claude-usage-panel.git
cd claude-usage-panel
./install.sh
```

`install.sh` copies the extension, compiles its schema, clears the global
`disable-user-extensions` switch if set, and enables it to auto-start on every
login. Then **log out and back in** (Wayland loads new extensions only at login)
and confirm:

```bash
gnome-extensions info claude-usage-panel@fschmutz.github.io   # State: ACTIVE
```

Or from a packaged release:

```bash
# download the .shell-extension.zip from the Releases page, then:
gnome-extensions install --force claude-usage-panel@fschmutz.github.io.shell-extension.zip
```

> An extensions.gnome.org listing is planned — see [PUBLISHING.md](PUBLISHING.md).

## Install — macOS

```bash
cd macos
swift run          # icon appears in the menu bar
```

`macos/build-app.sh` produces a distributable `ClaudeUsagePanel.app` (menu-bar
agent, no Dock icon). Full details, release build, notarization, and a Homebrew
cask template are in [macos/README.md](macos/README.md) and [PUBLISHING.md](PUBLISHING.md).

### Requirements

- **Linux:** GNOME Shell 45–50
- **macOS:** 13 Ventura or later (Xcode 15+ / Swift toolchain)
- An active Claude Code login (see [How it works](#how-it-works) for where the token lives)
- Optional, for cost: Node.js / `npx`, or a global `ccusage`

## Install — Claude Code status line

Prefer it in the terminal? A tiny status line renders your usage **right under
the Claude Code prompt input** — the same numbers, without leaving your session:

```text
Context ▌░░░░░ 8%  Session █▌░░░░ 26% 59m  Week █▌░░░░ 24%  Fable █▊░░░░ 29% 1d18h
```

Each limit gets a compact gauge, filled **green / yellow / red** by the API's own
severity, a matching gauge for the session's context-window usage, and reset
countdowns — the session's own, plus the shared weekly reset shown once after the
weekly limits. It renders on its own row above Claude Code's mode badges (which
it leaves untouched); Claude Code left-anchors the row, so indent it with the
settings `padding` field if you like. Install it with:

```bash
cd claude-code
./install.sh
```

`claude-code/install.sh` copies the script into `~/.claude`, then merges a
`statusLine` entry into `~/.claude/settings.json` — other settings are left
untouched and re-running is safe. Open a new session or run `/statusline` to see
it. Manual setup and details are in [claude-code/README.md](claude-code/README.md).

Needs only Node.js (already present — Claude Code runs on it) and an active
Claude Code login.

## Settings

<img src="docs/settings.png" alt="Preferences window" width="420">

- **Refresh interval** — minutes between polls (default 10).
- **Top bar shows** — worst limit or current session.
- **Limit-crossing alerts** — notify at 90% / 100%.
- **Show session cost** — enable local `ccusage` cost.
- **Cursor (optional)** — toggle + Admin API key.

GNOME: open via the dropdown's **Settings**, or
`gnome-extensions prefs claude-usage-panel@fschmutz.github.io`.
macOS: quick toggles live in the dropdown, and a full **Settings** window
(⌘, or the dropdown's **Settings…**) holds the same options including Cursor.

## How it works

The panel reads the OAuth access token that Claude Code already stores locally
and calls the official usage endpoint:

```text
GET https://api.anthropic.com/api/oauth/usage
    authorization: Bearer <token>
    anthropic-beta: oauth-2025-04-20
```

The response contains a `limits[]` array — one entry per active limit, each with
a `percent`, a `severity`, a `resets_at`, and an optional model `scope`. The
panel renders one card per limit.

**Where the token lives:** `~/.claude/.credentials.json` on Linux; the **login
Keychain** on macOS (the app reads it via `security find-generic-password`). If
the token expires, the panel prompts you to run any Claude Code command (which
refreshes it) — it never writes the token itself.

## Cursor (optional)

Enable **Show Cursor usage** and paste a Cursor **Admin API key** (create one at
cursor.com → your team → Settings → Admin API). The panel calls
`api.cursor.com` (`/teams/spend`, `/teams/filtered-usage-events`) and shows the
billing-cycle spend, today's spend, and the top spender. Cursor is usage-based,
so it shows spend rather than a percentage gauge. Off by default; the key is
stored locally in dconf.

## Privacy

Read-only with respect to your credentials. One outbound request per refresh, to
Anthropic's official API, with your own token. No telemetry, no third parties.
Cost (when enabled) runs `ccusage` locally against `~/.claude/projects/*.jsonl`.
Cursor (when enabled) calls `api.cursor.com` with your own admin key.

## Development

Quality is enforced by [pre-commit](https://pre-commit.com) and the same set
runs in CI on every push:

```bash
pipx install pre-commit
pre-commit install
pre-commit run --all-files
```

Hooks: ESLint (GJS), `swift-format` (Swift), shellcheck + shfmt (shell),
markdownlint (docs), gitleaks (secret scan), plus JSON/XML/whitespace checks.

```text
.
├── claude-usage-panel@fschmutz.github.io/   # GNOME Shell extension
│   ├── extension.js         # panel button, dropdown, alerts, sparkline
│   ├── prefs.js             # libadwaita preferences
│   └── lib/                 # claudeUsage.js · cost.js · cursorUsage.js
├── macos/                   # native SwiftUI MenuBarExtra app (SwiftPM)
│   └── Sources/ClaudeUsagePanel/
└── claude-code/             # Node status line for the Claude Code prompt
    ├── statusline.js        # fetch + render one condensed line
    └── install.sh           # merge statusLine into ~/.claude/settings.json
```

## Roadmap

- [x] Cursor spend **gauge** — shows a colored `%` bar when the team has a monthly spend limit set (falls back to spend text otherwise)
- [ ] extensions.gnome.org listing *(needs a GNOME store account — [PUBLISHING.md](PUBLISHING.md))*
- [ ] Notarized macOS `.app` + Homebrew cask *(needs an Apple Developer signing cert)*

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center"><sub>

Keywords: Claude Code usage monitor · Claude usage GNOME Shell extension · Claude plan limits top bar · macOS menu bar Claude usage · Claude Code status line usage · Anthropic usage API · ccusage · Fable / Opus per-model weekly limit · Cursor Admin API spend · Ubuntu GNOME extension · SwiftUI MenuBarExtra

</sub></div>
