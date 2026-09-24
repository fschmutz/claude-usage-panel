# Contributing

Thanks for your interest! This repo hosts four clients over one data model: a
GNOME Shell extension (GJS), a native macOS SwiftUI app, a Node status line for
the Claude Code prompt and an MCP server, plus the `claudectl` CLI.

## Setup

```bash
pipx install pre-commit
pre-commit install
```

`pre-commit` runs ESLint, `swift-format`, shellcheck, shfmt, markdownlint,
gitleaks, `actionlint`, `zizmor`, the em-dash ban, the private-names guard, the
version-drift check and the i18n catalog check (full list:
`.pre-commit-config.yaml`) - the same set runs in CI on every push, as the
`lint` job.

## CI: one required check

All gates live in `.github/workflows/ci.yml`. The job named **`ci-gate`** fans
every other job in and is the only status check the branch ruleset requires, so
adding or renaming a job never needs a branch-protection change.

To add a gate: add the job, then add its id to `needs:` in `ci-gate`. Nothing
else. Workflows must keep their actions pinned to a commit SHA (never a tag)
and `persist-credentials: false` on every checkout - `zizmor` fails the build
otherwise. The workflow-level `permissions:` grants no write scope (`{}` or
read-only); a write is declared on the one job that needs it -
`tests/docs.test.js` fails the build otherwise, since zizmor does not.

If you open the PR from a fork, a maintainer has to approve the first CI run;
after that your PRs run automatically. Push with an email that is registered on
your GitHub account, otherwise the commit counts as unattributed and needs an
extra approval. Full details: the [CI](https://github.com/fschmutz/claude-usage-panel/wiki/CI)
wiki page.

## Layout

```text
.
├── claude-usage-panel@fschmutz.github.io/   # GNOME Shell extension
│   ├── extension.js         # panel button, dropdown, alerts, sparkline
│   ├── prefs.js             # libadwaita preferences
│   └── lib/                 # I/O + UI sections; lib/pure/ is the pure contract (pure.js barrel)
├── macos/                   # native SwiftUI MenuBarExtra app (SwiftPM)
│   └── Sources/
│       ├── ClaudeUsageCore/ # Foundation-only mirror of lib/pure (tests on Linux)
│       └── ClaudeUsagePanel/# networking + UI
├── claude-code/             # the Node copy of the contract + its clients
│   ├── normalize.js · pace.js · stamps.js · accounts-contract.js   # the contract
│   ├── statusline.js        # render one condensed line from stdin
│   └── claudectl.js         # the claudectl CLI (account-cli.js · session-cli.js)
├── mcp/                     # MCP server: usage, accounts, sessions (Claude Code, Cursor…)
│   └── server.js            # zero-dep stdio JSON-RPC, also the npx bin
├── linux/                   # usage-bar.mjs: one-line usage for waybar, polybar, tmux…
├── Casks/                   # the Homebrew cask, pinned to each release
├── plugin/                  # Claude Code plugin wrapping the MCP server
├── docs/                    # GitHub Pages site + the /install bootstrap
├── wiki/                    # source of the GitHub wiki (published by wiki.yml)
├── tests/                   # node --test suites + the shared cross-port fixtures
├── scripts/                 # install/ targets · pack-gnome · auto-update · session-ping · versions
└── install.sh               # unified installer (gnome · statusline · mcp · cli · macos · autoupdate · sessionping)
```

See the [Architecture](https://github.com/fschmutz/claude-usage-panel/wiki/Architecture)
wiki page. The normalization contract has three copies (GNOME `lib/pure/usage.js`
via the `lib/pure.js` barrel, Node `claude-code/normalize.js`, macOS
`ClaudeUsageCore/Model.swift`); the status line and the MCP server import the
Node copy and are not ports of their own. `tests/parity.test.js` + its Swift
twin keep the copies identical against one shared fixture
(`tests/fixtures/normalize.json`) - change any copy and the fixture together.

## Rules

- Keep changes read-only with respect to the user's credentials.
- Never commit secrets, keys, or real usage/billing figures (gitleaks enforces this).
- One concern per commit; conventional-commit messages.
- Add/adjust the matching platform when you change shared behavior.

## Testing GNOME changes

Wayland can't hot-reload an extension. Test in a nested shell:

```bash
dbus-run-session -- gnome-shell --headless --virtual-monitor 1280x800 --unsafe-mode --wayland
```
