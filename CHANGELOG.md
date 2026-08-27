# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
semantic versioning.

## [Unreleased]

### Fixed

- **`./install.sh` with no target crashed on stock macOS** with
  `mapfile: command not found` (exit 127) - the bash 4 builtin on the exact path
  the `curl … | bash` one-liner takes. Replaced with the bash 3.2 read loop the
  rest of the script already uses. The `bash32` gate only ever exercised *named*
  targets, so it never ran this path; it now covers the bare and `update` forms
  too, and was verified to catch the regression.

### Added

- **Token attribution: where the tokens actually went.** `node
  scripts/token-attribution.mjs` splits your spend across exploration,
  implementation, verification, **rework** (editing a file this session already
  edited) and **correction** (the turn after a tool call errored). Totals tell
  you that you spent a lot; they never tell you on what, which is the only
  version that changes behaviour. Clearly marked estimated - it is reconstructed
  from local session logs, not reported by Anthropic.
- **Linux status bars.** `linux/usage-bar.mjs` prints one usage line for waybar
  (`--format waybar`, with `class` and `percentage` taken from the worst limit),
  tmux (`--format tmux`, per-severity colour tags), polybar and i3blocks. It
  reuses `mcp/server.js` wholesale, so there is no second copy of the
  normalization contract. A network error, expired token or HTTP 429 prints `--`
  and exits 0 - a status bar that prints a stack trace is worse than one that
  prints nothing.
- **Session-window planner.** `sessionping` made you guess ping times; this
  computes them. A 5-hour window is anchored to your first message, not the
  clock, so a 09:00 start covers only 56% of a 09:00-18:00 day - pinging at
  08:00 and 13:00 covers 100%. `./install.sh plan` prints a coverage bar and
  the exact `sessionping` command; `--compare 09:00` scores the schedule you
  already have. macOS Settings gains a **Suggest times** button and a live
  coverage line. Overlapping windows are unioned rather than summed, so a
  redundant schedule can never outrank a spread one.
- **Every number now says where it came from.** Limit percentages are read from
  the account's usage endpoint (`official`); session cost and burn-rate
  projections are derived locally from logs and a price table (`est.`). Those
  fail in different ways - an official figure can be stale, an estimated one can
  be quietly wrong - and rendering them identically is what makes a dashboard
  untrustworthy. `Provenance` / `Sourced` in the shared core, surfaced in both
  the macOS dropdown and the GNOME panel.
- **Updates section in Settings (macOS) and Preferences (GNOME).** Shows
  installed vs latest, when the daily check last ran, and a Check now / Update
  now button. Crucially it shows **why auto-update is not acting**: the
  scheduler deliberately refuses a dirty, diverged or detached checkout and
  only wrote the reason to its log, so a paused install was indistinguishable
  from a current one. Both UIs read `scripts/auto-update.sh --status --json`,
  the same script the timer runs, so they cannot disagree with it.
- **`scripts/auto-update.sh --status --json`** - machine-readable status
  (`updateAvailable`, `blocked`, `blockedReason`, `lastCheck`). The plain
  `--status` output now also prints `update:` and, when relevant, `blocked:`.
- **New `sessionping` install target**: schedules tiny `claude` pings (haiku,
  one turn) at fixed local times so the 5-hour session window opens on your
  schedule instead of at your first message of the day -
  `./install.sh sessionping 05:30 10:35 --days=mon-fri`. Opt-in only, times and
  days are changed by re-running the command, and `update` preserves them.
  Wired through the same systemd timer / launchd agent / cron mechanisms as
  `autoupdate`; the worker is `scripts/session-ping.sh` (`--status`, `--force`).
- **macOS: session pings are configurable from the app's Settings** (times,
  weekdays, on/off) - the app reads and writes the same launchd agent as the
  installer, so either side can edit what the other configured, and the
  dropdown shows the active schedule. The worker script ships in the app
  bundle's Resources, so the schedule survives without a git checkout.

### Changed

- **CI is one workflow with one required check.** `test.yml` and
  `pre-commit.yml` merged into `ci.yml`, where a `ci-gate` job fans in every
  other job and is the only context branch protection requires - so adding or
  renaming a job no longer needs a branch-protection change. This fixes pull
  requests sitting at `BLOCKED` with every check green: the ruleset required
  `analyze` from `codeql.yml`, a workflow GitHub had auto-disabled when CodeQL
  default setup was enabled, so the context could never report again.
