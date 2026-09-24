# Architecture

Four clients (GNOME extension, macOS app, status line, MCP server) over one
shared normalization contract (the API's `limits[]`). The business logic
(kinds, order, percent clamping, severity, resets) lives in **three copies**:
GNOME `lib/pure/`, the Node modules under `claude-code/` (the status line, the
MCP server and `claudectl` all import those, so they are not ports of their
own) and Swift `ClaudeUsageCore`. The copies are kept behaviorally identical
by a shared test fixture (`tests/fixtures/normalize.json`) -
`tests/parity.test.js` asserts the two JS copies, and the Swift
`NormalizeParityTests` asserts the same file.

The **burn-rate forecast** is part of the same contract: `forecast(samples,
resetsAt, now)` regresses the last 6 h of timestamped percent samples (pruned
at window resets, silent unless ≥3 samples span ≥30 min at ≥0.2%/h) into
`{pctPerHour, projectedFullAt, exhaustsBeforeReset, marginHours}`. Two JS
copies (`lib/pure/pace.js`, `claude-code/pace.js`) + the Swift one
(`Model.swift`) are pinned by `tests/fixtures/forecast.json`. The
status line and MCP server share one sample file
(`claude-usage-history.json` in a per-user scratch dir: `$XDG_RUNTIME_DIR`,
else `~/.claude`; the per-user `$TMPDIR` on macOS; never the shared `/tmp`),
keyed by account so a switch does not blend two logins' samples; GNOME and macOS persist their own
pair-form history in GSettings / UserDefaults.

**Usage against the clock** is the same idea without any history:
`clockPace(card, now)` turns a reset time into how much of the window has gone
(5 h for a session, 7 d for a weekly - the payload never says when a window
opened) and calls a card more than 5 points over that "ahead". Pinned across
the same three copies by `tests/fixtures/pace.json`.

The **durable warehouse** is the long half of the history: one JSONL line per
poll that moved, under `XDG_STATE_HOME` (Application Support on macOS), pruned
to 90 days, written by the two panels and read by everything -
`tests/fixtures/warehouse.json`. **Event hooks** (`tests/fixtures/events.json`)
detect the crossings and resets between two polls and expand the user's command
template with shell-quoted values.

**Session pings and today's sessions** are the third piece of the contract
(`tests/fixtures/sessions.json`, asserted by `tests/sessions.test.js` and the
Swift `SessionsParityTests`): the ping-stamp parser and its "last 05:30 /
yesterday 05:30" formatting, the fold of one transcript line into per-day token
totals, the ranking of today's sessions, and the `claude --resume` command
built from a session's cwd + id. The transcripts are append-only and reach
hundreds of megabytes a day, so every client folds each file **once** and
thereafter only from the byte offset it stopped at, through one shared
incremental index at `~/.cache/claude-usage-panel/sessions.json`
(`~/Library/Caches/…` on macOS): whichever client runs keeps it warm for the
others, and the status line only ever reads it.

```text
claude-usage-panel@fschmutz.github.io/   # GNOME Shell extension (GJS / ESM)
├── extension.js        # panel button, dropdown, alerts, sparkline
├── prefs.js            # libadwaita preferences
├── stylesheet.css
├── schemas/            # GSettings schema
├── po/                 # translation catalogs (compiled to locale/ at pack time)
└── lib/
    ├── pure.js         # barrel over pure/ - the one import path for the pure logic
    ├── pure/           # the reference contract, no gi imports (unit-tested under node)
    │   ├── usage.js    # normalization, severity, resets, alert thresholds, HTTP failures
    │   ├── pace.js     # clock pace + burn-rate forecast
    │   ├── cursor.js   # Cursor team-spend summary
    │   ├── warehouse.js# the 90-day history rules
    │   ├── events.js   # event-hook detection + command expansion
    │   ├── poll.js     # adaptive polling + section refresh orchestration
    │   ├── pings.js    # session-window planner
    │   ├── sessions.js # ping stamps, transcript fold, ranking, resume command, terminals
    │   ├── accounts.js # named-account rules (mirrors claude-code/accounts-contract.js)
    │   ├── snapshots.js# the claudectl snapshot summary the preferences show
    │   └── layout.js   # dropdown geometry (GNOME-only: no Swift mirror)
    ├── claudeFiles.js  # the live credentials + oauthAccount, read one way
    ├── claudeUsage.js  # /oauth/usage fetch (live or saved token)
    ├── accounts.js     # the account store's GJS I/O
    ├── accountsSection.js # the dropdown's Accounts rows
    ├── cost.js         # optional ccusage cost (subprocess)
    ├── cursorUsage.js  # optional Cursor Admin API spend
    ├── cursorSection.js# the dropdown's Cursor section
    ├── secretStore.js  # the Cursor key in the system keyring
    ├── sessionIndex.js # incremental fold of ~/.claude/projects → today's sessions
    ├── sessionsSection.js # the dropdown's today's-sessions rows + terminal launch
    ├── sessionPing.js  # reads/writes the systemd units + the last-ping stamp
    ├── sessionPingUnit.js # the unit text itself (pure, shared with install.sh)
    ├── snapshots.js    # reads the claudectl snapshot store for the preferences
    ├── warehouse.js    # the 90-day history file I/O
    ├── usageCard.js    # one limit row of the dropdown
    ├── bar.js          # progress bar + clock caret, sized from their allocation
    ├── headerBar.js    # the dropdown's top row and its icon buttons
    ├── tooltip.js      # hover titles for those buttons
    ├── widgets.js      # small St helpers shared by the sections
    ├── http.js         # one promise around Soup
    ├── proc.js         # one promise around Gio.Subprocess
    ├── fs.js           # read + atomic write
    └── paths.js        # every on-disk path the extension uses

macos/                  # native SwiftUI MenuBarExtra app (SwiftPM)
└── Sources/
    ├── ClaudeUsageCore/          # Foundation-only mirror of pure.js (tests on Linux)
    │   ├── Model.swift               # normalization, pace, forecast
    │   ├── CursorModel.swift         # Cursor spend math
    │   ├── Accounts.swift            # named-account rules
    │   ├── Warehouse.swift           # the 90-day history rules
    │   ├── EventHooks.swift          # event-hook detection + expansion
    │   ├── Sessions.swift            # ping stamps, transcript fold, ranking, resume
    │   ├── SessionPing.swift         # the launchd plist text (twin of sessionPingUnit.js)
    │   ├── WindowPlanner.swift       # session-window planner (twin of pure/pings.js)
    │   ├── Snapshots.swift           # the claudectl snapshot summary
    │   ├── HttpFailure.swift         # usage-endpoint error bodies, transient statuses
    │   ├── ShellQuote.swift          # POSIX single-quoting
    │   ├── DataProvenance.swift      # official vs estimated figures
    │   ├── UpdateStatus.swift        # parsed `auto-update.sh --status --json`
    │   ├── ReleaseTags.swift         # newest released tag from the smart-HTTP ref list
    │   ├── NotifyScript.swift        # the osascript argv for one notification
    │   ├── Countdown.swift           # the "Resets in 3h 05m" countdown + sparkline
    │   └── PlanLabel.swift           # header plan label from the credentials (twin of pure/usage.js planLabel, pinned by tests/fixtures/plan-label.json)
    └── ClaudeUsagePanel/
        ├── ClaudeUsagePanelApp.swift # the App + MenuBarExtra scene, palette
        ├── UsageModel.swift          # the view model
        ├── PopupView.swift           # the popup's views
        ├── SettingsView.swift        # the Settings window
        ├── Usage.swift               # usage fetch
        ├── Cost.swift                # ccusage via Process
        ├── Cursor.swift              # Cursor Admin API
        ├── KeychainStore.swift       # the Cursor key in the login Keychain
        ├── Accounts.swift            # accounts in the model, manual + auto switch
        ├── AccountStore.swift        # the account store's I/O (file + Keychain)
        ├── AccountsView.swift        # accounts in the popup and Settings
        ├── Sessions.swift            # the same index + the terminal launch (osascript)
        ├── SavedSessions.swift       # the claudectl snapshot store in Settings
        ├── SessionPing.swift         # the launchd agent (twin of the systemd units)
        ├── SessionPingSettings.swift # session pings as the UI sees them
        ├── LaunchAgent.swift         # what the two launchd agents share
        ├── LoginItem.swift           # start at login (SMAppService)
        ├── Updates.swift             # update status for Settings
        ├── UpdateState.swift         # when to re-check it
        └── Shell.swift               # the one way the app runs a child process

claude-code/            # the Node clients (installed together under ~/.claude/claude-usage-panel/)
├── statusline.js       # status line: renders from Claude Code's stdin - no network
├── transcript-tokens.js# a transcript's token totals + their incremental on-disk cache
├── normalize.js        # the Node copy of the normalizer (shared by mcp + accounts)
├── pace.js             # clock pace + burn-rate forecast + the shared sample history
├── stamps.js           # timestamp parsing and the "3h06m" / "yesterday 05:30" formats
├── paths.js            # every state/cache/config path, derived from one `io`
├── accounts-contract.js# the pure account rules (mirrors lib/pure/accounts.js 1:1)
├── accounts.js         # openStore(io): the account store - save, switch, refresh, usage
├── login-usage.js      # which login's usage, and how its auth failure is labelled
├── tabs.js             # openTabs(io): running sessions, snapshots, autosave, the launch
├── terminals.js        # the panels' terminal setting + how each terminal gets a tab per session
├── layout.js           # which window and tab each session sits in (tmux, kitty, WezTerm, iTerm, Terminal.app)
├── tools.js            # finding and querying tmux / ps / osascript from a scheduler's minimal PATH
├── account-cli.js      # `claudectl account`: the CLI over the account store
├── session-cli.js      # `claudectl session`: the CLI over tabs.js
└── claudectl.js        # the claudectl entry point: dispatches to the two groups

mcp/                    # MCP server (Claude Code, Cursor…)
├── server.js           # stdio JSON-RPC transport + get_usage; also the npx bin
├── tools.js            # tool schemas, renderers, the account tool calls
├── sessions.js         # today's sessions + session-ping index
└── warehouse.js        # the 90-day usage history reader

linux/usage-bar.mjs     # one-line usage for any bar (waybar, polybar, i3blocks…)
Casks/                  # the Homebrew cask, pinned to each release
plugin/                 # Claude Code plugin wrapping the MCP server
docs/                   # GitHub Pages site + the /install bootstrap
install.sh              # installer entrypoint: argument loop + dispatch
scripts/install/        # one file per target, sourced by install.sh
├── ui.sh               # info/ok/skip/act and the --dry-run wrapper
├── scheduler.sh        # the systemd-timer / launchd-agent / cron triple, once
└── gnome.sh macos.sh node.sh cli.sh autoupdate.sh sessionping.sh targets.sh
scripts/auto-update.sh  # daily: newest released tag → ff-only → install.sh update
scripts/session-ping.sh # scheduled: 1-turn haiku ping so the 5h window opens on time
scripts/lib.sh          # log/say/die/lock, shared by the two standalone workers
scripts/pack-gnome.sh   # assemble the extension dir (install.sh gnome + the release zip)
scripts/json-edit.mjs   # the one JSON reader/writer install.sh drives
scripts/version-sites.sh# every place the version is written, read by bump + check
```

## Staying current

`scripts/auto-update.sh` is the daily worker; the `autoupdate` install target only
schedules it (systemd user timer · launchd agent · cron). It compares the highest
released `vX.Y.Z` tag on `origin` against the **deployed** version (the
`installed-version` stamp every successful `install.sh` writes, never the
checkout's `package.json`), and on a newer one does `merge --ff-only` **to that
tag** + `install.sh update` - which reinstalls only the targets already
installed. Every other situation (dirty worktree, diverged or detached branch, no
remote, offline, lock held) is a logged skip, never a modification. So **a release
reaches users when its tag is pushed**, not when `main` moves.

Three state files under `<state dir>/claude-usage-panel` carry that decision
between runs, and all three are written by `install.sh`, not only by the daily
job: `installed-version` (what the clients run), `checkout-path` (where the
checkout is, so the extension's copy of the worker and the macOS app can find
it without a scheduled job) and `update-pending` (a reinstall that was owed and
did not finish - retried until it does). The GNOME extension adds
`loaded-version` at enable(), which is how `--status` can say "installed 2.2.0,
running 2.1.0 - log out and back in" instead of "up to date".

## Data source

`GET https://api.anthropic.com/api/oauth/usage` with the local OAuth token and the
`anthropic-beta: oauth-2025-04-20` header. The response's `limits[]` array (kind / percent /
severity / resets_at / scope.model) drives one card per limit. Everything is read-only with
respect to the credentials. The status line is the exception: it renders only from what Claude
Code pipes on stdin - no credentials, no network.

## Quality

`pre-commit` runs locally and in CI on every push (the `lint` job). The hook list lives in
[`.pre-commit-config.yaml`](https://github.com/fschmutz/claude-usage-panel/blob/main/.pre-commit-config.yaml);
beyond the file-hygiene set it runs `gitleaks`, `private-names` + `private-names-message`,
`eslint`, `shellcheck`, `shfmt`, `markdownlint`, `actionlint`, `zizmor`, `no-em-dash`,
`swift-format`, `check-versions`, `file-size` (the 700-line ceiling) and `i18n-catalogs`. `npm test` + `swift test` cover the
pure logic and the cross-port parity contract; the rest of CI is on [[CI]].
