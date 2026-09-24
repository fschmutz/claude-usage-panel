# Claude Code status line

A condensed, one-line usage view rendered **under the Claude Code prompt** -
without leaving your terminal.

```text
Context ▌░░░░░ 8%  Session █▌░░░░ 26% 59m  Week █▌░░░░ 24% 4d2h  ∑ 1.2M tok
```

Each part gets a compact gauge colored green / yellow / red (70% / 90%
thresholds), plus reset countdowns and a **∑ session-token counter** - the total
tokens the window has consumed, summed from the session transcript.

It reads **only what Claude Code pipes on stdin** - the context window, the
Session (5 h) / Week (7 d) rate limits, and the transcript path for the token
total - so it needs **no credentials, no network, no cache of the OAuth
endpoint**, and starts instantly. Per-model (Fable) weekly limits are
desktop-only by design: stdin never exposes them, so they appear in the GNOME
extension, the macOS app, and the [[MCP Tool]] - never here.

When your recent pace puts a limit on track to run out **before** its reset,
the gauge grows a compact amber marker - `Week █▌░░ 52% 2d14h ⚠full Sat21:24` -
and stays silent otherwise, so the line only lengthens when something is worth
knowing. Samples are recorded to a per-user scratch file shared with the MCP
server (`claude-usage-history.json` in `$XDG_RUNTIME_DIR`, else `~/.claude`;
the per-user `$TMPDIR` on macOS; never the shared `/tmp`), kept per account;
still no credentials and no network.

## Install

```bash
./install.sh statusline
# or, without a clone:
curl -fsSL https://fschmutz.github.io/claude-usage-panel/install | bash -s -- statusline
```

Copies the Node clients to `~/.claude/claude-usage-panel/` and merges a
`statusLine` entry into `~/.claude/settings.json` without clobbering other
settings (a foreign status line is backed up and restored on `--uninstall`).
Open a new session or run `/statusline` to see it. Needs only Node.js (already
present - Claude Code runs on it).

## Options

Pick the segments, their order, and the token mode (baked into the installed
command; re-run to change):

```bash
./install.sh statusline --segments=context,limits,tokens,account --tokens=all|fresh
```

- `--segments` - any order of `context`, `limits`, `tokens`, `ping`, `account`,
  `sessions`. Default: `context,limits,tokens,ping`.
- `account` (opt-in) renders `[PRO]`: the saved account this session runs on
  (nothing until a login is saved, see [[Accounts]]). When this session is at the
  auto-switch threshold and the panels' last snapshot says another saved
  account has room, it turns yellow: `[PRO ⇢ PERSO]`. A hint only - the status
  line has no credentials and never switches. The account segment matches
  `~/.claude.json` `oauthAccount` against the saved profiles and never reads
  an access token (no Keychain lookup on macOS).
- `--tokens` - `all` (include cache reads: the true throughput) or `fresh`
  (only new tokens).

## Behavior

- The token sums are cached on disk per transcript (the 16 most recently used,
  so parallel sessions keep their own entry) with the byte offset of the last
  complete line: an unchanged transcript is not read at all and a grown one is
  read only past that offset.
- Session/Week appear after the session's first API response (Claude Code only
  provides `rate_limits` from then on); before that you see the Context gauge.
- Renders on its own row above Claude Code's mode badges; indent with the
  settings `padding` field if you like.

## Details

See [claude-code/README.md](https://github.com/fschmutz/claude-usage-panel/blob/main/claude-code/README.md).
