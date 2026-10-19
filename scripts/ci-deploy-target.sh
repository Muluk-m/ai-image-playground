#!/bin/sh
set -eu
# Decides whether the deploy workflow ships <sha>. Run inside a checkout with origin/main fetched
# and enough history to compare commits.
#
#   WEB_ORIGINS="<internal origin> <paid origin>" ADMIN_ORIGIN=<admin origin> \
#     scripts/ci-deploy-target.sh <sha> <workflow_run|workflow_dispatch> <api-base-url>...
#
# Writes deploy_api, deploy_pages (either Pages side), deploy_web (internal and paid sites),
# deploy_admin (Admin site) and deploy (true when anything ships) to $GITHUB_OUTPUT (stdout without it).
# A skip is not a failure:
# - only the current tip of origin/main is deployed, so a queued older run never overtakes a newer;
# - nothing already running a descendant of <sha> is moved back, and the other sides stay put with it;
# - each side is compared with the commit it serves itself: the APIs from /health, the sites from
#   /version.json. A side skipped by an earlier run keeps its older commit, so a later run still sees
#   the changes it never shipped, and a side that already shipped them is not shipped again;
# - a side ships when its own paths changed since that commit, and nothing ships when every side
#   already serves <sha>. A manual run redeploys everything, which is how a private overlay change
#   goes out.
# A side whose version cannot be read, or whose copies disagree, ships.

target=${1:?target commit required}
event=${2:?event name required}
shift 2
output=${GITHUB_OUTPUT:-/dev/stdout}

skip() {
  echo "::notice::$1; nothing deployed."
  printf 'deploy_api=false\ndeploy_pages=false\ndeploy_web=false\ndeploy_admin=false\ndeploy=false\n' >>"$output"
  exit 0
}

# finish <api> <web> <admin>
finish() {
  pages=false
  if [ "$2" = true ] || [ "$3" = true ]; then
    pages=true
  fi
  deploy=$pages
  if [ "$1" = true ]; then
    deploy=true
  fi
  printf 'deploy_api=%s\ndeploy_pages=%s\ndeploy_web=%s\ndeploy_admin=%s\ndeploy=%s\n' \
    "$1" "$pages" "$2" "$3" "$deploy" >>"$output"
  exit 0
}

# lock_changed <changed paths> <importer>...: a lockfile edit ships a side only when the packages
# that side installs changed (scripts/lock-closure-changed.mjs). Uses the base commit decide picked.
# shellcheck disable=SC2329 # called through the *_changed functions
lock_changed() {
  changed_paths=$1
  shift
  printf '%s\n' "$changed_paths" | grep -qx 'pnpm-lock\.yaml' || return 1
  node scripts/lock-closure-changed.mjs "$scan_base" "$target" "$@"
}

# The internal and paid sites read these; the Admin site reads its own list; the API image reads
# the last. A path in several lists ships each of them.
# admin.muvloom.online is the Pages build of apps/admin; the API image only serves admin-api.
# shellcheck disable=SC2329 # called through decide
web_bundle_changed() {
  printf '%s\n' "$1" | grep -Eq '^(apps/web/|apps/website/|packages/shared/|pnpm-workspace\.yaml$)' ||
    lock_changed "$1" . apps/web apps/website packages/shared private/apps/web
}
# shellcheck disable=SC2329 # called through decide
admin_bundle_changed() {
  printf '%s\n' "$1" | grep -Eq '^(apps/admin/|packages/shared/|pnpm-workspace\.yaml$)' ||
    lock_changed "$1" . apps/admin packages/shared private/apps/admin
}
# shellcheck disable=SC2329 # called through decide
api_tree_changed() {
  # The VPS runs the copies of these scripts shipped inside the release tarball. A change that
  # does not roll out an API image never reaches the host.
  printf '%s\n' "$1" | grep -Eq '^(apps/bff/|apps/admin/|packages/|Dockerfile$|deploy/|pnpm-workspace\.yaml$|scripts/build-vps-release\.sh$|scripts/docker-entrypoint\.sh$|scripts/vps-deploy\.sh$|scripts/app-compose\.sh$|scripts/rollout-runtime\.sh$|scripts/check-test-isolation\.sh$|scripts/lib/deploy-common\.sh$)' ||
    lock_changed "$1" . apps/bff apps/admin packages/db packages/node-kit packages/shared \
      private/apps/bff private/apps/admin
}