- **`codeql.yml` deleted.** CodeQL default setup supersedes it and covers more
  languages (`actions`, `javascript-typescript`, `swift` vs `javascript`).
- Runs are now cancelled per pull request on a force-push, and every job has a
  `timeout-minutes`.
- **New `bash32` CI gate.** `scripts/bash32-smoke.sh` runs in a `bash:3.2`
  container - the version macOS ships as `/bin/bash` - parsing every shell
  script and dry-running every target `install.sh` advertises. The rest of the
  shell suite runs on ubuntu's bash 5, which silently passes real 3.2 traps
  such as expanding `"${arr[@]}"` on an empty array under `set -u`.

### Security

- **Workflow actions pinned to commit SHAs** instead of mutable tags, with
  `persist-credentials: false` on every checkout and `permissions:` moved from
  the workflow level to the jobs that actually write.
- **`zizmor` added to pre-commit** to audit workflows for unpinned actions,
  over-broad permissions, credential persistence and template injection -
  alongside `actionlint`, which only checks validity.
- **Dependabot now waits 7 days before proposing a new release** (`cooldown`),
  so a compromised upstream has time to be yanked before it reaches a PR.
- **macOS: the Cursor Admin API key moved from UserDefaults to the login
  Keychain** (CodeQL high: cleartext storage in a preference store). A key
  stored by earlier versions migrates on first launch and is scrubbed from the
  plist.
- **GNOME: the same key moved from dconf to the system keyring** (libsecret /
  gnome-keyring) - the sibling of the macOS fix, same cleartext exposure,
  just not flagged because CodeQL doesn't scan GJS. A dconf value from earlier
  versions migrates into the keyring on first use and the dconf slot is
  scrubbed; on a system without a running Secret Service everything fails soft
  to the old dconf path, so the panel never breaks over a missing keyring
  daemon.
- **CI workflows now run least-privilege**: `test.yml` and `pre-commit.yml`
  declare `permissions: contents: read` instead of inheriting the default
  write-capable token (closes the five CodeQL workflow-permissions alerts).

## [1.7.0] - 2026-08-01

### Added

- **Burn-rate forecast on every limit.** From the timestamped usage history each
  client already keeps, a weighted regression over the last 6 h projects when a
  limit hits 100% and whether that lands **before its reset** - surfaced as a
  sub-line on the GNOME/macOS cards ("↗ 4%/h - full ~Sat 21:24, 3d7h before
  reset", amber when alarming), a predictive top-bar/menu-bar tint (trouble
  visible at 50%, not at 90%), a one-shot desktop notification with hysteresis
  when a limit first goes on pace to run dry ≥1 h early, a compact
  "⚠full Sat21:24" marker in the status line, and a `pace` object per limit in
  the MCP `get_usage` output - so you can ask "will I make it to the reset?".
  The projection is deliberately honest: it needs ≥3 samples spanning ≥30 min,
  ignores samples older than 6 h or from before a window reset, and stays
  silent when idle. One implementation contract across all four ports, pinned
  by `tests/fixtures/forecast.json` (JS ×3 + Swift parity suites).
  The status line and MCP server share one local sample file
  (`$TMPDIR/claude-usage-history.json`) so each densifies the other's history -
  still no credentials, no network.
- **Screenshots are now generated, and CI fails on drift.**
  `scripts/screenshots/render.mjs` renders `docs/screenshot.svg` + `docs/og.svg`
  (and rasterizes `og.png` when a rasterizer is present) from
  `scripts/screenshots/data.json`, driving the real shared logic - normalize,
  forecast, pool notes, sparklines - under a fixed clock, so the pictures
  cannot drift from what the code renders. A `screenshots` CI job runs
  `render.mjs --check`; forgetting to regenerate after a UI-visible change goes
  red. README and the landing page now embed the SVG.

## [1.6.0] - 2026-08-01

### Added

- **Daily auto-update** - `scripts/auto-update.sh` checks the newest released
  tag on `origin` once a day, fast-forwards the checkout when it's newer, and
  runs `install.sh update` so every client you already have moves to the new
  version by itself. Scheduled by the new `./install.sh autoupdate` target: a
  systemd user timer on Linux, a launchd agent on macOS, a cron line as
  fallback, all with matching `--uninstall`, `--list` detection and `--dry-run`.
  It's part of the default detected set on a git checkout - turn it off with
  `./install.sh --uninstall autoupdate`.
  The script only ever `merge --ff-only`s, and skips (with a logged reason,
  never a modification) when the worktree is dirty, the branch is diverged or
  detached, the remote is missing, or another run holds the lock. Run it by hand
  with `--check` (report only, exit 10 when an update is waiting), `--status`,
  or `--force`; a rolling log lives in
  `~/.local/state/claude-usage-panel/auto-update.log`.

