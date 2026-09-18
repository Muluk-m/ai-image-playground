#!/bin/sh
set -eu
# Decides whether the deploy workflow ships <sha>. Run inside a checkout with origin/main fetched
# and enough history to compare commits.
#
#   scripts/ci-deploy-target.sh <sha> <workflow_run|workflow_dispatch> <api-base-url>...
#
# Writes deploy=true|false to $GITHUB_OUTPUT (stdout without it) and explains a skip as a notice.
# A skip is not a failure:
# - only the current tip of origin/main is deployed, so a queued older run never overtakes a newer;
# - an API already running a descendant of <sha> is never moved back;
# - an automatic run whose commit every API already serves has nothing to do. A manual run still
#   redeploys it, which is how a private overlay change goes out.
# An API that cannot be reached or reports no version does not block: the rollout decides.

target=${1:?target commit required}
event=${2:?event name required}
shift 2
output=${GITHUB_OUTPUT:-/dev/stdout}

decide() {
  printf 'deploy=%s\n' "$1" >>"$output"
  exit 0
}
skip() {
  echo "::notice::$1; nothing deployed."
  decide false
}

tip=$(git rev-parse origin/main)
[ "$target" = "$tip" ] || skip "$target is not the tip of origin/main ($tip)"

apis=0
serving=0
for api in "$@"; do
  api=${api%/}
  apis=$((apis + 1))
  if ! body=$(curl -fsS --max-time 10 "$api/health" 2>/dev/null); then
    echo "::warning::$api/health did not answer; deploying without its version."
    continue
  fi
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  deployed=${version%%+*}
  if ! printf '%s\n' "$deployed" | grep -Eqx '[0-9a-f]{40}'; then
    echo "::warning::$api reports no commit version; deploying."
    continue
  fi
  if [ "$deployed" = "$target" ]; then
    serving=$((serving + 1))
    continue
  fi
  if ! git cat-file -e "$deployed^{commit}" 2>/dev/null; then
    echo "::warning::$api runs $deployed, which is not in this history; deploying."
    continue
  fi
  if git merge-base --is-ancestor "$target" "$deployed"; then
    skip "$api already runs $deployed, a descendant of $target"
  fi
done
if [ "$apis" -gt 0 ] && [ "$serving" -eq "$apis" ] && [ "$event" != workflow_dispatch ]; then
  skip "every API already serves $target"
fi
decide true