tip=$(git rev-parse origin/main)
[ "$target" = "$tip" ] || skip "$target is not the tip of origin/main ($tip)"

# scan <api|site> <url>...: reads what each copy serves. Sets scan_base (the commit every copy
# serves when they agree), scan_unknown (some copy cannot be compared) and scan_current (every copy
# already serves the target). Skips the whole run when a copy is ahead of the target.
scan() {
  kind=$1
  shift
  scan_base=
  scan_unknown=false
  scan_current=true
  copies=0
  for url in "$@"; do
    url=${url%/}
    [ -n "$url" ] || continue
    copies=$((copies + 1))
    if [ "$kind" = api ]; then endpoint=$url/health; else endpoint=$url/version.json; fi
    if ! body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null); then
      echo "::warning::$endpoint did not answer; deploying without its version."
      scan_unknown=true
      scan_current=false
      continue
    fi
    version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    if [ "$kind" = api ]; then
      # The API reports the full public commit, then +<overlay>.
      commit=${version%%+*}
      printf '%s\n' "$commit" | grep -Eqx '[0-9a-f]{40}' || commit=
    else
      # Sites report <short commit>[+<overlay>]-<build time>.
      commit=$(printf '%s\n' "$version" | sed -n 's/^\([0-9a-f]\{7,40\}\)[+-].*/\1/p')
    fi
    deployed=
    [ -z "$commit" ] || deployed=$(git rev-parse --verify --quiet "$commit^{commit}" 2>/dev/null) || deployed=
    if [ -z "$commit" ]; then
      echo "::warning::$url reports no commit version; deploying."
      scan_unknown=true
      scan_current=false
      continue
    fi
    if [ -z "$deployed" ]; then
      echo "::warning::$url runs $commit, which is not in this history; deploying."
      scan_unknown=true
      scan_current=false
      continue
    fi
    [ "$deployed" = "$target" ] && continue
    scan_current=false
    if git merge-base --is-ancestor "$target" "$deployed"; then
      skip "$url already runs $deployed, a descendant of $target"
    fi
    if ! git merge-base --is-ancestor "$deployed" "$target"; then
      echo "::warning::$url runs $deployed, which is not an ancestor of $target; deploying."
      scan_unknown=true
      continue
    fi
    if [ -n "$scan_base" ] && [ "$scan_base" != "$deployed" ]; then
      echo "::warning::$url runs $deployed while another copy runs $scan_base; deploying."
      scan_unknown=true
    fi
    scan_base=$deployed
  done
  if [ "$copies" -eq 0 ]; then
    scan_unknown=true
    scan_current=false
  fi
}

# decide <label> <changed-function>: sets decision to true when the side scanned last has to ship.
decide() {
  decision=true
  [ "$scan_unknown" = false ] || return 0
  if [ "$scan_current" = true ]; then
    echo "::notice::$1 already serves $target; skipping it."
    decision=false
    return 0
  fi
  changed=$(git diff --name-only "$scan_base" "$target")
  # Empty commits still move the SHA; there is no path to prove the side is unchanged.
  if [ -z "$changed" ] || "$2" "$changed"; then
    return 0
  fi
  echo "::notice::$1 unchanged since $scan_base; skipping it."
  decision=false
}

scan api "$@"
api_current=$scan_current
decide "API tree" api_tree_changed
api=$decision
# shellcheck disable=SC2086 # WEB_ORIGINS is a space-separated list.
scan site ${WEB_ORIGINS:-}
web_current=$scan_current
decide "web bundle (internal and paid sites)" web_bundle_changed
web=$decision
scan site "${ADMIN_ORIGIN:-}"
admin_current=$scan_current
decide "admin bundle (Admin site)" admin_bundle_changed
admin=$decision

# A manual run republishes whatever is already current. Rollback was already refused above.
if [ "$event" = workflow_dispatch ]; then
  finish true true true
fi
if [ "$api_current" = true ] && [ "$web_current" = true ] && [ "$admin_current" = true ]; then
  skip "every API and site already serves $target"
fi
if [ "$api" = false ] && [ "$web" = false ] && [ "$admin" = false ]; then
  skip "no web bundle, admin bundle or API changes since what each side serves"
fi
finish "$api" "$web" "$admin"
