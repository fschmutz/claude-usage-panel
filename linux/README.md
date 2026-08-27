# Linux status bars

GNOME gets an extension and macOS a menu-bar app. Everyone else on Linux -
waybar, tmux, polybar, i3blocks, Hyprland - gets this one command.

```bash
node linux/usage-bar.mjs                  # S 16%
node linux/usage-bar.mjs --limit weekly   # W 26%
node linux/usage-bar.mjs --limit all      # S 16% · W 26%
```

It reuses `mcp/server.js` wholesale: same endpoint, same normalization, the
same official `limits[]` numbers as every other client here. There is no second
copy of the contract to drift.

It never fails loudly. A network error, an expired token or an HTTP 429 prints
`--` and exits 0, because a status bar that prints a stack trace is worse than
one that prints nothing.

## waybar

`--format waybar` emits `text`, `tooltip`, `class` and `percentage`. The class
is the *worst* limit's severity (`normal` / `warning` / `critical`), so styling
reacts to whichever limit is closest to the edge.

```jsonc
// ~/.config/waybar/config
"custom/claude": {
  "exec": "node /path/to/claude-usage-panel/linux/usage-bar.mjs --format waybar --limit all",
  "return-type": "json",
  "interval": 300
}
```

```css
/* ~/.config/waybar/style.css */
#custom-claude.warning  { color: #e5a50a; }
#custom-claude.critical { color: #e01b24; }
#custom-claude.off      { color: #777777; }
```

## tmux

`--format tmux` wraps each limit in `#[fg=colourN]` by severity.

```tmux
# ~/.tmux.conf
set -g status-right '#(node /path/to/claude-usage-panel/linux/usage-bar.mjs --format tmux --limit all) | %H:%M'
set -g status-interval 300
```

## polybar / i3blocks

Plain text output, no flags needed:

```ini
[module/claude]
type = custom/script
exec = node /path/to/claude-usage-panel/linux/usage-bar.mjs --limit all
interval = 300
```

## Interval

Keep it at 300s or more. The usage endpoint rate-limits, and a tight loop
across several bars will earn an HTTP 429 - which shows up as `--`.
