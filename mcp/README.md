# Claude Usage MCP server

One MCP tool - **`get_usage`** - that returns your Claude plan usage (session,
weekly, and per-model limits with percent, severity, and reset time) inside any
MCP client: Claude Code, Cursor, Claude Desktop… Ask *"how much of my plan have
I used?"* and the assistant answers with live numbers from the official
Anthropic usage endpoint - the same data as the GNOME and macOS panels.

Zero dependencies, stdio transport, read-only: it reads the OAuth token Claude
Code already stores locally (`~/.claude/.credentials.json` on Linux, the login
Keychain on macOS) and never writes it.

## Install

Pick whichever fits - all four register the exact same server:

```sh
# 1. The unified installer (registers Claude Code + Cursor in one go)
./install.sh mcp

# 2. Claude Code plugin (inside a Claude Code session)
/plugin marketplace add fschmutz/claude-usage-panel
/plugin install claude-usage@claude-usage-panel

# 3. Claude Code CLI, straight from GitHub - no clone needed
claude mcp add claude-usage -- npx -y github:fschmutz/claude-usage-panel

# 4. Cursor: click "Add to Cursor" on https://fschmutz.github.io/claude-usage-panel/
#    (or add {"command": "npx", "args": ["-y", "github:fschmutz/claude-usage-panel"]}
#     under mcpServers in ~/.cursor/mcp.json)
```

`./install.sh --uninstall mcp` reverses option 1 (deregisters both apps, leaves
other MCP servers untouched).

## Tool

`get_usage` - no arguments. Returns one entry per active limit:

```json
{
  "limits": [
    {"key": "session", "label": "Current session", "percent": 26,
     "severity": "normal", "resetsAt": "2026-07-19T16:00:00Z", "active": true}
  ],
  "lastPing": {"at": "2026-09-01T03:30:12Z", "label": "05:30"},
  "sessions": [
    {"sessionId": "fd2d7081-…", "label": "BAM-SALES", "cwd": "/home/u/Git/BAM-SALES",
     "tokens": 412000, "when": "16:02",
     "resumeCommand": "cd '/home/u/Git/BAM-SALES' && claude --resume 'fd2d7081-…'"}
  ]
}
```

plus a compact markdown rendering for the conversation. `severity` is the API's
own normal / warning / critical. Errors (no token, expired session, network)
come back as tool errors with a one-line fix hint.

`lastPing` is when a scheduled session ping last opened the 5-hour window
(`null` if you never set pings up). `sessions` is today's local Claude Code
sessions, biggest token spender first, each with the command that resumes it -
those token counts are **estimated** from the local transcripts (cache reads
excluded), not reported by the API.

## How it works

```text
GET https://api.anthropic.com/api/oauth/usage
    authorization: Bearer <token>
    anthropic-beta: oauth-2025-04-20
```

The server is the fourth port of the repo's shared normalization contract (see
`CLAUDE.md`) - `tests/parity.test.js` keeps it behaviorally identical to the
GNOME, macOS, and status-line ports, and `tests/mcp.test.js` covers the MCP
plumbing itself.
