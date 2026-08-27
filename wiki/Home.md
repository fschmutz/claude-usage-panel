# Claude Usage Panel - Wiki

See your **Claude Code** plan usage everywhere: the GNOME top bar, the macOS menu
bar, a status line under the Claude Code prompt, or by just asking Claude / Cursor
(MCP). Optional **Cursor** team spend.

- 🌐 **Landing site + one-click installs:** <https://fschmutz.github.io/claude-usage-panel/>
- 💾 **Releases:** <https://github.com/fschmutz/claude-usage-panel/releases>

One-line install (auto-detects your platform):

```bash
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash
```

It then **keeps itself up to date**: a daily check installs each new release for
you, and only ever fast-forwards a clean checkout - see [[Installation]].

## Pages

- [[Installation]] - every client: GNOME, macOS, status line, MCP
- [[Settings]] - all preferences
- [[Cursor Integration]] - optional team-spend section
- [[macOS]] - the SwiftUI menu-bar app
- [[Status Line]] - condensed usage under the Claude Code prompt
- [[MCP Tool]] - ask Claude or Cursor for your usage in-conversation
- [[Troubleshooting]] - common issues and fixes
- [[Architecture]] - how the code is laid out
- [[CI]] - what gates a merge, and the workflow supply-chain rules
- [[FAQ]]

## What it shows

Session, weekly (all models), and **per-model** weekly limits (Fable, Opus…) from the official
`api.anthropic.com/api/oauth/usage` endpoint - with severity colors, reset timers, limit-crossing
alerts, a usage sparkline, and an optional session cost.

Each limit also carries a **burn-rate forecast**: from your recent pace it projects when the
limit hits 100% and whether that lands *before* the reset - "↗ 4%/h - full ~Sat 21:24, 3d7h
before reset". The top bar turns amber and a notification fires the moment a limit goes on pace
to run dry early, so trouble is visible at 50%, not at 90%. The projection stays silent when
idle or when there's too little history to be honest.

A per-model limit is a **sub-cap of the weekly all-models pool**, not a separate
allowance: Fable usage counts toward the weekly limit (on Max, up to 50% of it
may go to Fable) and resets with it. The clients label those cards accordingly
and give them the weekly reset countdown even before the model is first used in
the window - the API leaves the scoped `resets_at` null until then.
