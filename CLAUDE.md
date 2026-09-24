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
./install.sh cli             # claudectl: `account` (named logins) + `session` (snapshot/reopen as tabs) + 30-min autosave
./install.sh macos           # build macos/ClaudeUsagePanel.app
./install.sh autoupdate      # schedule the daily update check (systemd timer / launchd / cron)
./install.sh sessionping 05:30 10:35 --days=mon-fri  # scheduled claude pings that open the 5h session window (opt-in)
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

# Session-ping worker (what the sessionping schedule runs) - safe to run by hand
./scripts/session-ping.sh --status   # configured times/days, last ping, log path
./scripts/session-ping.sh --force    # ping now, whatever the day is
```

Auto-update reads the highest released `vX.Y.Z` tag on `origin`, so **a release
only reaches users once the tag is pushed** - bumping `package.json` on main is
not enough. It only ever `merge --ff-only`s, **to that tag** and not to the
branch tip, and skips a dirty, diverged or detached checkout rather than
touching it; `tests/autoupdate.test.js` asserts each of those guards against a
throwaway local bare remote (offline).

**Every update decision reads the DEPLOYED version, never the checkout's
`package.json`.** Four files under `<state dir>/claude-usage-panel` carry it,
and `install.sh` writes the first three on every successful run - not only the
daily job: `installed-version` (what the clients run), `checkout-path` (so the
extension's copy of the worker and the macOS app find the checkout without a
scheduled job), `update-pending` (a reinstall that was owed and did not finish;
retried until it does) and `loaded-version` (written by the GNOME extension at
enable(), so a shell still running the old code is reported instead of being
called up to date). Comparing the checkout instead is what made a manual pull,
a failed reinstall or a dropped target read as "up to date" forever.

**A target that could not be reinstalled fails `install.sh update`** (`skip_fatal`
in `scripts/install/ui.sh`), so nothing is stamped and the next run retries. The
scheduler's PATH has no node on it: `installed_targets` must therefore never
need node or the `claude` CLI to answer, and the worker puts a version-manager
node back on PATH before installing. `tests/install-shape.test.js` pins all of
it in the shape an update actually runs in - a stubbed installer cannot see any
of these failures.

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

Shell changes are gated on **bash 3.2** (`bash32` job, `scripts/bash32-smoke.sh`
in a container) because that is what macOS ships as `/bin/bash`; ubuntu's bash 5
hides real traps, notably `"${arr[@]}"` on an empty array under `set -u`.

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

## Named accounts - one store, three ports

`claude-code/accounts.js` is the single implementation behind the
`claudectl account` CLI (`claude-code/account-cli.js`), the MCP server's
`list_accounts` / `save_account` / `switch_account` tools (`mcp/tools.js`) and
the status line's `account` segment - all static imports. Its pure half is the
contract; `openStore(io)` binds the I/O (home, platform, clock, fetch, exec -
every one overridable, read at call time) and returns the operations, so no
consumer threads paths around. The GNOME extension (`lib/pure/accounts.js`
pure part + `lib/accounts.js` I/O + `lib/accountsSection.js` controller) and
the macOS app (`ClaudeUsageCore/Accounts.swift` + `AccountStore.swift` +
`Accounts.swift`) mirror it; `tests/fixtures/accounts.json` pins what they
must agree on: profile validity + names, which saved profile the live login is
(uuid, then email), `tokenState` (valid / stale within 5 min of expiry /
expired once the refresh token is gone), and `autoSwitchTarget` (threshold 90,
margin 15, cooldown 5 min, most headroom wins, ties by code-point name order).

A profile is `{version, name, savedAt, account: <oauthAccount block of
~/.claude.json>, credentials: <the .credentials.json blob>}`, one `0600` file
per name under `<state dir>/claude-usage-panel/accounts/`. Invariants every
port keeps: sync the live login back into its profile (or park an unsaved one
under its email) BEFORE overwriting anything; refresh a stale target BEFORE
installing it, so a failed refresh leaves the current login untouched; refresh
writes only to our store, never to `~/.claude`; a switch writes exactly the
credentials (file, or the macOS Keychain item) and the `oauthAccount` key;
every port reads the live login from the same path (`CLAUDE_CONFIG_DIR` when
set). The panels/MCP write `<accounts dir>/.usage-cache.json` (`{at, accounts:
{NAME: {worst, session, weekly}}}`, 30 min validity) so the credential-less
status line can hint at a freer account, and every `switchTo` writes
`<accounts dir>/.last-switch.json` (`{at, from, to}`) - the auto-switch
cooldown is store state, so a switch made by the CLI, the MCP tool or the
other panel counts for everyone. The panels gate all of it behind
`accounts-enabled` (GSettings) / `accountsEnabled` (UserDefaults), **off by
default**; the status line segment is opt-in. The CLI + MCP tools are always on.

## Architecture - one contract, three ports

The load-bearing idea: **all business logic is pure and duplicated across
languages, kept behaviorally identical by a shared test contract.** When you
change normalization, severity, sparkline, reset-formatting, or Cursor
summarization, you must change it in **every** port and keep them matching.

- **`claude-usage-panel@fschmutz.github.io/lib/pure.js`** - GNOME pure logic,
  a barrel over `lib/pure/{usage,pace,cursor,warehouse,events,poll,pings,
  sessions,accounts}.js`. No `gi`/GJS imports anywhere under `pure/`, so it all
  runs under plain `node` for tests. This is the reference implementation, and
  every importer keeps importing `lib/pure.js`.
- **`macos/Sources/ClaudeUsageCore/`** - Foundation-only mirror of `pure.js`
  (`Model.swift`, `CursorModel.swift`, `Accounts.swift`, `Warehouse.swift`,
  `EventHooks.swift`, `Sessions.swift`, `SessionPing.swift`, `WindowPlanner.swift`).
  No networking/SwiftUI, so it unit-tests on Linux CI. The files say "Mirrors
  the GNOME extension's lib/pure.js" - keep it that way.
- **`claude-code/`** - the Node port, one concern per file: `normalize.js`
  (the normalizer), `pace.js` (clock pace + burn-rate forecast + the shared
  sample history), `stamps.js` (timestamp parsing/formatting), `paths.js`
  (every state/cache/config path derived from one `io`, nothing at module
  load), `accounts-contract.js` (the pure account rules, mirroring
  `lib/pure/accounts.js` 1:1), `accounts.js` (`openStore(io)`),
  `statusline.js` (renders from Claude Code's stdin), `tabs.js`
  (`openTabs(io)`: live sessions from Claude Code's `sessions/<pid>.json`
  registry, checked against `/proc` start time; the snapshot store;
  autosave; Node-only, no port to mirror), `terminals.js` (which terminal
  `session open` uses - the panels' own setting, never a separate one - and
  how it gets a tab per session; its `TERMINALS` / `terminalArgv` mirror
  `lib/pure/sessions.js`, parity in `tests/terminals.test.js`), `layout.js`
  (which window and tab each session sits in, from a precedence-ordered
  `SOURCES` table; AppleScript only on an interactive `save`, never the
  autosave; Node-only), `tools.js` (tool lookup on PATH plus Homebrew/system
  dirs, for a scheduler's minimal PATH). **One CLI, `claudectl`**:
  `claudectl.js` only dispatches `account …` to `account-cli.js` and
  `session …` to `session-cli.js`; a new command group is a new
  `<group>-cli.js` exporting `main(argv, io)` + `HELP`, never a new binary.
- **`mcp/`** - the MCP server: `server.js` is transport + `get_usage` only
  (~175 lines), `tools.js` the tool schemas / renderers / account tool calls,
  `sessions.js` the session + ping index, `warehouse.js` the 90-day history
  reader. `server.js` carries the exported `VERSION` const, bumped by
  `scripts/bump-version.sh` and guarded by `scripts/check-versions.sh` - both
  read the site list from `scripts/version-sites.sh`, so a new version site is
  one line there.
- **Installed as one tree.** `install.sh` copies `mcp/` and `claude-code/`
  into `~/.claude/claude-usage-panel/` (plus a `{"type":"module"}`
  package.json) so the relative imports resolve exactly as in the checkout;
  the status line command, the MCP registration and the `claudectl` shim
  point into it. Pre-1.11 loose `.mjs` copies are removed on update.
- **No file in the repo is over 700 lines.** The 1k flag is the ceiling, not
  the target: when a file approaches it, split by concern (that is how
  `install.sh` became `scripts/install/*.sh`, `pure.js` a barrel, and
  `ClaudeUsagePanelApp.swift` four files).

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
