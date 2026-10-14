#!/bin/sh
set -eu
# Decides whether the deploy workflow ships <sha>. Run inside a checkout with origin/main fetched
# and enough history to compare commits.
#
#   scripts/ci-deploy-target.sh <sha> <workflow_run|workflow_dispatch> <api-base-url>...
#
# Writes deploy_api, deploy_pages, and deploy (true when either side ships) to $GITHUB_OUTPUT
# (stdout without it). A skip is not a failure:
# - only the current tip of origin/main is deployed, so a queued older run never overtakes a newer;
# - an API already running a descendant of <sha> is never moved back, and Pages stay put with it;
# - when the APIs already serve <sha>, an automatic run has nothing to do. A manual run still
#   redeploys both, which is how a private overlay change goes out;
# - otherwise the diff since the deployed commit is split: Pages ship when the web bundle changed,
#   and the API rollout is skipped when the API tree did not.
# An API that cannot be reached or reports no version does not block: both sides deploy.

target=${1:?target commit required}
event=${2:?event name required}
shift 2
output=${GITHUB_OUTPUT:-/dev/stdout}

skip() {
  echo "::notice::$1; nothing deployed."
  printf 'deploy_api=false\ndeploy_pages=false\ndeploy=false\n' >>"$output"
  exit 0
}

finish() {
  deploy=false
  if [ "$1" = true ] || [ "$2" = true ]; then
    deploy=true
  fi
  printf 'deploy_api=%s\ndeploy_pages=%s\ndeploy=%s\n' "$1" "$2" "$deploy" >>"$output"
  exit 0
}

# Pages reads these. The API image reads these. A path in both lists ships both.
web_bundle_changed() {
  printf '%s\n' "$1" | grep -Eq '^(apps/web/|packages/shared/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)'
}
api_tree_changed() {
  # The VPS runs the copies of these scripts shipped inside the release tarball. A change that
  # does not roll out an API image never reaches the host.
  printf '%s\n' "$1" | grep -Eq '^(apps/bff/|apps/admin/|packages/|Dockerfile$|deploy/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|scripts/build-vps-release\.sh$|scripts/docker-entrypoint\.sh$|scripts/vps-deploy\.sh$|scripts/app-compose\.sh$|scripts/rollout-runtime\.sh$|scripts/check-test-isolation\.sh$|scripts/lib/deploy-common\.sh$)'
}

tip=$(git rev-parse origin/main)
[ "$target" = "$tip" ] || skip "$target is not the tip of origin/main ($tip)"

apis=0
serving=0
base=
base_mixed=false
base_unknown=false
for api in "$@"; do
  api=${api%/}
  apis=$((apis + 1))
  if ! body=$(curl -fsS --max-time 10 "$api/health" 2>/dev/null); then
    echo "::warning::$api/health did not answer; deploying without its version."
    base_unknown=true
    continue
  fi
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  deployed=${version%%+*}
  if ! printf '%s\n' "$deployed" | grep -Eqx '[0-9a-f]{40}'; then
    echo "::warning::$api reports no commit version; deploying."
    base_unknown=true
    continue
  fi
  if [ "$deployed" = "$target" ]; then
    serving=$((serving + 1))
    continue
  fi
  if ! git cat-file -e "$deployed^{commit}" 2>/dev/null; then
    echo "::warning::$api runs $deployed, which is not in this history; deploying."
    base_unknown=true
    continue
  fi
  if git merge-base --is-ancestor "$target" "$deployed"; then
    skip "$api already runs $deployed, a descendant of $target"
  fi
  if ! git merge-base --is-ancestor "$deployed" "$target"; then
    echo "::warning::$api runs $deployed, which is not an ancestor of $target; deploying."
    base_unknown=true
    continue
  fi
  if [ -n "$base" ] && [ "$base" != "$deployed" ]; then
    base_mixed=true
  fi
  base=$deployed
done

# A manual run republishes whatever is already current. Rollback was already refused above.
if [ "$event" = workflow_dispatch ]; then
  finish true true
fi
if [ "$apis" -gt 0 ] && [ "$serving" -eq "$apis" ]; then
  skip "every API already serves $target"
fi
if [ "$base_unknown" = true ] || [ "$base_mixed" = true ] || [ -z "$base" ]; then
  finish true true
fi

diff=$(git diff --name-only "$base" "$target")
if [ -z "$diff" ]; then
  # Empty commits still move the SHA. Ship both; there is no path to prove a side is unchanged.
  finish true true
fi

pages=false
api_side=false
web_bundle_changed "$diff" && pages=true
api_tree_changed "$diff" && api_side=true
if [ "$pages" = false ]; then
  echo "::notice::web bundle unchanged since $base; skipping Pages."
fi
if [ "$api_side" = false ]; then
  echo "::notice::API tree unchanged since $base; skipping the API rollout."
fi
if [ "$pages" = false ] && [ "$api_side" = false ]; then
  skip "no web bundle or API changes since $base"
fi
finish "$api_side" "$pages"
