# Claude Code status line

A condensed, one-line view of your plan usage rendered **just under the Claude
Code prompt input** - the same numbers as the menu-bar / top-bar panel, without
leaving the terminal.

```text
Context ▌░░░░░ 8%  Session █▌░░░░ 26% 59m  Week █▌░░░░ 24% 4d2h  ∑ 1.2M tok
```

Each limit gets a compact fixed-width gauge whose fill tracks the percentage
down to 1/8 of a cell, colored by a 70 % / 90 % threshold (green = normal,
yellow = warning, red = critical). The line opens with a matching **Context**
gauge - the context-window usage Claude Code reports for the session. Every
limit is shown, even at 0 %, and each one that reports a reset shows its own
countdown.

It closes with **∑ N tok** - the total tokens this window has consumed since it
opened (prompt, cache writes, cache reads and completions summed across every
turn). Cache reads are re-read each turn, so on a long session this is a large,
honest throughput figure - a good cue for when to `/clear`.

It renders on its **own row above Claude Code's mode badges** (e.g.
`⏵⏵ auto mode on…`) - those are drawn by Claude Code and are left untouched.
Claude Code **left-anchors** the status line (there is no right-align option; the
`padding` setting only adds relative left indentation), so the line is
left-aligned. Add `"padding": N` to the `statusLine` block in
`~/.claude/settings.json` to indent it.

## Install

From the repo root, use the unified installer:

```sh
./install.sh statusline
```

This copies the script to `~/.claude/claude-usage-statusline.mjs` and merges a
`statusLine` entry into `~/.claude/settings.json` (other settings are left
untouched; re-running is safe). Open a new Claude Code session - or run
`/statusline` - to see it.

Choose which segments to show, in what order, and the token-total mode with two
optional flags (baked into the installed command; re-run to change them):

```sh
./install.sh statusline --segments=context,limits,tokens,ping --tokens=all
```

- **`--segments`** - any order of `context`, `limits`, `tokens`, `ping`,
  `sessions`; left-to-right on the line. Unknown names are dropped; omitting the
  flag shows the default set (`context,limits,tokens,ping`).
  - **`ping`** - `ping 05:30`, when a scheduled session ping last opened the 5h
    window. It is in the default set because it renders **nothing** until you
    schedule pings (`./install.sh sessionping`), so it costs an unconfigured
    line no width.
  - **`sessions`** - `▸ BAM-SALES 412.0k`, today's biggest token spender among
    your local sessions. Opt-in: the status line has little horizontal room. It
    only reads the session index the panels and the MCP server maintain, never
    parsing a transcript itself.
- **`--tokens`** - `all` (include cache reads; the true throughput) or `fresh`
  (only new tokens). Defaults to `all`.

The installer is non-interactive and pipe-safe - a `curl | bash` or `--dry-run`
install just takes the defaults.

To remove it, run `./install.sh --uninstall statusline` (deletes the script and
its `statusLine` entry, leaving any other settings alone).

### Manual install

If you'd rather wire it up yourself, point `statusLine` at the script from
wherever you keep it. Save it with a `.mjs` extension (it's an ES module) so
Node treats it as ESM regardless of any nearby `package.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.mjs\" --segments=context,limits,tokens,ping --tokens=all"
  }
}
```

The `--segments` / `--tokens` flags are optional - omitting them shows the
default segments with the `all` token total. They're exactly what `./install.sh
statusline` bakes in for you.

## How it works

Everything comes from what Claude Code gives the command locally - the session
JSON piped on stdin, plus the local transcript file it points to - with **no
credentials, no network, no cache, no other host**:

- **Context** from `context_window.used_percentage`.
- **Session** (5-hour) and **Week** (7-day) from `rate_limits.five_hour` /
  `rate_limits.seven_day`.
- **∑ tokens** by reading the session transcript at `transcript_path` and
  summing each turn's `usage` (input + output + cache creation + cache read).

`rate_limits` is provided on Pro/Max plans and only appears **after the first
API response of the session**, so on a fresh session you'll see just the
**Context** gauge until your first message - Session and Week appear as soon as
Claude Code provides them.

**Per-model (Fable) weekly limits are not shown here** - Claude Code's stdin
never exposes them; they come only from the OAuth usage endpoint, which the
GNOME extension and macOS app read. The terminal line is deliberately the cheap
stdin-only projection. Nothing is hidden from the **Week** gauge by that:
per-model usage draws from the same weekly pool, so Fable tokens are already
counted in it. The token sums are cached on disk (keyed by the
transcript's size + modification time), so a long, multi-megabyte transcript
isn't re-read on every prompt refresh.

## Requirements

- Node.js (already present - Claude Code runs on it)
