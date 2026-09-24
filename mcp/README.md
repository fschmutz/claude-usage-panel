# Claude Usage MCP server

Four MCP tools for any MCP client (Claude Code, Cursor, Claude Desktop…).
**`get_usage`** returns your Claude plan usage (session, weekly, and per-model
limits with percent, severity, and reset time): ask *"how much of my plan have
I used?"* and the assistant answers with live numbers from the official
Anthropic usage endpoint, the same data as the GNOME and macOS panels.
**`list_accounts`**, **`save_account`** and **`switch_account`** manage named
Claude Code logins, so *"switch me to PERSO"* works in-conversation.

Zero dependencies, stdio transport. What each tool touches:

| Tool | Reads | Writes |
| --- | --- | --- |
| `get_usage` | the live login (`~/.claude/.credentials.json` on Linux, the login Keychain on macOS) | the live login's saved profile when Claude Code rotated its token; a stale profile's refreshed token when the live token is missing; the shared pace history (`claude-usage-history.json` in the per-user scratch dir); the session index cache (`sessions.json` in the cache dir) |
| `list_accounts` | the live login and the saved profiles | the usage cache, the live login's profile when its token rotated, a stale profile's refreshed token |
| `save_account` | the live login | one profile file in the account store |
| `switch_account` | the target profile | **the live credentials** (file or Keychain item), the `oauthAccount` block of `~/.claude.json`, and the store (outgoing profile, switch stamp) |

Every credential write stays under the account store. Only `switch_account` writes
your Claude Code login, and only when you ask for the switch.

## Install

Pick whichever fits - all four register the exact same server:

```sh
# 1. The unified installer (registers Claude Code + Cursor in one go)
./install.sh mcp

# 2. Claude Code plugin (inside a Claude Code session)
/plugin marketplace add fschmutz/claude-usage-panel
/plugin install claude-usage@claude-usage-panel

# 3. Claude Code CLI, straight from GitHub - no clone needed. The unpinned
#    spec tracks main; append #vX.Y.Z to run one release, as the plugin does.
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
    {"sessionId": "fd2d7081-…", "label": "my-app", "cwd": "/home/u/Git/my-app",
     "tokens": 412000, "when": "16:02",
     "resumeCommand": "cd '/home/u/Git/my-app' && claude --resume 'fd2d7081-…'"}
  ]
}
```

plus a compact markdown rendering for the conversation. `severity` is the API's
own normal / warning / critical. Errors (no token, expired session, network)
come back as tool errors with a one-line fix hint. `account` names the saved
account the numbers belong to (`null` if the current login was never saved).

Three more tools manage the saved logins: `list_accounts` (every saved login with its own
usage and whether it is active), `save_account {name}` and `switch_account
{name}` - so "switch me to PERSO" works in-conversation. What a switch touches,
and the token refresh behind it, is on the
[Accounts wiki page](https://github.com/fschmutz/claude-usage-panel/wiki/Accounts).

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
GNOME, macOS, and status-line ports, `tests/warehouse-parity.test.js` runs the
week-over-week fixture through its warehouse reader, and `tests/mcp.test.js`
covers the MCP plumbing itself.
