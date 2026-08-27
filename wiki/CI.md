# CI and the merge process

Everything that gates a change into `main` lives in one workflow,
[`.github/workflows/ci.yml`](https://github.com/fschmutz/claude-usage-panel/blob/main/.github/workflows/ci.yml),
and is summarized by one check named **`ci-gate`**.

## The one-required-check rule

`ci-gate` is the **only** status check the branch ruleset requires. It runs
nothing itself: it `needs:` every other job and fails unless all of them
reported `success`.

```text
lint (pre-commit) ─┐
js ────────────────┤
screenshots ───────┤
swift-core ────────┼──▶ ci-gate ──▶ the only context the ruleset requires
macos-app ─────────┤
bash32 ────────────┘
```

`bash32` runs `scripts/bash32-smoke.sh` inside a `bash:3.2` container - the
version macOS still ships as `/bin/bash`, and the one the launchd agents
invoke. Every other shell gate runs on ubuntu's bash 5, where the 3.2 traps are
invisible: expanding `"${arr[@]}"` on an **empty** array aborts under `set -u`
in 3.2 and is fine in 4.4+, so a guard that reads correctly on Linux can die on
a stock Mac. The script parses every shell script with `bash -n` and dry-runs
every target `install.sh --list` advertises, so a new target is covered the day
it lands without editing the workflow.

Why it is built this way:

- **Adding, renaming or removing a job never touches branch protection.** The
  required context is stable forever; the job list is free to change.
- **A required context can no longer go stale.** This repo lost a week to
  exactly that: the ruleset required `analyze`, the job name inside
  `codeql.yml`. Enabling CodeQL *default setup* made GitHub auto-disable that
  workflow, so `analyze` could never report again - and every pull request sat
  at `BLOCKED` with no failing check to point at. A fan-in job cannot drift
  from the ruleset, because there is only ever one name in it.
- **A skipped job is a failure, not a pass.** `ci-gate` runs with
  `if: always()` and asserts `result == "success"` per job. Without
  `if: always()` it would be *skipped* when a dependency failed - and a skipped
  required check reports neutral, which GitHub treats as passing. That single
  line is the difference between a gate and a decoration.

### Changing what CI runs

Add the job to `ci.yml` and add its id to `needs:` in `ci-gate`. That is the
whole change - **do not add a new required context to the ruleset.** If you
ever find yourself editing the ruleset's required checks, something is wrong.

## Supply-chain rules for workflows

- **Actions are pinned to a full commit SHA**, never a tag, with the human
  version in a trailing comment. A tag is mutable: whoever controls the
  upstream repo can repoint `v7` at new code that runs with your token.
  Dependabot rewrites both the SHA and the comment, so this costs no upkeep.
- **Dependabot waits 7 days** (`cooldown`) before proposing a new release. A
  compromised upstream is normally caught and yanked inside that window.
- **`permissions:` is least-privilege**, declared at the *job* level where a
  write is genuinely needed and `{}` at the workflow level. `ci.yml` never
  writes anything.
- **`persist-credentials: false` on every checkout.** By default
  `actions/checkout` leaves a usable token in `.git/config`, which any later
  step - or any script it runs - can read.
- **Two linters enforce the above.** `actionlint` checks the workflow is
  *valid*; `zizmor` checks it is *safe* (unpinned actions, over-broad
  permissions, credential persistence, template injection). Both run in
  `pre-commit`, so they run locally and in the `lint` job.

```bash
pre-commit run zizmor --all-files      # what CI runs
uvx zizmor --no-online-audits .github/workflows/
```

## Code scanning

CodeQL runs through **default setup** (repo Settings ▸ Code security), covering
`actions`, `javascript-typescript` and `swift`. There is deliberately **no
CodeQL workflow file** - GitHub disables an advanced workflow the moment
default setup is on, leaving a dead file that looks alive.

Default setup analyses `main` on a schedule, so its pull-request check reports
*neutral* ("configurations not found") rather than a pass. That is expected,
and it is why CodeQL is **not** part of `ci-gate`: alerts are reviewed in the
Security tab, they do not block a merge.

## Pull requests from forks

Workflows on a fork's pull request need a maintainer to click **Approve and
run** the *first* time that person contributes. The policy is
`first_time_contributors`:

```bash
gh api repos/fschmutz/claude-usage-panel/actions/permissions/fork-pr-contributor-approval
```

This is the setting to keep. A fork PR runs the contributor's own workflow
code, so the first run is a deliberate human decision; after that, everything
that person opens runs automatically. Loosening it to `never` would let an
unreviewed first-time PR execute arbitrary code in CI.

Two things to check before approving a first-time run:

1. **Read the workflow diff**, if any. A PR that edits `.github/workflows/**`
   is the one to read line by line.
2. **Check commit attribution.** The ruleset sets
   `require_extra_approval_for_unattributed_changes`, so a commit whose author
   email is not linked to a GitHub account needs an explicit approval on top of
   CI. Confirm the person is who the PR says they are:

   ```bash
   gh api repos/fschmutz/claude-usage-panel/pulls/<N>/commits \
     --jq '.[] | {sha: .sha[0:8], github_user: .author, email: .commit.author.email}'
   ```

   `github_user: null` means unattributed - the contributor can fix it by
   adding that email to their GitHub account.

## Diagnosing a stuck pull request

A PR showing `BLOCKED` with everything green means a **required context is not
reporting**. Compare what the ruleset demands against what actually ran:

```bash
# what the ruleset requires
gh api repos/fschmutz/claude-usage-panel/rules/branches/main \
  --jq '.[] | select(.type=="required_status_checks") | .parameters.required_status_checks'

# what the PR head actually reported
gh api repos/fschmutz/claude-usage-panel/commits/$(gh pr view <N> --jq .headRefOid --json headRefOid)/check-runs \
  --jq '.check_runs[] | [.name, .conclusion] | @tsv'

# a workflow GitHub disabled behind your back
gh api repos/fschmutz/claude-usage-panel/actions/workflows \
  --jq '.workflows[] | select(.state != "active") | [.name, .path, .state] | @tsv'
```

A name in the first list that is missing from the second is the blocker.
