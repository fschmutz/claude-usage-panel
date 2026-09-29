# Reclaiming dev-cache disk

Claude Code, Cursor and the `codex` CLI all keep caches, and none of them
prunes very hard. `claudectl cache` says what they cost and can move the
regenerated ones out of the way.

It is the only thing in this project that removes anything, so it is built the
other way round from everything else here:

- **A fixed, reviewable catalog.** Exact paths, listed below - never a glob,
  never a walk looking for things that look deletable.
- **Read-only until you ask.** `list` and the macOS Storage tab measure and
  nothing else: no directory is created, nothing is written.
- **Nothing is deleted.** Entries are **moved to the trash** - the freedesktop
  home trash on Linux (with the `.trashinfo` record that makes the file
  manager's *Put back* work) and the Finder Trash on macOS. The desktop's own
  undo is the undo.
- **Your history is not a cache.** Two entries hold work nothing regenerates;
  they are never part of a default run, and a named run still refuses them
  without `--include-history`.
- **Every run is written down**, with where each thing went.

## Commands

```console
claudectl cache list [--json]              every known cache, with its size (writes nothing)
claudectl cache reclaim [ID...] [--yes]    move them to the trash; without --yes, only the plan
claudectl cache log [--json]               what past runs moved, and where it went
```

`reclaim` prints the plan and stops. Only `--yes` moves anything:

```console
$ claudectl cache reclaim
  would trash  cursor-cached-data       1.4 GB  ~/.config/Cursor/CachedData
  would trash  claude-shell-snapshots  84.2 MB  ~/.claude/shell-snapshots
  keep         claude-projects          2.1 GB  your own history - name it and pass --include-history
  1.5 GB would move to ~/.local/share/Trash

re-run with --yes to move them. Nothing has been touched.
```

## The catalog

| ID | Kind | Path (Linux · macOS) | What losing it costs |
| --- | --- | --- | --- |
| `claude-shell-snapshots` | cache | `~/.claude/shell-snapshots` | One captured shell environment per session. Claude Code writes a new one when it needs it. |
| `claude-statsig` | cache | `~/.claude/statsig` | Cached feature flags. Refetched on the next run. |
| `claude-todos` | cache | `~/.claude/todos` | Each past session's todo list. A resumed session rebuilds its own. |
| `claude-downloads` | cache | `~/.claude/downloads` | Update payloads Claude Code already installed. |
| `claude-projects` | **history** | `~/.claude/projects` | Every past conversation, and what `claude --resume` resumes. Also what this panel reads to rank today's sessions. |
| `panel-session-index` | cache | `~/.cache/claude-usage-panel` · `~/Library/Caches/claude-usage-panel` | This panel's fold of the transcripts. Rebuilt on the next poll. |
| `cursor-cache` | cache | `~/.config/Cursor/Cache` · `~/Library/Application Support/Cursor/Cache` | HTTP and resource cache. Rebuilt as you work. |
| `cursor-cached-data` | cache | `…/Cursor/CachedData` | Per-version compiled sources. Rebuilt on the next launch, which is slower once. |
| `cursor-code-cache` | cache | `…/Cursor/Code Cache` | V8 code cache. Rebuilt on the next launch. |
| `cursor-gpu-cache` | cache | `…/Cursor/GPUCache` | Shader cache. Rebuilt on the next launch. |
| `cursor-logs` | logs | `…/Cursor/logs` | One directory per window session. Only useful while reporting a bug. |
| `codex-logs` | logs | `$CODEX_HOME/log`, else `~/.codex/log` | The `codex` CLI's own log files. |
| `codex-sessions` | **history** | `$CODEX_HOME/sessions`, else `~/.codex/sessions` | Every past Codex conversation, and the only local record of the rate limits the API reported - clearing it makes `claudectl codex usage` blind. |

`~/.claude` follows `CLAUDE_CONFIG_DIR` when that is set, and the two Codex
paths follow `CODEX_HOME`, exactly as everywhere else in this project.

A symlink inside one of these is counted as its own (tiny) size and never
followed, so a link into somewhere huge can neither make a cache look enormous
nor be moved as one.

## On macOS: the Storage tab

*Settings ▸ Storage* shows the same table with a checkbox per entry, a running
total, and a **Reclaim…** button that asks once before moving anything. It is
its own tab on purpose: the only control in this app that removes something
does not belong a click away from the usage popup.

History entries are listed but never pre-selected, and are marked as such.

## The log

Each run that moved something appends one JSON line to:

```text
~/.local/state/claude-usage-panel/reclaim.log.jsonl      # Linux
~/Library/Application Support/claude-usage-panel/reclaim.log.jsonl   # macOS
```

with the instant, the bytes freed, and for every entry both where it was and
where in the trash it went - so *"where did that go?"* has an answer that does
not depend on remembering.

## See also

- [[Accounts]] · [[Codex]] - the two vaults whose stores this never touches
- [[Tabs]] - `claudectl session`, which reads `~/.claude/projects` (a `history`
  entry here for exactly that reason)