### Changed

- **Per-model limits are now shown as what they are: a share of the weekly
  pool.** Fable usage draws from the weekly all-models limit (on Max, up to 50%
  of the weekly allowance may go to Fable) rather than from a pool of its own -
  confirmed against the live endpoint on 2026-07-26 and Anthropic's Fable 5
  help-center page. Every port's card now carries `group` (`session` / `weekly`)
  and `scoped`, the GNOME / macOS cards and the MCP tool output carry a "share
  of the weekly all-models limit" note, and the MCP `get_usage` output schema
  exposes both new fields.

### Fixed

- **A per-model card no longer loses its reset countdown.** The API leaves the
  scoped `resets_at` null until that model is used in the window, so a scoped
  card now inherits the reset of the pooled limit it draws from - the Fable card
  showed a percent with no countdown for any week Fable hadn't been touched yet.

## [1.5.0] - 2026-07-19

### Added

- **MCP server** (`mcp/server.js`) - a zero-dependency stdio server exposing a
  `get_usage` tool, so Claude Code and Cursor can answer "how much of my plan
  have I used?" in-conversation. Fourth port of the shared normalization
  contract, parity-tested with the others; `tests/mcp.test.js` covers the
  JSON-RPC plumbing end-to-end. Runs from anywhere via
  `npx -y github:fschmutz/claude-usage-panel` (new `bin` entry).
- **`install.sh mcp` target** - copies the server to
  `~/.claude/claude-usage-mcp.mjs` and registers it in Claude Code
  (`claude mcp add`, user scope) and Cursor (`~/.cursor/mcp.json` merge),
  with matching `--uninstall`, detection, and `--dry-run`.
- **Claude Code plugin + marketplace** (`.claude-plugin/marketplace.json`,
  `plugin/`) - `/plugin marketplace add fschmutz/claude-usage-panel` then
  `/plugin install claude-usage@claude-usage-panel` installs the usage tool
  without cloning anything.
- **One-line installer** - `curl -fsSL
  https://fschmutz.github.io/claude-usage-panel/install | bash` clones or
  updates `~/.local/share/claude-usage-panel` and forwards to `install.sh`
  (targets and flags pass through with `bash -s -- …`).
- Landing page: per-target install tabs with **copy buttons**, a one-click
  **Add to Cursor** deep-link button, and an MCP feature card.
- Releases now also carry the **macOS `.app`** (built on a macOS runner, ad-hoc
  signed, zipped) alongside the GNOME extension zip.
- The status-line installer **backs up an existing (foreign) status line** and
  `--uninstall statusline` **restores it**, instead of silently clobbering it.
- **Version-drift guard** (`scripts/check-versions.sh`, run in pre-commit + CI):
  fails if `metadata.json` / the cask / `install.sh` disagree with `package.json`.
- **actionlint** in pre-commit, so workflow bugs are caught before they ship.
- `install.sh macos --build-only` builds the bundle without installing it (CI).
- **Automated GitHub Releases**: pushing a `v*` tag now runs
  `.github/workflows/release.yml`, which builds the GNOME `.shell-extension.zip`,
  pulls the version's notes from `CHANGELOG.md`, and publishes the Release with
  the zip attached (re-runnable from the Actions tab for an existing tag).
- `install.sh update [target…]` upgrades an existing install in place -
  reinstalling only the targets already present (detected), with `--pull` to
  `git pull --ff-only` first. macOS quits the running app and relaunches the new
  build so the upgrade actually takes effect; `--list` now shows detected vs
  installed targets.
- Status line: a **Σ per-session token counter** - the cumulative tokens the
  window has consumed, summed from the transcript Claude Code points to, with
  `all` (includes cache reads = true throughput) and `fresh` modes. The token
  sums are cached on disk keyed by the transcript's size+mtime, so a multi-MB
  transcript isn't re-read on every refresh. Based on @Giovannibthx's #8.
- Status line: choose the segments and token mode with `install.sh statusline
  --segments=context,limits,tokens --tokens=all|fresh` (baked into the installed
  command; non-interactive and pipe-safe).

### Changed

