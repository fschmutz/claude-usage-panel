# MCP Tool - ask Claude or Cursor for your usage

One MCP tool, **`get_usage`**, lets any MCP client answer *"how much of my plan
have I used?"* in-conversation with live numbers: session, weekly, and
per-model limits (Fable, Opus…) with percent, severity, and reset countdown -
the same data as the desktop panels, from the official Anthropic usage
endpoint.

Each limit carries `group` (`session` / `weekly`) and `scoped`. A scoped limit
(Fable) is a **sub-cap of its group's pool** - that usage also counts toward
`weekly_all` and shares its reset - so the rendered line says "share of the
weekly all-models limit" instead of implying extra quota.

Zero dependencies, stdio transport, read-only: it reads the OAuth token Claude
Code already stores locally (`~/.claude/.credentials.json` on Linux, the login
Keychain on macOS) and never writes it.

## Install

All paths register the exact same server - pick one:

```bash
# 1. The unified installer (registers Claude Code + Cursor in one go)
./install.sh mcp

# 2. Claude Code plugin (inside a session, no clone)
/plugin marketplace add fschmutz/claude-usage-panel
/plugin install claude-usage@claude-usage-panel

# 3. Claude Code CLI, straight from GitHub (no clone)
claude mcp add claude-usage -- npx -y github:fschmutz/claude-usage-panel

# 4. Cursor: click "Add to Cursor" on https://fschmutz.github.io/claude-usage-panel/
```

`./install.sh --uninstall mcp` reverses option 1 (deregisters both apps,
leaves other MCP servers untouched).

## What it returns

One entry per active limit, as text plus structured content:

```json
{"limits": [
  {"key": "session", "label": "Current session", "percent": 26,
   "severity": "normal", "resetsAt": "2026-07-19T16:00:00Z", "active": true,
   "vsClock": {"elapsedPercent": 60, "deltaPoints": -34, "state": "behind"},
   "trend": {"thisWeekPeak": 71, "lastWeekPeak": 84, "deltaPoints": -13},
   "pace": {"pctPerHour": 4, "projectedFullAt": "2026-07-19T15:00:00Z",
            "exhaustsBeforeReset": true, "marginHours": -1}}
 ],
 "extraUsage": {"percent": 24, "severity": "normal", "usedAmount": 12.4,
                "limitAmount": 50, "currency": "USD",
                "detail": "$12.40 of $50.00"}}
```

`pace` appears once enough local history exists (the server records a sample on
every call, sharing a tmp file with the status line): the %/hour burn rate, the
projected 100% instant, and whether that lands before the reset - so you can
ask *"at this pace, will I make it to the weekly reset?"* and get a grounded
answer. Absent when idle or on the first calls.

`vsClock` needs no history at all - it is the reset time against the window
length (5 h session, 7 d weekly) - so it is there on the first call: how much
of the window has gone, and whether usage is running ahead of it.

`trend` is the 90-day local history the desktop panels record: this week's peak
against last week's. Absent when no panel has ever written that file.

`extraUsage` reports prepaid credits charged beyond the plan, and is null
unless the account has extra usage enabled.

Errors (no token, expired session, network) come back as tool errors with a
one-line fix hint - e.g. *"Claude session expired. Run any Claude Code command
to refresh it."*

## Details

See [mcp/README.md](https://github.com/fschmutz/claude-usage-panel/blob/main/mcp/README.md).
The server is the fourth port of the shared normalization contract - see
[[Architecture]].
