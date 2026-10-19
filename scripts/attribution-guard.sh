#!/usr/bin/env bash
#
# attribution-guard.sh — the author of record is the human who owns the change.
#
# An assistant that signs its work leaves three kinds of trace, and this check
# fails the pull request on all three:
#
#   1. Identity. Every commit's author and committer address is on the
#      allow-list, or the commit belongs to an allow-listed bot. Anything else
#      is somebody else's name on this repository's history.
#   2. Commit messages. A `Co-authored-by:` trailer naming an address that is
#      not on the allow-list, or an assistant footer — "Generated with …", a
#      cursor.com/agents link, a Claude Code attribution, a robot emoji.
#   3. The pull request body. The CURSOR_AGENT_PR_BODY_BEGIN/END markers, an
#      agent run link, an "Open in …" footer image, or "Generated with Claude
#      Code".
#
# It is deliberately narrow about prose. The bare word "cursor" is a database
# cursor far more often than it is a tool, so only footer shapes, trailer keys,
# and URLs count — never a lone word in a sentence.
#
# The allow-list, in order of precedence:
#
#   .github/attribution-allow.txt   one entry per line, `#` comments
#   $ATTRIBUTION_ALLOW              the same entries, comma- or space-separated
#   fschmutz@premaccess.com         the built-in default, used when neither of
#                                   the above names a single address
#
# An entry is a plain address, `committer:ADDRESS` (accepted as the committer
# only — this is how a GitHub web merge is allowed), or `bot:LOGIN`. Three
# structural entries are always present and need no configuration:
# `committer:noreply@github.com`, and the `dependabot[bot]`,
# `github-actions[bot]` and `renovate[bot]` logins.
#
# Usage:
#   scripts/attribution-guard.sh [-R OWNER/REPO] [--pr NUMBER]
#   scripts/attribution-guard.sh --commits-file FILE --body-file FILE
#
#   -R, --repo OWNER/REPO   default: $GITHUB_REPOSITORY
#       --pr NUMBER         default: the pull request in $GITHUB_EVENT_PATH
#       --commits-file F    read the commits from F instead of calling the API;
#                           F holds what `gh api …/commits --paginate` prints
#       --body-file F       read the pull request body from F
#       --no-body           check the commits only
#       --refresh-body      re-read the body from the API even when the event
#                           payload carries one (implied by action `edited`)
#
# Output:  `::error::` annotations under GitHub Actions, `sha: reason` and
#          `PR body: reason` otherwise. Exit 0 clean, 1 on a violation, 2 on a
#          usage or environment problem.
# Needs:   bash 3.2+, jq, and gh only when it has to call the API.
# Format:  shellcheck clean; shfmt -i 2 -ci clean.
#
# This file is generic on purpose: other repositories copy it byte for byte,
# and point `.github/attribution-allow.txt` at their own owner. Change it here,
# then copy it again; do not fork it in place.
#
set -uo pipefail

readonly ALLOW_FILE=".github/attribution-allow.txt"
readonly DEFAULT_EMAIL="fschmutz@premaccess.com"
readonly DEFAULT_COMMITTER="noreply@github.com"
readonly DEFAULT_BOTS="dependabot[bot] github-actions[bot] renovate[bot]"
readonly NOREPLY_HOST="users.noreply.github.com"

readonly COAUTHOR_RE='^[[:space:]]*co-authored-by[[:space:]]*:'
readonly EMAIL_RE='<([^<>]+)>'
readonly TRAILER_RE='^[[:space:]]*(generated-with|generated-by|assisted-by|ai-assisted|cursor-agent|claude-code)[[:space:]]*:'

commits_file=""
body_file=""
repo="${GITHUB_REPOSITORY:-}"
pr="${ATTRIBUTION_PR:-}"
check_body=true
refresh_body=false
failures=0

allow_emails=$'\n'
allow_committers=$'\n'
allow_bots=$'\n'

