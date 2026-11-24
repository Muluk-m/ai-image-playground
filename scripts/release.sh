#!/bin/sh
set -eu
# Idempotent production release entrypoint for both Nain and parallel Agents.
#   scripts/release.sh [--include <sha>] [--mode incremental|full] [--reason <text>]
#                      [--pin-sha] [--no-watch] [--wait-ci <seconds>]
#
# Prevents duplicate production builds when multiple Agents finish around the same time:
#   1. Already live: if every production side affected by --include (or all of origin/main)
#      already serves that commit or a descendant, skip triggering a new deploy.
#   2. Piggyback: if an in_progress or queued Deploy production run already covers --include
#      (or origin/main), attach to and watch that run instead of starting another one.
#   3. CI gate: wait for main's `Web checks` to pass before dispatching (avoids instant red runs),
#      then re-check live/active deploys in case another Agent dispatched while waiting.
#   4. Dispatch: trigger Deploy production once, resolve the exact new run ID, and watch it.

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/lib/release-paths.sh
. "$here/lib/release-paths.sh"

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [options]

Options:
  --include <sha>         Ensure this main commit is shipped (default: origin/main tip)
  --mode <mode>           incremental (default) or full
  --reason <text>         Optional release note written to the workflow job summary
  --pin-sha               Pin deploy.yml to the dispatch commit instead of auto-advancing
  --no-watch              Return after confirming/dispatching without running `gh run watch`
  --wait-ci <seconds>     Max seconds to wait for main Web checks (default: 600)
  -h, --help              Show this help
EOF
}

include_arg=
mode=incremental
reason=
pin_sha=false
watch=true
wait_ci=${RELEASE_WAIT_CI_SECONDS:-600}
poll_interval=${RELEASE_POLL_INTERVAL:-15}
dispatch_wait=${RELEASE_DISPATCH_WAIT_SECONDS:-30}
repo=${RELEASE_REPO:-Muluk-m/ai-image-playground}

while [ "$#" -gt 0 ]; do
  case $1 in
    --include)
      [ "$#" -ge 2 ] || { echo "Missing value for --include" >&2; exit 2; }
      include_arg=$2
      shift 2
      ;;
    --mode)
      [ "$#" -ge 2 ] || { echo "Missing value for --mode" >&2; exit 2; }
      mode=$2
      shift 2
      ;;
    --reason)
      [ "$#" -ge 2 ] || { echo "Missing value for --reason" >&2; exit 2; }
      reason=$2
      shift 2
      ;;
    --pin-sha)
      pin_sha=true
      shift
      ;;
    --no-watch)
      watch=false
      shift
      ;;
    --wait-ci)
      [ "$#" -ge 2 ] || { echo "Missing value for --wait-ci" >&2; exit 2; }
      wait_ci=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case $mode in
  incremental | full) ;;
  *)
    echo "Unknown mode '$mode'; expected incremental or full." >&2
    exit 2
    ;;
esac

env_file=${PAGES_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/pages.env}
if [ -f "$env_file" ]; then
  # shellcheck source=/dev/null
  . "$env_file"
