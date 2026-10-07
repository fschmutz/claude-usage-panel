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
- [[Accounts]] - save each Claude login under a name (PRO, PERSO) and switch without a browser
- [[Codex]] - the same for the OpenAI Codex logins, opt-in and clearly labelled
- [[Tabs]] - snapshot the running Claude Code sessions, reopen them in the same windows and tabs
- [[Troubleshooting]] - common issues and fixes
- [[Architecture]] - how the code is laid out
- [[CI]] - what gates a merge, and the workflow supply-chain rules
- [[FAQ]]

## What it shows

Since 1.10 it also manages **named accounts**: save each Claude Code login as `PRO` / `PERSO`,
see every account's limits side by side, switch in one click (or let it switch to the freest
account at 90%) - no logout, no browser. Off by default; see [[Accounts]].

Session, weekly (all models), and **per-model** weekly limits (Fable, Opus…) from the official
`api.anthropic.com/api/oauth/usage` endpoint - with severity colors, reset timers, limit-crossing
alerts, a usage sparkline, and an optional session cost.

### Reading a limit card

```text
Weekly · all models                          62%
████████████████████░░░░░░░░░░░░   <- usage: share of the limit spent
                ▲                  <- clock: share of the window gone
Resets in 2d 21h · 53% of the window gone - 9 pts ahead of the clock
↗ 4%/h - full ~Sat 21:24, 3d7h before reset
▁▂▂▃▄▅▅▆▆▇▇█
```

| Element | Meaning |
| --- | --- |
| Bar | How much of this limit is spent, colored by the API's severity |
| ▲ under the bar | How much of the **window** has elapsed (3.5 days into a week = 50%). Fill left of it: you are spending slower than time passes. Fill right of it: faster, and at this pace the limit runs out before the reset. The caret turns amber when usage is ahead of the clock |
| Reset line | Countdown to the reset; when usage outruns the clock, how far ahead it is |
| `↗` line | Burn-rate forecast (below) |
| Sparkline | The last 12 readings |
| `–` and an empty bar | No honest figure: the endpoint sent none, or the window has just reset |

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
