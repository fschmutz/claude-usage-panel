# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Four native clients that surface Claude Code plan-usage limits from the official
Anthropic usage endpoint: a **GNOME Shell extension**, a **macOS SwiftUI menu-bar
app**, a **Node status line** for under the Claude Code prompt, and an **MCP
server** (`mcp/server.js`) exposing a `get_usage` tool to Claude Code / Cursor
(installable as a Claude Code plugin from `.claude-plugin/marketplace.json` +
`plugin/`, or via `npx -y github:fschmutz/claude-usage-panel` - package.json has
a `bin` entry). All read a locally-stored OAuth token read-only and render the
same `limits[]` data. An optional Cursor team-spend section is available in the
two desktop clients.

## Commands

```bash
# JS unit tests (GNOME lib + status line) - the primary test gate
npm test                          # node --test tests/*.test.js
node --test tests/pure.test.js    # single file
node --test --test-name-pattern="sparkline" tests/pure.test.js  # single test

# Swift core unit tests (runs on Linux CI too - no macOS needed)
cd macos && swift test

# Lint / format everything (same set runs in CI on every push, as the `lint` job)
pre-commit run --all-files
pre-commit run eslint --all-files   # single hook
pre-commit run zizmor --all-files   # workflow security audit (actionlint = validity)

# Install - one unified entrypoint for all clients (also reachable with
# curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash [-s -- target…])
./install.sh                 # auto-detect OS → install the sensible set
./install.sh gnome           # GNOME extension only → then log out/in (Wayland)
./install.sh statusline      # status line → merges into ~/.claude/settings.json
./install.sh mcp             # MCP server → claude mcp add + ~/.cursor/mcp.json
./install.sh macos           # build macos/ClaudeUsagePanel.app
./install.sh autoupdate      # schedule the daily update check (systemd timer / launchd / cron)
./install.sh update [target...]        # reinstall installed targets (upgrade); --pull to git pull first
./install.sh --uninstall [target...]   # reverse it   |   --list (detected + installed)   |   -h
./install.sh --dry-run [target...]     # print actions without touching anything

# Screenshots are GENERATED - after any UI-visible contract change:
node scripts/screenshots/render.mjs          # rewrites docs/screenshot.svg + og.svg
node scripts/screenshots/render.mjs --check  # what CI runs; exits 1 on drift

# Release: bump the version everywhere from one source of truth
./scripts/bump-version.sh 1.4.0

# Daily auto-update worker (what the timer runs) - safe to run by hand
./scripts/auto-update.sh --status    # installed vs newest released tag, last check
./scripts/auto-update.sh --check     # check only; exit 10 = update available
```

Auto-update reads the highest released `vX.Y.Z` tag on `origin`, so **a release
only reaches users once the tag is pushed** - bumping `package.json` on main is
not enough. It only ever `merge --ff-only`s, and skips a dirty, diverged or
detached checkout rather than touching it; `tests/autoupdate.test.js` asserts
each of those guards against a throwaway local bare remote (offline).

There is **no build step for the GNOME extension or the status line** - they run
the source files directly. `npm` is only a test runner; there are no runtime deps.

## CI - one required check, never edit branch protection

Every gate is a job in `.github/workflows/ci.yml`. The `ci-gate` job `needs:`
all of them and is the **only** context the branch ruleset requires.

**To add a gate: add the job, add its id to `ci-gate`'s `needs:`. Never add a
required status check to the ruleset.** A required context that names a
specific job goes stale the moment that job is renamed or disabled, and a
stale context blocks every PR forever with nothing red to point at - which is
exactly what happened here with CodeQL's `analyze` job. `ci-gate` also runs
`if: always()` on purpose: a skipped required check reports neutral, which
GitHub counts as a pass, so without it a failed dependency would wave the PR
through.

Workflow rules, enforced by `zizmor` in pre-commit (it will fail the build):
actions pinned to a full commit SHA with the version in a trailing comment
(Dependabot maintains both), `persist-credentials: false` on every checkout,
`permissions:` at job level with `{}` at workflow level.

CodeQL runs via **default setup**, not a workflow file - do not create one, it
would be auto-disabled and become a dead file. Its PR check is neutral by
design and is deliberately not part of `ci-gate`.

Fork PRs need a one-time maintainer approval per new contributor
(`fork-pr-contributor-approval: first_time_contributors`) - keep that setting.
Diagnosing a `BLOCKED` PR whose checks are all green, and the rest of the
process: `wiki/CI.md`.

## Architecture - one contract, three ports

The load-bearing idea: **all business logic is pure and duplicated across
languages, kept behaviorally identical by a shared test contract.** When you
change normalization, severity, sparkline, reset-formatting, or Cursor
summarization, you must change it in **every** port and keep them matching.

- **`claude-usage-panel@fschmutz.github.io/lib/pure.js`** - GNOME pure logic. No
  `gi`/GJS imports so it runs under plain `node` for tests. This is the reference
  implementation.
- **`macos/Sources/ClaudeUsageCore/Model.swift`** (+ `CursorModel.swift`) -
  Foundation-only mirror of `pure.js`. No networking/SwiftUI, so it unit-tests on
  Linux CI. Comment in the file explicitly says "Mirrors the GNOME extension's
  lib/pure.js" - keep it that way.
