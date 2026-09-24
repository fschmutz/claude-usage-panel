# MCP Tool - ask Claude or Cursor for your usage

Four MCP tools. The main one, **`get_usage`**, lets any MCP client answer *"how much of my plan
have I used?"* in-conversation with live numbers: session, weekly, and
per-model limits (Fable, Opus…) with percent, severity, and reset countdown -
the same data as the desktop panels, from the official Anthropic usage
endpoint.

Each limit carries `group` (`session` / `weekly`) and `scoped`. A scoped limit
(Fable) is a **sub-cap of its group's pool** - that usage also counts toward
`weekly_all` and shares its reset - so the rendered line says "share of the
weekly all-models limit" instead of implying extra quota.

Zero dependencies, stdio transport. `get_usage` and `list_accounts` read the
live login (`~/.claude/.credentials.json` on Linux, the login Keychain on
macOS) and write only the account store (the live login's profile when Claude
Code rotated its token, a stale profile's refreshed token) and caches;
`save_account` writes one profile file; `switch_account` replaces the live
credentials (file or Keychain item) and the `oauthAccount` block of
`~/.claude.json`, only when you ask for the switch.

`initialize` negotiates MCP protocol revision `2025-11-25` and also accepts
`2025-06-18`, `2025-03-26` and `2024-11-05`.

## Install

All paths register the exact same server - pick one:

```bash
# 1. The unified installer (registers Claude Code + Cursor in one go)
./install.sh mcp

# 2. Claude Code plugin (inside a session, no clone)
/plugin marketplace add fschmutz/claude-usage-panel
/plugin install claude-usage@claude-usage-panel

# 3. Claude Code CLI, straight from GitHub (no clone). The unpinned spec
#    tracks main; append #vX.Y.Z to run one release, as the plugin does.
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
every call, sharing a per-user scratch file with the status line): the %/hour burn rate, the
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

`account` names the saved account these numbers belong to (`{"name": "PRO",
"email": …, "plan": "max"}`), or is `null` when the current login was never
saved - see [[Accounts]].

Errors (no token, expired session, network) come back as tool errors with a
one-line fix hint - e.g. *"Claude session expired. Run any Claude Code command
to refresh it."*

## Account tools

Three more tools manage the saved logins (every install form has them):

| Tool | Does |
| --- | --- |
| `list_accounts` | Every saved login with its plan usage (read with that account's own stored token, refreshed when needed), which one is active, and its `tokenState` (`valid` / `stale` / `expired`). Never touches the live login; writes only refreshed tokens and the usage snapshot to the account store. |
| `save_account {name, force?}` | Save the login Claude Code holds now under `name`. |
| `switch_account {name}` | Make a saved account the current login. The reply says how many Claude Code sessions are still running on the old login - including the one you are asking from, which keeps its login until restarted. |

So *"switch me to PERSO"* works in the conversation. Ask *"which account has
the most room?"* and the answer comes from `list_accounts`.

## Details

See [mcp/README.md](https://github.com/fschmutz/claude-usage-panel/blob/main/mcp/README.md).
The server is not a port of its own: it imports the Node copy of the shared
normalization contract (`claude-code/normalize.js`, `claude-code/pace.js`) -
see [[Architecture]].
