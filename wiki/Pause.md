# Pause and resume

Closing the laptop, out of usage, or just a break: one command, or one click
in the GNOME or macOS panel, sends the **pause protocol** to every live Claude
Code session, idle ones included, and tells you per session whether it was
delivered and what it answered: `SAFE TO CLOSE` or `NOT SAFE: <why>`.
`resume` is the mirror.

```bash
claudectl session pause --all          # every live session but the one you type it in
claudectl session pause API WEB        # by name, pid or session-id prefix
claudectl session pause-status         # the last request, one row per session
claudectl session resume --all         # running: resume protocol; closed: reopened with it
```

Opt-in: nothing reaches a session until `./install.sh pause` has installed the
hooks (see [How it reaches a session](#how-it-reaches-a-session)).

## In the panels

Both panels have the section, **off by default**; `./install.sh pause` turns
it on (GSettings `pause-enabled`, UserDefaults `pauseEnabled`).

- **GNOME**: a *Pause / resume* section in the dropdown with **Pause all**,
  **Resume all**, one row per live session with its state and its own
  **Pause** button (by pid, so two clones of one repo stay apart), and the
  summary line `Pause 14:05 · 5/7 safe · 1 not safe · 1 in progress`. Also in
  Preferences > Integrations.
- **macOS**: a *Pause sessions* section in the popup (Settings > Sessions turns
  it on) with the same buttons, rows and summary.

Every click runs the installed `claudectl` (`--no-wait --from=gnome|macos`);
the panel then follows the store for up to 180 s. The rows are the same join
the CLI prints (`pauseRows` in `lib/pure/pause.js`): one naming rule, one
TTL rule, in the terminal and in both panels.

## Commands

| Command | What it does |
| --- | --- |
| `pause [NAME...\|--all] [--include-self] [--wait[=S]\|--no-wait] [--json]` | Send the pause protocol and follow each row until every one is terminal or the wait ends (180 s by default) |
| `resume [NAME...\|--all] [--wait[=S]\|--no-wait] [--terminal=BIN] [--dry-run]` | Every session paused and not resumed since: running ones get the resume protocol; closed ones with a pending checkpoint are reopened in your terminal with it |
| `pause-status [--json]` | The last pause / resume request, one row per session, from disk |
| `report --request ID --verdict SAFE\|NOT_SAFE [--checkpoint P] [--reason TEXT\|--reason-file F\|-] [--session ID]` | What a paused session runs to answer; you do not type it. `--reason-file` (a file, or `-` for stdin) keeps a reason with quotes away from shell quoting |

`NAME` is a session name, a pid or a session-id prefix. `--all` is resolved
**when the request is sent** into the list of live session ids, stored with
each one's name and cwd: a session started afterwards is never hit, and one
that has ended still shows by name. `--all` leaves out the session you run it
from; `--include-self` keeps it. `resume --all` reads the store, not the last
request: it targets every session whose verdict or checkpoint is newer than
its last resume, whichever request paused it, so a per-session Pause sent after
a Pause all does not hide the others, and a second Resume all has nothing left
to resend. `resume NAME` also finds a session that has ended, by the name and
cwd kept in `known.json` from the request that paused it. `--wait` takes its
value only as `--wait=S`, so `pause --wait API` names API. `--from=cli|gnome|macos`
is internal to the panels (not in `--help`); any other value is an error.

Exit status of `pause`: **0** when every session answered SAFE, **3**
otherwise (not delivered, not answered in time, or NOT SAFE), **4** when a
newer request (a panel click, another `claudectl`) replaced it while it was
waiting: it stops and prints `superseded by <kind> <id> from <from>`, since
each session keeps one delivery and one verdict record and the newer request
now owns them. With `--no-wait` it is 0 once the request is sent. `resume` exits 3 when a session
could not be reopened or did not confirm in time. Scripts can chain on it:

```bash
claudectl session pause --all && systemctl suspend
```

`--json` prints the structured status (`rows` plus the `summary` below)
instead of the table.

## What a session receives

The protocol asks the session to inventory everything it launched, stop it in
order (agents first, then processes, then wake-ups), write ONE checkpoint file
with everything needed to resume, verify, and reply. The checkpoint path is
fixed per session:

```text
<state dir>/claude-usage-panel/pause/checkpoints/<session id>.md
```

(`~/.local/state/...` on Linux, `~/Library/Application Support/...` on macOS.)
The text opens with who sent it: "The user clicked Pause in the GNOME panel at
14:05" (or typed `claudectl session pause`, or clicked in the menu-bar app).
That is a claim, not proof: any process of yours can write the store. So when
`claudectl` itself runs **inside a Claude Code session** (its Bash tool sets
`CLAUDECODE` / `CLAUDE_PID`, or a `claude` is an ancestor), the request is
recorded as `from: "session"` with that session's id, whatever `--from` says
(`--from=gnome|macos` is refused there), and every receiving session reads
"sent from inside Claude Code session <id>, not typed by the user", and asks
you before stopping or resuming anything. A delivered resume ends with the
same approval rule as a reopen: nothing destructive, outward-facing or still
waiting on your answer without asking first. Its last step records the
verdict with an absolute command, so it works without `claudectl` on `PATH`:

```text
'<node>' '<tree>/claude-code/claudectl.js' session report --session <sid> --request <id> --verdict SAFE|NOT_SAFE ...
```

A NOT_SAFE reason is written to `<sid>.reason.txt` with the session's
file-writing tool and passed as `--reason-file`, never inside shell quotes
(an apostrophe in "can't stop" would end them). Names, reasons and paths have
their control characters blanked before they reach a terminal or a panel, and
a reason is cut at 300 characters. The text also spells out the JSON file to
write by hand if the command cannot run.
Without `--session`, `report` falls back to `$CLAUDE_CODE_SESSION_ID`, then
to `CLAUDE_PID` looked up in Claude Code's session registry.

## How it reaches a session

`./install.sh pause` (it installs the `cli` target first when missing) merges
three hooks into `~/.claude/settings.json`, next to your own, which it never
touches:

```json
{"hooks": {
  "SessionStart": [{"hooks": [{"type": "command", "command": "node \".../pause-hook.js\" wait", "asyncRewake": true, "timeout": 86400}]}],
  "Stop": [{"hooks": [{"type": "command", "command": "node \".../pause-hook.js\" wait", "asyncRewake": true, "timeout": 86400}]}],
  "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "node \".../pause-hook.js\" pretool", "timeout": 10}]}]
}}
```

```text
 claudectl session pause --all
        │  writes pause/request.json  {id, kind, targets: [sid...], sessions: [{name, cwd}]}
        ▼
 ┌────────────────────────────────┐   ┌──────────────────────────────┐
 │ idle session                   │   │ busy session, or no waiter   │
 │ wait (asyncRewake on           │   │ pretool (PreToolUse          │
 │ SessionStart + Stop):          │   │ backstop), on the next       │
 │ file watch + 15 s poll         │   │ tool call                    │
 └───────────────┬────────────────┘   └───────────────┬──────────────┘
                 │  claim <sid> under an O_EXCL lock  │
                 └─────────────────┬──────────────────┘
                                   ▼  first one wins, the other stays silent
               <sid>.delivered.json {requestId, via: rewake|pretooluse}
                                   ▼
            the model runs the protocol, writes checkpoints/<sid>.md
                                   ▼
          claudectl session report  ->  <sid>.verdict.json {SAFE|NOT_SAFE}
                                   ▼
          pause / pause-status: one row per session, exit 0 only when all SAFE
```

- **Waiter (`wait`)**: started in the background when a session starts,
  resumes or is cleared, and again after every turn. It sleeps on the pause
  directory (file watch, 15 s poll) until a request names its session, then
  exits 2 with the protocol on stderr, which wakes the model with no input
  from you. One live waiter per session (`<sid>.waiter`, holding its pid and
  start time); a second exits at once. It leaves when its `claude` process
  dies, when `/clear` moves the session to a new id, on SIGTERM, and on its
  own a minute before the hook timeout.
- **Backstop (`pretool`)**: a session with no live waiter (it started before
  the install, or is mid-turn) gets the request through one denied tool call,
  the protocol as the reason. Never twice for the same request, never inside a
  subagent (a payload with `agent_id` is ignored).
- **Exactly once**: delivery is claimed per (session, request) under a short
  lock and the delivery record is re-read inside it, so when the waiter and the
  backstop race only one delivers. A lock left by a crashed hook is taken
  over by an atomic rename, so two hooks that both find it stale cannot both
  get in.
- **Bound to a process**: the request records each target's pid and start
  time, and both hooks pass `CLAUDE_PID`. A session closed before it got the
  pause and then reopened (`claude --resume <id>`, `session open`) runs in a
  new process and does not pause itself on the old request.
- **TTL**: a request older than one hour is never delivered, and past it every
  row still without a verdict is final (`expired`), in the CLI and both panels.

All state lives in `<state dir>/claude-usage-panel/pause/`, 0600 files in a
0700 directory: `request.json`, `<sid>.delivered.json`, `<sid>.verdict.json`,
`<sid>.waiter`, `<sid>.resumed.json`, `<sid>.reason.txt`, `known.json`
(name and cwd of every session a request named, 14 days, 256 at most),
`checkpoints/<sid>.md`.

## Verdict feedback

Each session's row moves through these states; `pause` prints each change as
it happens, then the table and the summary (`3/4 safe`).

| State | Shown as | Terminal |
| --- | --- | --- |
| `safe` | `SAFE` | yes |
| `not-safe` | `NOT SAFE: <reason>` | yes |
| `resumed` | `resumed (woken)` / `resumed (next tool call)` | yes |
| `superseded` | superseded by a newer request before it answered | yes |
| `delivered` | delivered, working through the protocol | no |
| `pending` | waiter armed, delivering | no |
| `unarmed` | no waiter yet: gets it on its next tool call or turn | no |
| `lost` | delivered, then the session ended without a verdict | yes |
| `gone` | not running (ended before delivery) | yes |
| `expired` | request expired before delivery / delivered, no verdict within the hour | yes |

A verdict wins over liveness: a session that answered SAFE and then exited
stays SAFE. Records left by an older request are ignored. The summary is
`ok` only when every row reached the good end (all SAFE for a pause, all
resumed for a resume), and an empty target list is never `ok`.

## Resume

`resume` sends the **resume protocol** to every running target: re-read the
checkpoint, restart what the pause stopped, carry on. A target that is no
longer running but has a **pending checkpoint** is reopened through the same
path as `claudectl session open` (see [[Tabs]]), in the cwd stored in the
request or the newest snapshot that holds it, with the resume protocol and the
checkpoint path as its first message. `--dry-run` prints that plan without
launching anything.

A checkpoint is pending while it is newer than `<sid>.resumed.json`, younger
than 14 days, and the session did no work after it: a transcript written more
than 10 minutes after the checkpoint means you carried on in that session
without a resume, and its old next steps are never replayed. A delivered
resume, or a reopen with the checkpoint, marks it resumed, so an old
checkpoint is not re-injected on every later `open`. The reopen prompt says
when that session paused (its verdict, else its checkpoint), not when the last
request was sent. On a plain
`claudectl session open` (or the panels' Reopen), a session with a pending
checkpoint gets the resume protocol instead of the generic restart prompt;
`--prompt=TEXT` and `--no-prompt` still win.

## Limits

- Each open session keeps one idle `node` waiter (tens of MB) for as long as
  it is open, and the backstop starts `node` on every tool call. That is why
  the target is opt-in.
- A session idle for more than a day outlives its waiter (Claude Code ends a
  hook at its timeout): it gets the request on its next tool call or turn. The
  timeout stays at a day because the waiter is what wakes a session left idle
  overnight. The waiter checks only on writes to `request.json`, coalesced to
  one check per 250 ms, plus a 15 s poll.
- A session that started before the install has no waiter until its next turn
  ends; until then nothing can wake it, and its row says `no waiter yet`.
- Whether the session then acts on the protocol is up to the model: the
  message names its origin, but a model may treat hook text as untrusted. A
  row stuck at `delivered` is that case; the exit status stays 3.
- `request.json` is not cleared after use, so the backstop reads it on every
  tool call. Nothing is delivered from it once its hour has passed.
- The panels show the last request until a newer one: an old one stays on
  screen with its final states.

## Remove it

```bash
./install.sh --uninstall pause
```

removes our three hook entries and leaves every other hook in
`~/.claude/settings.json` as it was.
