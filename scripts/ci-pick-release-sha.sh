#!/bin/sh
set -eu
# Picks the production release commit on main after acquiring the production-deploy lock.
#   scripts/ci-pick-release-sha.sh <event_sha> <pin_sha: true|false> <repo>
#
# When pin_sha=false (default), if origin/main advanced while this run was queued, it picks the
# newest commit in [event_sha, HEAD] whose main `Web checks` run succeeded, bundling commits merged
# during the queue into a single rollout. It never moves backwards past event_sha and never picks an
# unverified or failed commit.
#
# Writes `sha=<commit>` and `advanced=<true|false>` to $GITHUB_OUTPUT (stdout when unset).

event_arg=${1:?event sha required}
pin_sha=${2:-false}
repo=${3:?repository required}
output=${GITHUB_OUTPUT:-/dev/stdout}
head_ref=${PICK_HEAD_REF:-HEAD}
green_page_size=${PICK_GREEN_PAGE_SIZE:-100}

case $pin_sha in
  true | false) ;;
  *)
    echo "::error::Invalid pin_sha '$pin_sha'; expected true or false." >&2
    exit 2
    ;;
esac

event_sha=$(git rev-parse --verify "${event_arg}^{commit}" 2>/dev/null) || {
  echo "::error::Event commit '$event_arg' is not in this checkout." >&2
  exit 1
}
head_sha=$(git rev-parse --verify "${head_ref}^{commit}" 2>/dev/null) || {
  echo "::error::Head ref '$head_ref' is not a valid commit." >&2
  exit 1
}

if ! git merge-base --is-ancestor "$event_sha" "$head_sha" 2>/dev/null; then
  echo "::error::Event commit $event_sha is not an ancestor of $head_ref ($head_sha)." >&2
  exit 1
fi

web_check_state() {
  gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$1&event=push&branch=main&per_page=100" \
    --jq 'if any(.workflow_runs[]?; .status == "completed" and .conclusion == "success") then "success" elif any(.workflow_runs[]?; .status != "completed") then "running" elif (.workflow_runs | length) == 0 then "none" else "failure" end' \
    2>/dev/null || echo unavailable
}

emit() {
  printf 'sha=%s\nadvanced=%s\n' "$1" "$2" >>"$output"
  exit 0
}

if [ "$pin_sha" = true ] || [ "$event_sha" = "$head_sha" ]; then
  state=$(web_check_state "$event_sha")
  if [ "$state" != success ]; then
    echo "::error::Web checks for $event_sha on main is '$state'; release it after the checks pass." >&2
    exit 1
  fi
  emit "$event_sha" false
fi

# Fetch one page of recent green main runs as a fast cache. If the page is full (truncated), fall
# back to exact per-commit checks for misses so no commit in the full event_sha..head_sha range is
# ever silently skipped.
green_meta=$(
  gh api "repos/$repo/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=$green_page_size" \
    --jq '([.workflow_runs[]?] | length | tostring), ([.workflow_runs[]? | select(.conclusion == "success") | .head_sha] | unique | .[])' \
    2>/dev/null
) || {
  echo "::error::Could not query Web checks on main for $repo." >&2
  exit 1
}
green_count=$(printf '%s\n' "$green_meta" | head -n 1)
green_shas=$(printf '%s\n' "$green_meta" | tail -n +2)
case $green_count in
  '' | *[!0-9]*) green_count=$green_page_size ;;
esac
page_truncated=false
if [ "$green_count" -ge "$green_page_size" ]; then
  page_truncated=true
fi

candidates=$(git rev-list --first-parent "${event_sha}..${head_sha}")
for candidate in $candidates; do
  if [ -n "$green_shas" ] && printf '%s\n' "$green_shas" | grep -Fqx "$candidate"; then
    echo "::notice::Advanced release target from $event_sha to latest green main commit $candidate."
    emit "$candidate" true
  fi
  if [ "$page_truncated" = true ]; then
    cand_state=$(web_check_state "$candidate")
    if [ "$cand_state" = success ]; then
      echo "::notice::Advanced release target from $event_sha to latest green main commit $candidate."
      emit "$candidate" true
    fi
  fi
done

# Newer commits have not passed Web checks yet; fall back to event_sha itself if it is green.
if [ -n "$green_shas" ] && printf '%s\n' "$green_shas" | grep -Fqx "$event_sha"; then
  emit "$event_sha" false
fi

state=$(web_check_state "$event_sha")
if [ "$state" = success ]; then
  emit "$event_sha" false
fi

echo "::error::Web checks for $event_sha on main is '$state' (and no newer commit up to $head_sha passed); release it after the checks pass." >&2
exit 1