- The Claude Code status line now **renders only from Claude Code's stdin**
  (Context + Session/Week + the transcript for the token total), fixing the
  cold-start "unavailable" message and always showing every limit even at 0 %.
  It needs no credentials, no network, and no OAuth cache. **Per-model (Fable)
  limits are now desktop-only by design** - stdin never exposes them, so the
  terminal line drops them while the GNOME extension and macOS app keep them via
  the OAuth endpoint. The now-unused `normalizeUsage` and OAuth cache helpers
  were removed from the status line, and it is no longer part of the cross-port
  normalization parity test (which now binds `lib/pure.js` ↔ the Swift core, the
  two ports that still fetch and normalize). Based on @Giovannibthx's #8.
- **README restructured** around one canonical home per topic: a one-line
  install + target table up top, deep detail moved to per-target docs (new
  `docs/GNOME.md`; existing `macos/`, `claude-code/`, new `mcp/` READMEs), the
  repo tree into `CONTRIBUTING.md`. No content dropped - everything moved.
- `scripts/bump-version.sh` + `scripts/check-versions.sh` now cover the new
  version sites (MCP server const, plugin manifest, marketplace entry).

## [1.4.0] - 2026-07-13

### Added

- Claude Code **terminal status line** (`claude-code/`): a condensed one-line
  usage view under the prompt, with cache + rate-limit backoff and a stdin
  `rate_limits` fallback. Contributed by @Giovannibthx (#7).
- Unit tests: JS (`node --test`) for the extension's pure logic and Swift
  (`swift test`) for the `ClaudeUsageCore` library, wired into CI.
- Sparkline history now persists across restarts (dconf on GNOME,
  `UserDefaults` on macOS).
- GNOME: light-theme support for the dropdown.
- Internationalization scaffolding (gettext `.pot` + a French translation).
- **Cross-port parity test**: one shared `tests/fixtures/normalize.json` asserts
  the GNOME, status-line, and macOS normalizers all agree on the semantic core -
  drift between the three hand-written copies now reddens CI.
- **macOS CI job** (`macos-latest`) compiles the real SwiftUI app, not just the
  Foundation-only core, so app-layer type errors are caught in CI.
- `scripts/bump-version.sh <ver>` bumps the version in every file at once
  (`package.json`, `metadata.json`, the Homebrew cask, and `CHANGELOG.md`).
- `install.sh --dry-run` prints every action without touching the filesystem,
  `settings.json`, or dconf.
- Unit tests for the status line's disk cache, TTL boundary, and rate-limit
  backoff (`readCache` / `writeCache` / `touchCache` made injectable).
- macOS: **Start at login** via `SMAppService` (macOS 13+), on by default on
  first launch (matching the GNOME auto-enable) and toggleable in Settings.
  `install.sh macos` now ad-hoc signs the bundle, installs it to `/Applications`,
  and launches it; `--uninstall macos` removes it.

### Changed

- **One unified `install.sh`** replaces the three separate scripts: it takes
  `gnome` / `statusline` / `macos` targets (auto-detecting the OS with no
  argument), adds `--uninstall`, `--list`, and `-h`, and each target guards its
  own dependencies and skips cleanly instead of failing the run. Removed
  `claude-code/install.sh` and `macos/build-app.sh`.
- The macOS bundle version is now read from `package.json` (single source of
  truth), fixing a drift where `build-app.sh` hardcoded a different version.
- Refactored the pure logic into a testable `lib/pure.js` (GNOME) and a
  Foundation-only `ClaudeUsageCore` Swift library (macOS), separated from the
  GJS / SwiftUI / networking layers.

### Fixed

- macOS: correct legacy-usage fallback ids (`session` / `weekly_all`).

## [1.2.2] - 2026-07-07

### Added

- Cursor spend **gauge**: a colored `%` bar when the team has a monthly spend
  limit set (falls back to spend text otherwise), on GNOME and macOS.

## [1.2.1] - 2026-07-07

### Fixed

- GNOME: clicking **Refresh now** no longer closes the popup.

## [1.2.0] - 2026-07-07

### Added

- Limit-crossing alerts (90% / 100%), usage sparkline, severity-colored top-bar glyph.
- macOS: native Settings window + Cursor support; token read from the login Keychain.
- Optional Cursor team-spend section (Cursor Admin API).

## [1.0.0] - 2026-07-03

### Added

- Initial release: GNOME Shell extension + native SwiftUI macOS menu-bar app
  showing Claude Code session / weekly / per-model plan limits from the official
  usage API, with a designed dropdown and optional `ccusage` cost.