usage() {
  sed -n '35,50p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "attribution-guard: $1" >&2
  exit 2
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "${s}"
}

# report SHA REASON — SHA empty means the pull request body.
report() {
  local where="PR body"
  failures=$((failures + 1))
  if [ -n "$1" ]; then
    where="${1:0:12}"
  fi
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error title=attribution guard::${where}: $2"
  else
    echo "${where}: $2" >&2
  fi
}

info() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::notice title=attribution guard::$1"
  else
    echo "attribution-guard: $1"
  fi
}

# --- the allow-list -----------------------------------------------------------

# list_has NEEDLE LIST — LIST is newline-delimited and newline-terminated. The
# needle is quoted inside the pattern, so `dependabot[bot]` is matched as text
# rather than as a character class.
list_has() {
  case "$2" in
    *$'\n'"$1"$'\n'*) return 0 ;;
  esac
  return 1
}

allow_add() {
  local entry
  entry="$(lower "$(trim "$1")")"
  case "${entry}" in
    bot:*) allow_bots="${allow_bots}$(trim "${entry#bot:}")"$'\n' ;;
    committer:*) allow_committers="${allow_committers}$(trim "${entry#committer:}")"$'\n' ;;
    "") ;;
    *) allow_emails="${allow_emails}${entry}"$'\n' ;;
  esac
}

# Reads entries from stdin, one per line, `#` starting a comment.
allow_read() {
  local raw line
  while IFS= read -r raw || [ -n "${raw}" ]; do
    line="$(trim "${raw%%#*}")"
    [ -n "${line}" ] || continue
    allow_add "${line}"
  done
}

load_allow_list() {
  local bot
  if [ -f "${ALLOW_FILE}" ]; then
    allow_read <"${ALLOW_FILE}"
  fi
  if [ -n "${ATTRIBUTION_ALLOW:-}" ]; then
    allow_read <<<"$(printf '%s' "${ATTRIBUTION_ALLOW}" | tr ', ' '\n')"
  fi
  if [ "${allow_emails}" = $'\n' ]; then
    allow_add "${DEFAULT_EMAIL}"
  fi
  allow_add "committer:${DEFAULT_COMMITTER}"
  for bot in ${DEFAULT_BOTS}; do
    allow_add "bot:${bot}"
  done
}

# login_allowed LOGIN — an allow-listed bot account.
login_allowed() {
  local login
  login="$(lower "$1")"
  [ -n "${login}" ] || return 1
  list_has "${login}" "${allow_bots}"
}

# email_allowed ADDRESS ROLE — ROLE is `author` or `committer`.
email_allowed() {
  local email role local_part bot
  email="$(lower "$1")"
  role="$2"
  [ -n "${email}" ] || return 1
  list_has "${email}" "${allow_emails}" && return 0
  if [ "${role}" = committer ]; then
    list_has "${email}" "${allow_committers}" && return 0
  fi
  # A bot commits as 49699333+dependabot[bot]@users.noreply.github.com.
  case "${email}" in
    *+*@"${NOREPLY_HOST}")
      local_part="${email#*+}"
      while IFS= read -r bot; do
        [ -n "${bot}" ] || continue
        [ "${local_part}" = "${bot}@${NOREPLY_HOST}" ] && return 0
      done <<<"${allow_bots}"
      ;;
  esac
  return 1
}

# --- the footer patterns ------------------------------------------------------

