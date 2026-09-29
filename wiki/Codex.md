# OpenAI Codex logins

The same thing [[Accounts]] does for Claude Code, for the ChatGPT logins the
`codex` CLI holds - and nothing more than that. It is a **sibling** of the
Claude vault: off by default in both panels, its own store directory, its own
CLI group, and no path from it to a Claude login.

```bash
claudectl codex save PLUS      # the Codex login you are on now
codex login                    # sign in to the other account, once
claudectl codex save WORK
claudectl codex use PLUS       # from now on: no browser, no logout
```

## What a switch does

A Codex login is exactly **one file**:

| What | Where |
| --- | --- |
| The ChatGPT OAuth tokens | `$CODEX_HOME/auth.json`, else `~/.codex/auth.json` |

Switching replaces that file and nothing else. `config.toml`, your history, MCP
servers and the session transcripts all stay. A `codex` process already running
keeps the login it started with until it restarts.

Before anything is overwritten, the live login is written back into its own
saved profile - the CLI rotates its tokens as it runs, and a copy taken at save
time would otherwise rot. A live login that was **never saved** is refused
rather than overwritten: unlike a Claude login, a Codex `auth.json` has no
account block to derive a parking name from, so there is nothing safe to call
it.

## What is read, and what is never sent

| Read | Why |
| --- | --- |
| `$CODEX_HOME/auth.json` (else `~/.codex/auth.json`) | the login itself: the ChatGPT id / access / refresh tokens the `codex` CLI wrote |
| `$CODEX_HOME/sessions/**/*.jsonl` (read-only, tail only) | the rate limits the API returned on a recent turn - see below |

| Written | Why |
| --- | --- |
| `<state dir>/claude-usage-panel/codex-accounts/<NAME>.json`, mode `0600` | the saved copies |
| `auth.json` | only by `use` / the switch button |

The state dir is `~/.local/state` on Linux (`$XDG_STATE_HOME`) and
`~/Library/Application Support` on macOS - **next to** the Claude store, never
inside it.

**Nothing is uploaded.** There is no network client anywhere on the Codex path:
every operation is a local file read or a local file write.

**No token is ever minted here.** The Claude store refreshes a parked login
because Anthropic documents that grant; OpenAI's is the `codex` CLI's to use.
So a saved login whose tokens have lapsed is *reported* - `expired`, "needs
`codex login`" - and never silently exchanged.

The identity in a list (the email, the plan) comes from the id token's claims,
read **without verifying the signature**. That is deliberate: the token is read
from a file only you can write, it is never used as proof of anything, and the
claims are used for exactly two things - naming the account and labelling its
plan. Verifying it would need OpenAI's keys and would still be reading the same
file.

## Usage figures

**OpenAI publishes no plan-usage endpoint** of the kind Anthropic's
`/api/oauth/usage` is. There is nothing to poll, and this project does not
pretend otherwise.

What the `codex` CLI *does* do is record, in its own session transcript, the
rate limits the API returned with a turn. Those are real figures - so they are
shown, as estimates, stamped with when they were captured:

```console
$ claudectl codex usage
5h limit        33%  resets in 4h12m
Weekly limit     8%  resets in 5d
est. - recorded by the codex CLI at 2026-09-13T11:45:40.000Z, not read now
```

Every card carries `provenance: "estimated"` and a `capturedAt`, in the CLI,
the panels and the MCP tool alike. When there is nothing usable to show, the
answer says which:

| Reason | Means |
| --- | --- |
| `no_sessions` | the `codex` CLI has written no sessions on this machine |
| `no_snapshot` | the recent sessions carry no rate limits |
| `stale` | the newest reading is old enough that its window has rolled over |

There is no fourth case in which a number is invented.

## Commands

```console
claudectl codex list [--json]          saved Codex logins, the active one marked
claudectl codex current [--json]       the active Codex login's name
claudectl codex save NAME [--force]    save the current Codex login as NAME
claudectl codex use NAME [--json]      make NAME the current Codex login
claudectl codex remove NAME            forget a saved Codex login
claudectl codex usage [--json]         the newest rate limits the codex CLI recorded
```

There is no `refresh` command, for the reason above.

## In the panels

Off by default in both:

- **GNOME** - *Preferences ▸ Integrations ▸ OpenAI Codex ▸ Show saved Codex
  logins*. With it off, nothing under the Codex home is opened at all.
- **macOS** - *Settings ▸ Integrations ▸ OpenAI Codex*. The section is drawn
  below everything Claude; this app is Claude-first and a sibling vault does
  not get to reorder the popup.

## In the MCP tool

Four tools, alongside the Claude ones:

| Tool | Does |
| --- | --- |
| `list_codex_accounts` | the saved Codex logins, which is active, and each one's token state |
| `save_codex_account` | save the current Codex login under a name |
| `switch_codex_account` | make a saved one the current login |
| `get_codex_usage` | the newest recorded rate limits, or the reason there are none |

`get_codex_usage`'s schema pins `provenance` to the constant `"estimated"` and
requires `capturedAt`, so a model cannot read one of these as a live figure.

## See also

- [[Accounts]] - the same pattern for Claude Code logins
- [[Cache]] - `codex-sessions` is a *history* entry there, never a cache