- **`claude-code/statusline.js`** - standalone, zero-dependency Node; re-derives
  the same normalization for the terminal one-liner.
- **`mcp/server.js`** - standalone, zero-dependency Node MCP server (stdio
  JSON-RPC); duplicates `normalizeUsage` as the fourth port and is asserted
  against the shared fixture in `tests/parity.test.js`. Carries an exported
  `VERSION` const kept in sync by `scripts/bump-version.sh` and guarded by
  `scripts/check-versions.sh` (with `plugin/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`).

**Parity is CI-enforced.** `tests/fixtures/normalize.json` is one shared set of
raw payloads + expected core output; `tests/parity.test.js` runs it through both
JS ports and the Swift `NormalizeParityTests` runs it through `UsageNormalizer`.
Change any normalizer and update the fixture - a drifting port goes red. Labels
are intentionally per-port (compact in the terminal) and are *not* asserted.

The normalization contract (must stay identical across ports):

- Prefer the modern `limits[]` array; fall back to legacy `five_hour`/`seven_day`
  utilization fields only when `limits[]` is absent/empty.
- `KIND_ORDER` / `kindOrder` defines card sort order; per-model limits get a
  `label · <model display_name>` suffix and a `kind:model` composite key.
- Every card carries `group` (from the payload's `group`, else derived from the
  kind prefix: `weekly_*` → `weekly`) and `scoped` (a per-model limit). A scoped
  limit is a **sub-cap of its group's pool, not a pool of its own** - Fable
  usage also moves `weekly_all` and shares its reset (verified live
  2026-07-26 + the Fable-5 help-center page: on Max up to 50% of the weekly
  allowance may go to Fable). Two consequences all ports implement: a scoped
  card with a null `resets_at` inherits the pooled card's reset (the API fills
  the scoped one only after that model is used in the window), and `poolNote()`
  returns the "share of the weekly all-models limit" sub-line the UIs render.
- `clampPercent` → 0..100 int; `severity` comes straight from the API
  (normal/warning/critical) and also drives the top-bar glyph color.
- `alertThreshold` buckets to 0/90/100 for limit-crossing notifications.
- `forecast(samples, resetsAt, now)` - burn-rate projection from timestamped
  [epochMs, percent] samples: weighted regression over the last 6 h, pruned at
  window resets, silent unless ≥3 samples span ≥30 min and pace ≥0.2%/h.
  Returns {pctPerHour, projectedFullAt, exhaustsBeforeReset, marginHours};
  `tests/fixtures/forecast.json` pins all four ports (values chosen away from
  rounding boundaries so double math agrees across JS and Swift - keep new
  cases that way). Drives the card sub-line, the predictive top-bar tint, a
  once-per-window exhaustion alert (fires at margin ≤ −1 h, re-arms at ≥ +2 h),
  the status line's "⚠full …" marker, and the MCP `pace` field. The status
  line + MCP share `$TMPDIR/claude-usage-history.json`; GNOME/macOS persist
  pair-form history in GSettings/UserDefaults (bare-percent entries from old
  versions migrate as [0, p] and are ignored by the forecast).

### Platform layer (thin, wraps the pure core)

- GNOME: `extension.js` (panel button, dropdown, alerts, sparkline), `prefs.js`
  (libadwaita), `lib/claudeUsage.js` + `lib/cursorUsage.js` + `lib/cost.js` do
  the I/O (Soup HTTP, subprocess), settings via GSettings schema in `schemas/`.
- macOS: `Sources/ClaudeUsagePanel/` (App, Usage, Cursor, Cost) is the
  networking + `MenuBarExtra` UI over `ClaudeUsageCore`.

### Data source (identical for all clients)

```text
GET https://api.anthropic.com/api/oauth/usage
    authorization: Bearer <token>
    anthropic-beta: oauth-2025-04-20
```

Token location: `~/.claude/.credentials.json` on Linux; the **login Keychain** on
macOS (read via `security find-generic-password`). Clients **never write the
token** - on expiry they tell the user to run any Claude Code command to refresh.
Cost (optional) shells out to `ccusage`; Cursor (optional) calls `api.cursor.com`
with the user's Admin API key.

## Conventions

- **The GitHub wiki is generated** - its source of truth is `wiki/*.md` in this
  repo, auto-published to `<repo>.wiki.git` by `.github/workflows/wiki.yml`
  (`scripts/wiki-sync.sh`) on every push to main touching `wiki/**`. Never
  clone or edit the wiki repo directly; the sync overwrites it.

- ESLint runs with `--max-warnings=0`; Swift with `swift format lint --strict`.
  Shell is shellcheck + shfmt (`-i 4 -ci`). All gated by pre-commit **and** CI.
- Bump `version` in `package.json`, `version-name` in `metadata.json`, and update
  `CHANGELOG.md` together when releasing (see `PUBLISHING.md`). `package.json` is
  the single source of truth for the macOS bundle version - `install.sh macos`
  reads it into the `Info.plist`; do not hardcode a version anywhere else.
- Any logic change needs its matching unit test in `tests/*.test.js` and/or
  `macos/Tests/ClaudeUsageCoreTests/` - the ports are only kept in sync because
  the tests assert the same behavior.