fi
api=${RELEASE_API:-${PAID_BFF_BASE_URL:-https://api.muvloom.online}}
web=${RELEASE_WEB:-${PAID_PUBLIC_ORIGIN:-https://muvloom.online}}
admin=${RELEASE_ADMIN:-${ADMIN_PUBLIC_ORIGIN:-https://admin.muvloom.online}}

[ "${RELEASE_FETCH:-1}" = 0 ] || git fetch -q origin main
target=$(git rev-parse --verify "origin/main^{commit}")
if [ -n "$include_arg" ]; then
  include=$(git rev-parse --verify "${include_arg}^{commit}" 2>/dev/null) || {
    echo "Commit '$include_arg' not found in git history." >&2
    exit 1
  }
  if ! git merge-base --is-ancestor "$include" "$target" 2>/dev/null; then
    echo "Commit $include is not on origin/main ($target); merge it to main before releasing." >&2
    exit 1
  fi
else
  include=$target
fi

# Print the pending release checklist before deciding.
RELEASE_STATUS_FETCH=0 RELEASE_API="$api" RELEASE_WEB="$web" RELEASE_ADMIN="$admin" \
  "$here/release-status.sh" "$target"
echo

# served_commit <api|site> <url>: prints resolved 40-hex commit or empty string.
served_commit() {
  if [ "$1" = api ]; then endpoint=${2%/}/health; else endpoint=${2%/}/version.json; fi
  body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null) || return 0
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ "$1" = api ]; then
    commit=$(printf '%s\n' "${version%%+*}" | sed -n 's/^\([0-9a-f]\{40\}\)$/\1/p')
  else
    commit=$(printf '%s\n' "$version" | sed -n 's/^\([0-9a-f]\{7,40\}\)[+-].*/\1/p')
  fi
  [ -n "$commit" ] || return 0
  git rev-parse --verify --quiet "${commit}^{commit}" 2>/dev/null || true
}

# include_already_live: true when --include was given and every deployable side it touches
# already serves a commit >= $include.
include_already_live() {
  [ -n "$include_arg" ] || return 1
  touched_files=$(git show --first-parent -m --name-only --format= "$include")
  touched_any=false
  for side in api web admin; do
    case $side in
      api) kind=api; url=$api; pattern=$RELEASE_API_PATHS ;;
      web) kind=site; url=$web; pattern=$RELEASE_WEB_PATHS ;;
      admin) kind=site; url=$admin; pattern=$RELEASE_ADMIN_PATHS ;;
    esac
    if printf '%s\n' "$touched_files" | grep -Eq "$pattern|^pnpm-lock\.yaml$"; then
      touched_any=true
      live=$(served_commit "$kind" "$url")
      [ -n "$live" ] || return 1
      git merge-base --is-ancestor "$include" "$live" 2>/dev/null || return 1
    fi
  done
  [ "$touched_any" = true ]
}

# check_already_live: exits 0 if incremental deploy has nothing to ship.
check_already_live() {
  [ "$mode" = incremental ] || return 0
  if include_already_live; then
    short=$(git log -1 --format='%h' "$include")
    echo "outcome=already_live"
    echo "Commit $short is already live on all affected production sides; skipping deploy."
    exit 0
  fi
  plan=$(WEB_ORIGINS="$web" ADMIN_ORIGIN="$admin" GITHUB_OUTPUT= \
    "$here/ci-deploy-target.sh" "$target" incremental "$api")
  if printf '%s\n' "$plan" | grep -qx 'deploy=false'; then
    short=$(git log -1 --format='%h' "$target")
    echo "outcome=already_live"
    echo "Production already serves all deployable changes up to $short; nothing to ship."
    exit 0
  fi
}

# check_active_run: if an active (in_progress, queued, waiting, etc.) Deploy production run already
# covers $include, piggyback on it instead of dispatching a second deploy.
check_active_run() {
  [ "$mode" = incremental ] && [ "$pin_sha" = false ] || return 0
  runs=$(gh api "repos/$repo/actions/workflows/deploy.yml/runs?branch=main&per_page=20" \
    --jq '.workflow_runs[]? | select(.status != "completed") | "\(.id)\t\(.status)\t\(.head_sha)\t\(.html_url)"' \
    2>/dev/null) || return 0
  [ -n "$runs" ] || return 0

  matched_id=
  matched_status=
  matched_sha=
  matched_url=
  fetched_again=false
  # Read via line splitting so variables persist outside subshell.
  old_ifs=$IFS
  set -f
  IFS='
'
  for line in $runs; do
    IFS='	'
    # shellcheck disable=SC2086
    set -- $line
    run_id=$1
    run_status=$2
    run_sha=$3
    run_url=$4
    IFS='
'
    if ! git cat-file -e "${run_sha}^{commit}" 2>/dev/null &&
       [ "$fetched_again" = false ] && [ "${RELEASE_FETCH:-1}" != 0 ]; then
      git fetch -q origin main || true
      fetched_again=true
    fi
    if git cat-file -e "${run_sha}^{commit}" 2>/dev/null &&
       git merge-base --is-ancestor "$include" "$run_sha" 2>/dev/null; then
      matched_id=$run_id
      matched_status=$run_status
      matched_sha=$run_sha
      matched_url=$run_url
      break
    fi
  done
  set +f
  IFS=$old_ifs

  if [ -n "$matched_id" ]; then
    echo "outcome=piggybacked"
    echo "run_id=$matched_id"
    echo "run_url=$matched_url"
    echo "Reusing active Deploy production run #$matched_id (status=$matched_status, sha=$matched_sha)."
    if [ "$watch" = true ]; then
      gh run watch "$matched_id" --repo "$repo" --exit-status
    fi
    exit 0
  fi
}

web_check_state() {
  gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$1&event=push&branch=main&per_page=100" \
    --jq 'if any(.workflow_runs[]?; .status == "completed" and .conclusion == "success") then "success" elif any(.workflow_runs[]?; .status != "completed") then "running" elif (.workflow_runs | length) == 0 then "none" else "failure" end' \
    2>/dev/null || echo unavailable
}

refresh_target() {
  [ "${RELEASE_FETCH:-1}" != 0 ] || return 1
  git fetch -q origin main || return 1
  new_target=$(git rev-parse --verify "origin/main^{commit}")
  if [ "$new_target" != "$target" ]; then
    target=$new_target
    if [ -z "$include_arg" ]; then
      include=$target
    fi
    return 0
  fi
  return 1
}

wait_for_web_checks() {
  deadline=$(( $(date +%s) + wait_ci ))
  waited=false
  while :; do
    state=$(web_check_state "$target")
    case $state in
      success)
        # If we waited, refresh origin/main so we neither miss a concurrent deploy nor dispatch
        # against a newly merged commit whose Web checks are still running.
        if [ "$waited" = true ]; then
          if refresh_target; then
            echo "origin/main advanced to $(git log -1 --format='%h' "$target") while waiting; checking its Web checks…"
            continue
          fi
          echo "Web checks for $target on main passed."
        fi
        return 0
        ;;
      failure)
        echo "Web checks for $target on main failed; refusing to dispatch Deploy production." >&2
        exit 1
        ;;
      running | none | unavailable)
        now=$(date +%s)
        if [ "$now" -ge "$deadline" ]; then
          echo "Timed out waiting for Web checks on $target (last state: $state)." >&2
          exit 1
        fi
        waited=true
        echo "Waiting for main Web checks on $(git log -1 --format='%h' "$target") (state: $state)…"
        sleep "$poll_interval"
        refresh_target || true
        ;;
    esac
  done
}