# forbidden_reason LINE — prints why this line is an assistant footer and
# returns 0 when it is one.
forbidden_reason() {
  local lowered
  lowered="$(lower "$1")"

  case "${lowered}" in
    *cursor_agent_pr_body_begin* | *cursor_agent_pr_body_end*)
      printf '%s' "Cursor agent pull request body marker"
      return 0
      ;;
    *cursor.com/agents* | *cursor.com/background-agent*)
      printf '%s' "link to an agent run"
      return 0
      ;;
    *claude.ai/code* | *anthropic.com/claude*)
      printf '%s' "link to an assistant product page"
      return 0
      ;;
    *cursoragent@cursor.com*)
      printf '%s' "agent commit address"
      return 0
      ;;
    *"claude code"*)
      printf '%s' "assistant attribution"
      return 0
      ;;
    *"cursor agent"* | *"background agent"*)
      printf '%s' "agent attribution"
      return 0
      ;;
    *"open in cursor"* | *"open in web"*)
      printf '%s' "\"Open in …\" agent footer"
      return 0
      ;;
    *"🤖"*)
      printf '%s' "robot-emoji attribution footer"
      return 0
      ;;
  esac

  # "Generated with" on its own is ordinary English — screenshots are generated
  # with Playwright. It is a footer only when it names the thing that wrote it.
  case "${lowered}" in
    *"generated with"* | *"generated by"*)
      case "${lowered}" in
        *claude* | *cursor* | *codex* | *copilot* | *chatgpt* | *gpt-* | *gemini* | *anthropic* | *openai*)
          printf '%s' "\"generated with\" assistant footer"
          return 0
          ;;
      esac
      ;;
  esac

  if [[ "${lowered}" =~ ${TRAILER_RE} ]]; then
    printf '%s' "assistant attribution trailer"
    return 0
  fi

  return 1
}

# --- the checks ---------------------------------------------------------------

check_identity() {
  local sha="$1" author_email="$2" committer_email="$3" author_login="$4" committer_login="$5"
  if ! login_allowed "${author_login}" && ! email_allowed "${author_email}" author; then
    report "${sha}" "author <${author_email:-unset}> is not on the attribution allow-list (${ALLOW_FILE})"
  fi
  if ! login_allowed "${committer_login}" && ! email_allowed "${committer_email}" committer; then
    report "${sha}" "committer <${committer_email:-unset}> is not on the attribution allow-list (${ALLOW_FILE})"
  fi
}

# check_message_line SHA LINE — one line of one commit message.
check_message_line() {
  local sha="$1" text="$2" lowered value email reason
  lowered="$(lower "${text}")"

  if [[ "${lowered}" =~ ${COAUTHOR_RE} ]]; then
    value="$(trim "${text#*:}")"
    email=""
    if [[ "${value}" =~ ${EMAIL_RE} ]]; then
      email="$(lower "${BASH_REMATCH[1]}")"
    fi
    if [ -z "${email}" ]; then
      report "${sha}" "Co-authored-by trailer with no address: ${value}"
    elif ! email_allowed "${email}" author; then
      report "${sha}" "Co-authored-by: <${email}> is not on the attribution allow-list"
    fi
    return 0
  fi

  if reason="$(forbidden_reason "${text}")"; then
    report "${sha}" "commit message: ${reason} — \"$(trim "${text}")\""
  fi
}

check_body_text() {
  local line n=0 reason
  while IFS= read -r line || [ -n "${line}" ]; do
    n=$((n + 1))
    if reason="$(forbidden_reason "${line}")"; then
      report "" "${reason} on line ${n} — \"$(trim "${line}")\""
    fi
  done
}

# --- input --------------------------------------------------------------------

# A page of `gh api --paginate` is its own JSON array; `jq -s add` makes them
# one. A single-array fixture file goes through unchanged.
commits_json() {
  if [ -n "${commits_file}" ]; then
    [ -f "${commits_file}" ] || die "${commits_file} does not exist"
    jq -s 'add // []' "${commits_file}"
    return
  fi
  [ -n "${repo}" ] || die "no repository — pass -R OWNER/REPO or set GITHUB_REPOSITORY"
  [ -n "${pr}" ] || die "no pull request number — pass --pr N"
  command -v gh >/dev/null 2>&1 || die "gh is required to read the commits"
  gh api "repos/${repo}/pulls/${pr}/commits" --paginate | jq -s 'add // []'
}

# Prints the pull request body, or nothing when there is none to read.
pull_request_body() {
  local payload_body=""
  if [ -n "${body_file}" ]; then
    [ -f "${body_file}" ] || die "${body_file} does not exist"
    cat "${body_file}"
    return
  fi
  if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
    payload_body="$(jq -r '.pull_request.body // ""' "${GITHUB_EVENT_PATH}")"
    if [ "$(jq -r '.action // ""' "${GITHUB_EVENT_PATH}")" = "edited" ]; then
      refresh_body=true
    fi
  fi
  # On `edited` the payload is a snapshot of the edit that triggered the run;
  # re-reading is what makes a second edit in the same minute still checked.
  if [ "${refresh_body}" = true ] && [ -n "${repo}" ] && [ -n "${pr}" ] &&
    command -v gh >/dev/null 2>&1; then
    gh api "repos/${repo}/pulls/${pr}" --jq '.body // ""' && return
  fi
  printf '%s' "${payload_body}"
}

# --- main ---------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    -R | --repo)
      repo="${2:-}"
      shift 2
      ;;
    --pr)
      pr="${2:-}"
      shift 2
      ;;
    --commits-file)
      commits_file="${2:-}"
      shift 2
      ;;
    --body-file)
      body_file="${2:-}"
      shift 2
      ;;
    --no-body)
      check_body=false
      shift
      ;;
    --refresh-body)
      refresh_body=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "attribution-guard: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || die "jq is required but not installed"

