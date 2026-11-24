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

# Collect recent green main commits in one API call, then walk newest -> oldest down to event_sha.
green_shas=$(
  gh api "repos/$repo/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=50" \
    --jq '[.workflow_runs[]? | select(.conclusion == "success") | .head_sha] | unique | .[]' \
    2>/dev/null
) || {
  echo "::error::Could not query Web checks on main for $repo." >&2
  exit 1
}

candidates=$(git rev-list --first-parent --max-count=50 "${event_sha}..${head_sha}")
for candidate in $candidates; do
  if printf '%s\n' "$green_shas" | grep -Fqx "$candidate"; then
    echo "::notice::Advanced release target from $event_sha to latest green main commit $candidate."
    emit "$candidate" true
  fi
done

# Newer commits have not passed Web checks yet; fall back to event_sha itself if it is green.
if printf '%s\n' "$green_shas" | grep -Fqx "$event_sha"; then
  emit "$event_sha" false
fi

state=$(web_check_state "$event_sha")
if [ "$state" = success ]; then
  emit "$event_sha" false
fi

echo "::error::Web checks for $event_sha on main is '$state' (and no newer commit up to $head_sha passed); release it after the checks pass." >&2
exit 1