check_already_live
check_active_run
wait_for_web_checks
# Re-check after waiting: another parallel Agent may have already shipped or started shipping.
check_already_live
check_active_run

before_ok=true
before_id=0
if before_id=$(gh api "repos/$repo/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=5" \
  --jq '[.workflow_runs[]?.id] | max // 0' 2>/dev/null); then
  case $before_id in
    '' | *[!0-9]*) before_ok=false ;;
  esac
else
  before_ok=false
fi

set -- workflow run deploy.yml --repo "$repo" --ref main -f "mode=$mode"
if [ -n "$reason" ]; then
  set -- "$@" -f "reason=$reason"
fi
if [ "$pin_sha" = true ]; then
  set -- "$@" -f "pin_sha=true"
fi
gh "$@"

# Wait briefly for GitHub to materialize the dispatched run so we watch the exact one we created.
new_id=
new_url=
if [ "$before_ok" = true ]; then
  dispatch_deadline=$(( $(date +%s) + dispatch_wait ))
  while :; do
    match=$(gh api "repos/$repo/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=10" \
      --jq "[.workflow_runs[]? | select(.id > $before_id)] | sort_by(.id) | last | if . then \"\(.id)\t\(.html_url)\" else \"\" end" \
      2>/dev/null) || match=
    if [ -n "$match" ]; then
      new_id=${match%%	*}
      new_url=${match#*	}
      break
    fi
    [ "$(date +%s)" -lt "$dispatch_deadline" ] || break
    sleep 2
  done
fi

echo "outcome=dispatched"
if [ -n "$new_id" ]; then
  echo "run_id=$new_id"
  echo "run_url=$new_url"
  echo "Dispatched Deploy production run #$new_id ($new_url)."
  if [ "$watch" = true ]; then
    gh run watch "$new_id" --repo "$repo" --exit-status
  fi
elif [ "$before_ok" = false ]; then
  echo "Dispatched Deploy production, but could not query baseline run ID before dispatch; check GitHub Actions manually." >&2
else
  echo "Dispatched Deploy production, but run ID did not appear within ${dispatch_wait}s; check GitHub Actions." >&2
fi