if [ -z "${pr}" ] && [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
  pr="$(jq -r '.pull_request.number // ""' "${GITHUB_EVENT_PATH}")"
fi

load_allow_list

commits="$(commits_json)" || die "could not read the pull request commits"
if ! printf '%s' "${commits}" | jq -e 'type == "array"' >/dev/null 2>&1; then
  die "the commits payload is not a JSON array"
fi

count="$(printf '%s' "${commits}" | jq 'length')"
if [ "${count}" -eq 0 ]; then
  die "the pull request has no commits — nothing to check, which is never right"
fi

while IFS=$'\t' read -r kind sha f3 f4 f5 f6; do
  case "${kind}" in
    C) check_identity "${sha}" "${f3}" "${f4}" "${f5}" "${f6}" ;;
    M) check_message_line "${sha}" "${f3}" ;;
  esac
done <<EOF
$(printf '%s' "${commits}" | jq -r '
  .[] | . as $c
  | ( [ "C", $c.sha,
        ($c.commit.author.email // ""), ($c.commit.committer.email // ""),
        ($c.author.login // ""), ($c.committer.login // "") ] | @tsv ),
    ( ($c.commit.message // "") | split("\n")[] | [ "M", $c.sha, . ] | @tsv )
')
EOF

if [ "${check_body}" = true ]; then
  body="$(pull_request_body)"
  if [ -z "${body}" ] && [ -z "${body_file}" ] && [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    info "the pull request body is empty"
  fi
  check_body_text <<EOF
${body}
EOF
fi

if [ "${failures}" -gt 0 ]; then
  cat >&2 <<'HINT'

attribution-guard: the author of record is the human who owns the change.

  PR body  — strip the footer, which touches nothing else:
               gh api -X PATCH repos/OWNER/REPO/pulls/N -f body="$(cat body.md)"
  commits  — a wrong author, committer, or trailer is in the history, and
             fixing it rewrites it. That is the repository owner's call, and
             the answer has to be an explicit yes before you run:
               git rebase -i --exec 'git commit --amend --no-edit \
                 --author="NAME <ADDRESS>" --reset-author' ORIGIN/BASE
             then force-push the pull request branch only, never main.

Allow an address deliberately by adding it to .github/attribution-allow.txt in
its own reviewed commit. Never widen it to land a change.
HINT
  echo "attribution-guard: ${failures} violation(s) across ${count} commit(s)" >&2
  exit 1
fi

info "${count} commit(s) and the pull request body carry no foreign attribution"
