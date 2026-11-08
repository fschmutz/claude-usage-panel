# FAQ

**Can I just ask Claude or Cursor how much I've used?**
Yes - install the [[MCP Tool]] (`./install.sh mcp`, the Claude Code plugin, or the
"Add to Cursor" button on the landing page) and ask "how much of my plan have I
used?" in any conversation.

**Does it send my token anywhere?**
No. It reads your existing local token and calls Anthropic's official API with it. Nothing else,
no telemetry. Cursor/ccusage run only when you enable them.

**Why does it need to log out to install on Linux?**
Wayland loads new GNOME Shell extensions only at login. After the first install, updates also need
a relog to take effect.

**How do I update to a new version?**
You don't have to: installing from a git checkout also schedules a daily check that installs new
releases for you (`autoupdate`). By hand it's `./install.sh update --pull` - it pulls the latest
and reinstalls only the targets you already have. Status line: next session. GNOME: log out /
back in. macOS: it quits and relaunches the app for you.

**How do I stop it updating itself?**
`./install.sh --uninstall autoupdate` removes the timer / launchd agent / cron line. To see what
it's doing: `scripts/auto-update.sh --status`, or the log at
`~/.local/state/claude-usage-panel/auto-update.log`. It never updates a checkout with local
changes or a diverged branch - it logs the reason and leaves your work alone.

**Why is cost separate from the percentages?**
The official API exposes plan-limit percentages, not a dollar cost on subscription plans. Cost is
computed locally from your `~/.claude/projects/*.jsonl` logs by `ccusage`.

**Cursor shows dollars, not a percentage - why?**
Cursor is usage-based. If your team sets a monthly spend limit, the panel shows a `%` gauge;
otherwise it shows spend.

**Is there a menu-bar version for macOS?**
Yes - a native SwiftUI app under `macos/`. See [[macOS]].

**Is it on extensions.gnome.org?**
A listing is planned (see PUBLISHING.md). Until then, install with the one-liner,
from source, or from a release zip.
