# claude-code/

The Node clients' I/O over the shared pure contract
(`claude-usage-panel@fschmutz.github.io/lib/pure/`): the `claudectl` CLI
(`account`, `session`, `codex`, `waiting`, `awake`), the opt-in Claude Code
hooks (`waiting-hook.js`, `pause-hook.js`) and the stores they share with the
MCP server. `./install.sh cli` / `mcp` copy this directory, with `mcp/` and
`lib/pure/`, to `~/.claude/claude-usage-panel/`.

## The line under the prompt

The Node status line that used to live here was replaced by the
[`usage-footer` plugin](../footer/) - see the
[Footer wiki page](https://github.com/fschmutz/claude-usage-panel/wiki/Footer).
`./install.sh statusline` still works: it installs the footer and removes the
old `statusLine` entry from `~/.claude/settings.json`.
