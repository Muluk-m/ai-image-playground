#!/bin/sh
set -eu

# One entry point for a Cloudflare Pages release (README option 4): build and upload one
# edition's frontend, then confirm the live version manifest matches the one just built.
# Runs on a workstation or in CI, not on the VPS.
#
# `test` is the test environment (test.muvloom.online, its own Pages project). It is a release
# like the others — same build, same production branch, same version check — because a preview
# alias cannot carry a custom domain. What keeps it from touching production is that every
# edition names its own project and origin in pages.env.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"

pages_env=${PAGES_ENV_FILE:-$config_root/pages.env}
dist_manifest=

usage() {
  cat >&2 <<'EOF'
Usage: scripts/pages-release.sh <internal|paid|test|admin>

Reads $XDG_CONFIG_HOME/ai-image-playground/pages.env, whose keys are prefixed INTERNAL_, PAID_,
TEST_, or ADMIN_ (see deploy/pages.env.example).

Paid, test, and admin need ./private; internal needs it absent. The overlay is compiled in by
mere file presence.
EOF
  exit 2
}

edition=${1:-}
[ "$#" -le 1 ] || usage
case "$edition" in
  internal)
    prefix=INTERNAL
    bundle=public
    app=web
    deployment_name=internal-web
    search_indexing=false
    ;;
  # Only the public product site is meant to show up in search results.
  paid)
    prefix=PAID
    bundle=private
    app=web
    deployment_name=paid-web
    search_indexing=true
    ;;
  # The test site mirrors what ships to muvloom.online, so it is the paid shape.
  test)
    prefix=TEST
    bundle=private
    app=web
    deployment_name=test-web
    search_indexing=false
    ;;
  admin)
    prefix=ADMIN
    bundle=private
    app=admin
    deployment_name=paid-admin
    search_indexing=false
    ;;
  *) usage ;;
esac
dist_manifest=$repo_root/apps/$app/dist/version.json

if [ ! -f "$pages_env" ]; then
  echo "Pages environment file not found: $pages_env" >&2
  echo "Copy deploy/pages.env.example there and replace every placeholder." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$pages_env"

need() {
  value=$(edition_var "$prefix" "$1")
  if [ -z "$value" ]; then
    echo "${prefix}_$1 is required in $pages_env." >&2
    exit 1
  fi
  printf '%s' "$value"
}

version_of() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

pages_project=$(need PAGES_PROJECT)
BFF_BASE_URL=$(need BFF_BASE_URL)
public_origin=$(need PUBLIC_ORIGIN)
CLOUDFLARE_ACCOUNT_ID=$(need CLOUDFLARE_ACCOUNT_ID)
token_file=$(edition_var "$prefix" CLOUDFLARE_TOKEN_FILE)
public_origin=${public_origin%/}
case "$public_origin" in
  https://*) ;;
  *)
    echo "${prefix}_PUBLIC_ORIGIN must be an https:// origin, got $public_origin." >&2
    exit 1
    ;;
esac

BFF_ENABLED=true
BFF_BASE_URLS_BY_ORIGIN=$(edition_var "$prefix" BFF_BASE_URLS_BY_ORIGIN)
LOCAL_COMPATIBILITY=$(edition_var "$prefix" LOCAL_COMPATIBILITY)
# The web build writes canonical URLs, hreflang, sitemap.xml and robots.txt from these two.
PUBLIC_ORIGIN=$public_origin
SEARCH_INDEXING=$search_indexing
export BFF_ENABLED BFF_BASE_URL BFF_BASE_URLS_BY_ORIGIN CLOUDFLARE_ACCOUNT_ID LOCAL_COMPATIBILITY \
  PUBLIC_ORIGIN SEARCH_INDEXING
unset EXTRA_ASSETS_DIR NOTIFY_UPDATE
extra_assets_dir=$(edition_var "$prefix" EXTRA_ASSETS_DIR)
if [ -n "$extra_assets_dir" ]; then
  EXTRA_ASSETS_DIR=$extra_assets_dir
  export EXTRA_ASSETS_DIR
fi
notify_update=$(edition_var "$prefix" NOTIFY_UPDATE)
if [ -n "$notify_update" ]; then
  NOTIFY_UPDATE=$notify_update
  export NOTIFY_UPDATE
fi

public_sha=-
private_sha=-
released=false
on_exit() {
  if [ "$?" -ne 0 ] && [ "$released" = false ]; then
    append_deploy_log "$deployment_name" "pages:$pages_project" failed || true
  fi
}
trap on_exit EXIT

stage "Build and upload the $bundle $app bundle to Pages project $pages_project"
if [ -n "$token_file" ] && [ ! -f "$token_file" ]; then
  echo "${prefix}_CLOUDFLARE_TOKEN_FILE points at a missing file: $token_file" >&2
  exit 1
fi
(
  if [ -n "$token_file" ]; then
    # shellcheck source=/dev/null
    . "$token_file"
    export CLOUDFLARE_API_TOKEN
  else
    unset CLOUDFLARE_API_TOKEN
  fi
  # `main` is passed explicitly: this is the production entry point, and an omitted branch
  # resolves to a preview alias.
  "$repo_root/scripts/pages-deploy.sh" "$app" "$bundle" "$pages_project" main
)

built_version=$(version_of <"$dist_manifest")
if [ -z "$built_version" ]; then
  echo "No version field in $dist_manifest; the build wrote no manifest to compare against." >&2
  exit 1
fi
# The shas the log records are the ones that manifest was built from.
shas=${built_version%-*}
public_sha=${shas%%+*}
case "$shas" in
  *+*) private_sha=${shas##*+} ;;
esac

# A custom domain has taken 2-3 minutes to serve a new manifest, so a short window reports a
# successful release as failed.
poll_timeout=300
stage "Wait up to ${poll_timeout}s for $public_origin/version.json to report $built_version"
started=$(date +%s)
deadline=$((started + poll_timeout))
next_report=$((started + 30))
while :; do
  # The query string defeats any edge cache in front of the manifest.
  body=$(curl -fsS --max-time 10 "$public_origin/version.json?release-check=$(date +%s)" 2>/dev/null || printf '')
  if [ "$(printf '%s' "$body" | version_of)" = "$built_version" ]; then
    break
  fi
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "Timed out after ${poll_timeout}s: $public_origin/version.json does not report $built_version." >&2
    echo "The upload succeeded; only propagation to the custom domain is unconfirmed. Check the origin before releasing again." >&2
    exit 1
  fi
  if [ "$now" -ge "$next_report" ]; then
    echo "still waiting, $((now - started))s elapsed"
    next_report=$((now + 30))
  fi
  sleep 5
done

released=true
append_deploy_log "$deployment_name" "pages:$pages_project" ok
printf '\nReleased %s: version=%s\n' "$pages_project" "$built_version"
echo "recorded in $deployments_log"
