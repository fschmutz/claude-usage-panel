# Claude Code footer

The line **under the Claude Code prompt**, drawn by the `usage-footer` plugin
(a Claude Code mod). Opt-in, and a target of its own: the
[[Status Line]] stays available, and nothing switches you from one to the other
unless you ask for it.

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
- Each gauge is a thin rule: the used part in the limit's tone (green, amber
  from 70%, red from 90% - the thresholds the status line uses on the same
  numbers - and amber whenever the burn rate runs dry before the reset), the
  rest in a muted track. A window with no number, or whose reset has already
  passed, reads `–` over an empty track: never 0% or the stale percent. `┃` marks where the clock stands in the window: a bar past it is
  burning faster than time. `▲` after a gauge means the recent pace runs out
  before the reset.
- A toast fires once when a window crosses 90% and again at 100%. The latch is
  kept in the plugin's store, so a reload or a second session of the same login
  does not announce it twice; the burn-rate samples are kept per login and
  window, merged across sessions.
- As the terminal narrows it drops, in order: the branch, the project, the
  reset countdowns, the cost, then the bars themselves (the percentages stay).

It reads **only what Claude Code hands a mod** - the session's rate-limit
windows, context and cost - so it needs no credentials and no network.
Per-model (Fable) weekly limits are not part of that, so they appear in the
GNOME extension, the macOS app and the [[MCP Tool]], not here. The status
line's extra segments (`ping`, the `∑ tok` total, the account hint, sessions,
waiting, awake) are not in the footer either: keep the status line for those.

## Install

```bash
./install.sh footer
# or, without a clone:
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash -s -- footer
```

Writes a directory marketplace of its own, `claude-usage-panel-local`, under
`~/.local/state/claude-usage-panel/footer-marketplace` (a link to this
checkout's `footer/`), adds it, installs `usage-footer@claude-usage-panel-local`
for your user and checks that `enabledPlugins` has it. Claude Code reads it in
place from `footer/`, so the daily auto-update that moves the checkout to a new
release moves the footer with it. Open a new session to see it. Needs the
`claude` CLI and Node.js.

It never touches the public `claude-usage-panel` marketplace (adding a folder
under a name that exists repoints it, with every plugin from it), and it stops
without changing anything when a marketplace of its own name points somewhere
else, or when `~/.claude/settings.json` is a symlink (a dotfiles-managed file
is not ours to edit: it prints the commands to run by hand instead).

From inside Claude Code, without a clone:

```text
/plugin install usage-footer --marketplace fschmutz/claude-usage-panel
```

## Coming from the status line

`./install.sh footer`, run by you, replaces the [[Status Line]]: only once the
plugin is installed and enabled does it remove the `statusLine` entry from
`~/.claude/settings.json`, putting back a status line of your own that the
status line had replaced. If any step fails, the status line stays as it was.
`./install.sh update` - the daily job included - reinstalls whatever you have
and never swaps one for the other; `./install.sh statusline` brings the status
line back next to the footer at any time.

## Remove

```bash
./install.sh --uninstall footer
```

Uninstalls the plugin and removes the `claude-usage-panel-local` marketplace
the installer added, and nothing else.
