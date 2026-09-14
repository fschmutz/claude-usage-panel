# Architecture

Four ports over one shared normalization contract (the API's `limits[]`).
The business logic (kinds, order, percent clamping, severity, resets) is
deliberately duplicated per port and kept behaviorally identical by a shared
test fixture (`tests/fixtures/normalize.json`) - `tests/parity.test.js` asserts
the two JS ports, and the Swift `NormalizeParityTests` asserts the same file.

The **burn-rate forecast** is part of the same contract: `forecast(samples,
resetsAt, now)` regresses the last 6 h of timestamped percent samples (pruned
at window resets, silent unless ≥3 samples span ≥30 min at ≥0.2%/h) into
`{pctPerHour, projectedFullAt, exhaustsBeforeReset, marginHours}`. Three JS
copies + the Swift one are pinned by `tests/fixtures/forecast.json`. The
status line and MCP server share one sample file
(`$TMPDIR/claude-usage-history.json`); GNOME and macOS persist their own
pair-form history in GSettings / UserDefaults.

**Usage against the clock** is the same idea without any history:
`clockPace(card, now)` turns a reset time into how much of the window has gone
(5 h for a session, 7 d for a weekly - the payload never says when a window
opened) and calls a card more than 5 points over that "ahead". Pinned across
all four ports by `tests/fixtures/pace.json`.

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
├── extension.js        # panel button, dropdown, alerts, sparkline, Cursor section
├── prefs.js            # libadwaita preferences
├── stylesheet.css
├── schemas/            # GSettings schema
└── lib/
    ├── pure.js         # the reference normalization (unit-tested under node)
    ├── claudeUsage.js  # token read + /oauth/usage fetch
    ├── cost.js         # optional ccusage cost (subprocess)
    ├── cursorUsage.js  # optional Cursor Admin API spend
    ├── sessionIndex.js # incremental fold of ~/.claude/projects → today's sessions
    ├── sessionPing.js  # reads/writes the systemd units + the last-ping stamp
    └── sessionPingUnit.js # the unit text itself (pure, shared with install.sh)

macos/                  # native SwiftUI MenuBarExtra app (SwiftPM)
└── Sources/
    ├── ClaudeUsageCore/          # Foundation-only mirror of pure.js (tests on Linux)
    └── ClaudeUsagePanel/
        ├── Usage.swift               # token (file + Keychain) + fetch
        ├── Cost.swift                # ccusage via Process
        ├── Cursor.swift              # Cursor Admin API
        ├── Sessions.swift            # the same index + the terminal launch (osascript)
        ├── SessionPing.swift         # the launchd agent (twin of the systemd units)
        └── ClaudeUsagePanelApp.swift # MenuBarExtra, model, views, Settings

claude-code/            # the Node clients (installed together under ~/.claude/claude-usage-panel/)
├── statusline.js       # status line: renders from Claude Code's stdin - no network
├── normalize.js        # the Node port of the normalizer (shared by mcp + accounts)
├── pace.js             # clock pace + burn-rate forecast + the shared sample history
├── stamps.js           # timestamp parsing and the "3h06m" / "yesterday 05:30" formats
├── paths.js            # every state/cache/config path, derived from one `io`
├── accounts-contract.js# the pure account rules (mirrors lib/pure/accounts.js 1:1)
├── accounts.js         # openStore(io): the account store - save, switch, refresh, usage
└── claude-account.js   # the claude-account CLI over the store

mcp/                    # MCP server (Claude Code, Cursor…)
├── server.js           # stdio JSON-RPC transport + get_usage; also the npx bin
├── tools.js            # tool schemas, renderers, the account tool calls
├── sessions.js         # today's sessions + session-ping index
└── warehouse.js        # the 90-day usage history reader

plugin/                 # Claude Code plugin wrapping the MCP server
docs/                   # GitHub Pages site + the /install bootstrap
scripts/                # bump-version · check-versions · wiki-sync · auto-update · session-ping
├── auto-update.sh      # daily: newest released tag → ff-only → install.sh update
└── session-ping.sh     # scheduled: 1-turn haiku ping so the 5h window opens on time
install.sh              # installer entrypoint: argument loop + dispatch (~170 lines)
scripts/install/        # one file per target, sourced by install.sh
├── ui.sh               # info/ok/skip/act and the --dry-run wrapper
├── scheduler.sh        # the systemd-timer / launchd-agent / cron triple, once
├── gnome.sh macos.sh node.sh autoupdate.sh sessionping.sh targets.sh
scripts/lib.sh          # log/say/die/lock, shared by the two standalone workers
scripts/pack-gnome.sh   # assemble the extension dir (install.sh gnome + the release zip)
scripts/json-edit.mjs   # the one JSON reader/writer install.sh drives
scripts/version-sites.sh# every place the version is written, read by bump + check
```

## Staying current

`scripts/auto-update.sh` is the daily worker; the `autoupdate` install target only
schedules it (systemd user timer · launchd agent · cron). It compares the highest
released `vX.Y.Z` tag on `origin` against `package.json`, and on a newer one does
`merge --ff-only` + `install.sh update` - which reinstalls only the targets already
installed. Every other situation (dirty worktree, diverged or detached branch, no
remote, offline, lock held) is a logged skip, never a modification. So **a release
reaches users when its tag is pushed**, not when `main` moves.

## Data source

`GET https://api.anthropic.com/api/oauth/usage` with the local OAuth token and the
`anthropic-beta: oauth-2025-04-20` header. The response's `limits[]` array (kind / percent /
severity / resets_at / scope.model) drives one card per limit. Everything is read-only with
respect to the credentials. The status line is the exception: it renders only from what Claude
Code pipes on stdin - no credentials, no network.

## Quality

`pre-commit` (ESLint, swift-format, shellcheck, shfmt, markdownlint, gitleaks, actionlint,
version-drift guard) runs locally and in CI on every push; `npm test` + `swift test` cover the
pure logic and the cross-port parity contract.
