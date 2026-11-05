# Claude Code footer

The line **under the Claude Code prompt**, drawn by the `usage-footer` plugin
(a Claude Code mod). It replaced the Node status line.

```text
⏵⏵ auto mode on · ● Opus 5.5  claude-usage-panel ⎇ main   6 agents ←        context ━━━━━━━━━━━━  62%   week ━━━━━┃━━━━━━  41% ↻2d2h   $3.42
```

- **Left**: the model, the project, the git branch, then what Claude Code
  itself had to say on that line (the agent count, `esc to interrupt`, any
  other hint), restyled and kept: nothing it shows is dropped. The permission
  mode label (`⏵⏵ auto mode on`) is drawn by Claude Code in front of it.
- **Right, flush with the edge**: `context`, then each plan window the session
  reports (`session` for the 5 h window, `week` for the 7 d one), then the
  session cost once it is above zero. A plan without a 5 h limit has no
  `session` gauge at all, never an empty one.
- Each gauge is a thin rule: the used part in green, amber (from 75%, or when
  the burn rate runs dry before the reset) or red (from 90%), the rest in a
  muted track. `┃` marks where the clock stands in the window: a bar past it is
  burning faster than time. `▲` after a gauge means the recent pace runs out
  before the reset.
- A toast fires once when a window crosses 90% and again at 100%.
- As the terminal narrows it drops, in order: the branch, the project, the
  reset countdowns, the cost, then the bars themselves (the percentages stay).

It reads **only what Claude Code hands a mod** - the session's rate-limit
windows, context and cost - so it needs no credentials and no network.
Per-model (Fable) weekly limits are not part of that, so they appear in the
GNOME extension, the macOS app and the [[MCP Tool]], not here.

## Install

```bash
./install.sh footer
# or, without a clone:
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash -s -- footer
```

Adds this checkout as a Claude Code plugin marketplace and installs
`usage-footer@claude-usage-panel` for your user. Claude Code reads it in place
from `footer/`, so the daily auto-update that moves the checkout to a new
release moves the footer with it. Open a new session to see it. Needs the
`claude` CLI on `PATH`.

From inside Claude Code, without a clone:

```text
/plugin install usage-footer --marketplace fschmutz/claude-usage-panel
```

## Coming from the status line

`./install.sh statusline` still works and means `footer`. A machine that has
the old status line is reported as having the footer, so the next
`./install.sh update` - the daily job included - removes the old `statusLine`
entry from `~/.claude/settings.json` (putting back a status line of your own
that it had replaced, if any) and installs the plugin. The `--segments=` and
`--tokens=` options are ignored now.

## Remove

```bash
./install.sh --uninstall footer
```
