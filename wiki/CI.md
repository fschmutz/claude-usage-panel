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
private-names ─────┤
js ────────────────┤
screenshots ───────┤
i18n ──────────────┤
swift-core ────────┼──▶ ci-gate ──▶ the only context the ruleset requires
macos-app ─────────┤
bash32 ────────────┤
plugin-validate ───┤
attribution-guard ─┤
deps ──────────────┘
```

`i18n` runs `scripts/update-po.sh --check` (every `_()` string of the GNOME
extension reached the template and every catalog) and compiles each catalog
with `msgfmt --check`; pre-commit's `i18n-catalogs` hook runs the same check
locally but skips it when gettext is missing, so this job is the one that
cannot be skipped.

`private-names` runs `scripts/check-private-names.sh --all` over the tree and
the full history (diffs, messages, identities), with the list and an optional
mailmap written from the `PRIVATE_NAMES` and `PRIVATE_MAILMAP` secrets - this
repository is public, so neither lives in it. A missing list fails. A fork PR
gets no secrets: the job says so and passes, and the merge on main is checked.
Commits published before the guard ran in CI are declared one by one (id,
`diff` or `message`, reason) in `.github/private-names-history`; an entry that
stops matching fails.
Findings print where, never what.

`deps` runs `node scripts/check-deps.mjs`, on every push and weekly on a
schedule: every pinned version (actions, hook revs, the npm/pip tool pins under
`.github/`, the Docker images and their digests, the Node lines) against its
upstream, and every pin and tool tree against OSV / `npm audit`. A pin is
current, or declared in `.github/dependency-holds` with its reason (version-
pinned, so a hold expires when upstream moves on; a hold that matches nothing
fails). A release still inside Dependabot's window (weekly + 7-day cooldown,
14 days) or with its Dependabot PR open is in flight, not stale. An upstream
that does not answer is UNKNOWN and fails.

`attribution guard` runs `scripts/attribution-guard.sh`: the author of record
is the human who owns the change. It fails a pull request whose commits are
authored or committed by an address that
[`.github/attribution-allow.txt`](https://github.com/fschmutz/claude-usage-panel/blob/main/.github/attribution-allow.txt)
does not name, that carry a `Co-authored-by:` trailer naming anyone else, or
that end in an assistant footer - and the same for the pull request **title and
body** (the agent body markers, a link to an agent run, an "Open in …" footer,
a "Generated with …" line).

The **name** beside the address is a check of its own, and an allow-listed
address does not excuse it: a commit authored by "Cursor Agent" or "Claude"
fails whatever address it carries, because an assistant committing through
somebody's account still signs the history with its own name. A real person
whose name collides - a Jean-Claude, a Gemini - is exempted by a `name:` line
in the allow file, and nothing else gets past that rule.

It is deliberately narrow about prose: the bare word "cursor" is a database
cursor far more often than it is a tool, so only footer shapes, trailer keys
and URLs count, and the two bare agent phrases are matched at the head of a
line only. A commit message naming three assistants mid-sentence - which is
what a commit changing this guard looks like - passes.

Deleting the allow file does not open the gate: the guard warns, falls back to
the address built into the script, and keeps failing everybody else.
`scripts/tests/attribution-guard-test.sh` runs first, 33 cases over
`scripts/tests/fixtures/` - a guard that has quietly stopped matching is worse
than no guard, because the check is green either way.

The script, its suite and its fixtures are copied **byte for byte** from the
shared template repository, which is why they are formatted to that repo's
style and are excluded from the `no-em-dash` hook: fix a rule there and copy it
again, never fork it in place. Only the allow list is this repo's own.

Your own address has to be on that list before your commits pass, so a first
pull request from a new contributor is red until a maintainer adds it in its
own commit. Widening the list is never a step on the way to a green check.

The guard reads the commits through `repos/:repo/pulls/:number/commits`, so it
runs on pull requests only; nothing reaches `main` another way. A title and a
body are editable after the fact, and `ci.yml` does not run on the `edited`
type, so the separate
[`attribution-guard.yml`](https://github.com/fschmutz/claude-usage-panel/blob/main/.github/workflows/attribution-guard.yml)
workflow runs the same two commands on exactly that event, as
`attribution guard (edited title or body)`, and the script re-reads both fields
from the API rather than trusting the payload's snapshot of the edit. It is the
one gate that is deliberately not behind `ci-gate`: a description edited after
the last push would otherwise rebuild every other job, macOS included.

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
- **Everything else is pinned too, and Dependabot bumps it.** Pre-commit hook
  revs are frozen to a commit SHA with the tag in a `# frozen: vX` comment
  (Dependabot's pre-commit ecosystem). The pre-commit the `lint` job installs
  is pinned in `.github/pre-commit/requirements.txt` (pip ecosystem: a version
  inside a `run:` line is invisible to every ecosystem). The bash 3.2 image of
  the `bash32` job is pinned by digest in `.github/bash32/Dockerfile` (docker
  ecosystem, held to 3.2).
  The Claude Code CLI the `plugin-validate` job runs is pinned in
  `.github/claude-cli/package-lock.json`, and the knip of the `knip` hook in
  `.github/knip/package-lock.json` (npm ecosystem).
- **Dependabot waits 7 days** (`cooldown`) before proposing a new release. A
  compromised upstream is normally caught and yanked inside that window.
- **`permissions:` is least-privilege.** The workflow level grants no write
  scope: `{}` (`release.yml`, `wiki.yml`) or read-only scopes every job
  inherits (`ci.yml`'s `contents: read` - it never writes anything). A write
  scope is declared only on the job that needs it. zizmor does not catch a
  workflow-level write (it reports a workflow-level `contents: write` as no
  finding), so `tests/docs.test.js` gates this one.
- **`persist-credentials: false` on every checkout.** By default
  `actions/checkout` leaves a usable token in `.git/config`, which any later
  step - or any script it runs - can read.
- **Two linters enforce the rest.** `actionlint` checks the workflow is
  *valid*; `zizmor` checks it is *safe* (unpinned actions, a workflow with no
  `permissions:`, credential persistence, template injection). Both run in
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
