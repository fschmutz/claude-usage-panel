# Contributing

Thanks for your interest! This repo hosts a GNOME Shell extension (GJS) and a
native macOS SwiftUI app that share one data model.

## Setup

```bash
pipx install pre-commit
pre-commit install
```

`pre-commit` runs ESLint, `swift-format`, shellcheck, shfmt, markdownlint,
gitleaks, `actionlint` and `zizmor` - the same set runs in CI on every push, as
the `lint` job.

## CI: one required check

All gates live in `.github/workflows/ci.yml`. The job named **`ci-gate`** fans
every other job in and is the only status check the branch ruleset requires, so
adding or renaming a job never needs a branch-protection change.

To add a gate: add the job, then add its id to `needs:` in `ci-gate`. Nothing
else. Workflows must keep their actions pinned to a commit SHA (never a tag),
`persist-credentials: false` on every checkout, and `permissions:` declared per
job - `zizmor` fails the build otherwise.

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
│   └── lib/                 # claudeUsage.js · cost.js · cursorUsage.js · pure.js
├── macos/                   # native SwiftUI MenuBarExtra app (SwiftPM)
│   └── Sources/ClaudeUsagePanel/
├── claude-code/             # Node status line for the Claude Code prompt
│   └── statusline.js        # render one condensed line from stdin
├── mcp/                     # MCP server: get_usage tool (Claude Code, Cursor…)
│   └── server.js            # zero-dep stdio JSON-RPC, also the npx bin
├── plugin/                  # Claude Code plugin wrapping the MCP server
├── docs/                    # GitHub Pages site + the /install bootstrap
├── scripts/                 # bump-version · check-versions · wiki-sync · auto-update
└── install.sh               # unified installer (gnome · statusline · mcp · macos · autoupdate)
```

See the [Architecture](https://github.com/fschmutz/claude-usage-panel/wiki/Architecture)
wiki page. The normalization contract is duplicated per port (GNOME `lib/pure.js`,
macOS `Model.swift`, MCP `mcp/server.js`) and kept identical by
`tests/parity.test.js` + its Swift twin against one shared fixture
(`tests/fixtures/normalize.json`) - change any port and the fixture together.

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
