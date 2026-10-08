# Waiting on you

Several Claude Code sessions across several terminals, and one of them is
stuck on a permission prompt, a question, or the idle prompt after you hit
Stop. The panels, `claudectl waiting`, the MCP `waiting` tool and an optional
status-line segment show which ones need you, oldest wait first, and a click
(or `claudectl waiting focus NAME`) raises that session's terminal.

## What counts as waiting

Claude Code hooks write a small marker next to the live-session registry
(`~/.claude/sessions/<pid>.waiting.json`):

| Hook | What it does |
| --- | --- |
| `Notification` | mark - permission prompt, question, or idle, from the payload |
| `Stop` | mark **idle** - the turn ended and the prompt is waiting on you. Stop does **not** clear the marker. |
| `UserPromptSubmit` | clear - you just sent work |
| `PreToolUse` | clear - the agent is working |
| `PostToolUse` | clear - a tool you approved is done; the permission prompt is no longer waiting |
| `SessionEnd` | clear - the session is gone |

A marker counts only for the live session that wrote it - same pid **and**
same session id - so a crash, or a pid the kernel later reuses for another
session, cannot leave a ghost row. A re-mark for the same session and reason
keeps the original time, so the age does not jump back to 0s when Claude
Code's idle reminder fires a minute after Stop.

The hooks are merged into `~/.claude/settings.json` whenever the Node tree is
installed (`./install.sh statusline`, `mcp`, `cli`, and `gnome` / `macos` when
Node is on PATH). Other hooks you already have are left alone. Uninstalling
the last Node consumer removes ours.

## Surfaces

- **GNOME / macOS** - a count on the indicator when anything is waiting, and a
  **Waiting on you** section in the menu. Click a row to focus that session's
  terminal (`claudectl waiting focus`, using the same placement as
  `claudectl session save`: tmux, kitty, WezTerm, iTerm, Terminal.app).
- **`claudectl waiting`** / `claudectl waiting list [--json]` / `claudectl waiting focus NAME|PID`
- **MCP `waiting`** - the list as text plus structured rows
- **Status line** - opt-in `--segments=…,waiting` prints `wait N` (silent at 0)

## Install

```bash
./install.sh cli          # hooks + claudectl waiting
./install.sh statusline --segments=context,limits,tokens,ping,waiting
```

Manual hook command, if you wire `~/.claude/settings.json` yourself:

```text
node "/home/you/.claude/claude-usage-panel/claude-code/waiting-hook.js"
```

on `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`.
The hook reads the payload on stdin and never fails the session.
