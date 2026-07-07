# Claude Code status line

A condensed, one-line view of your plan usage rendered **just under the Claude
Code prompt input** — the same numbers as the menu-bar / top-bar panel, without
leaving the terminal.

```text
Context ▌░░░░░ 8%  Session █▌░░░░ 26% 59m  Week █▌░░░░ 24%  Fable █▊░░░░ 29% 1d18h
```

Each limit gets a compact fixed-width gauge whose fill tracks the percentage
down to 1/8 of a cell, colored by the API's own severity (green = normal,
yellow = warning, red = critical). The line opens with a matching **Context**
gauge — the context-window usage Claude Code reports for the session (colored by
a local 70 % / 90 % threshold, since context has no API severity).

Each limit that reports a reset shows its countdown; when several limits share
the same reset (the weekly limits and their per-model cards do), it's shown once,
after the last of them — so `Week … Fable … 1d18h` rather than repeating it.

It renders on its **own row above Claude Code's mode badges** (e.g.
`⏵⏵ auto mode on…`) — those are drawn by Claude Code and are left untouched.
Claude Code **left-anchors** the status line (there is no right-align option; the
`padding` setting only adds relative left indentation), so the line is
left-aligned. Add `"padding": N` to the `statusLine` block in
`~/.claude/settings.json` to indent it.

## Install

```sh
./install.sh
```

This copies the script to `~/.claude/claude-usage-statusline.mjs` and merges a
`statusLine` entry into `~/.claude/settings.json` (other settings are left
untouched; re-running is safe). Open a new Claude Code session — or run
`/statusline` — to see it.

To remove it, delete the `statusLine` key from `~/.claude/settings.json`.

### Manual install

If you'd rather wire it up yourself, point `statusLine` at the script from
wherever you keep it. Save it with a `.mjs` extension (it's an ES module) so
Node treats it as ESM regardless of any nearby `package.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/absolute/path/to/statusline.mjs\""
  }
}
```

## How it works

Same read-only data layer as the rest of this project: it reads your existing
Claude Code OAuth token — from `~/.claude/.credentials.json` on Linux, or the
login **Keychain** on macOS — and queries the official
`api.anthropic.com/api/oauth/usage` endpoint. It never writes your credentials
and talks to no other host.

The **Context** gauge comes from the session JSON Claude Code pipes to the
command on stdin (`context_window.used_percentage`) — no extra work, no network.

Claude Code refreshes the status line often, so successful responses are cached
to a temp file for 120 seconds. The usage endpoint is rate-limited, so on a
failed request (e.g. HTTP 429) the script keeps showing the last good data and
backs off instead of re-hitting it every refresh.

If there's no usable API data at all (offline first run, or signed out), it
falls back to the **Session** and **Week** rate limits Claude Code passes on
stdin (`rate_limits.five_hour` / `seven_day`) — so you still see those two, just
without the per-model (Fable) card, which is API-only.

## Requirements

- Node.js (already present — Claude Code runs on it)
- An active Claude Code login
