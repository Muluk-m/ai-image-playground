#!/bin/sh
set -eu

# One entry point for a Cloudflare Pages release (README option 4): build and upload one
# edition's frontend, then confirm the live version manifest matches the one just built.
# Runs on a workstation, not on the VPS.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"

pages_env=${PAGES_ENV_FILE:-$config_root/pages.env}
dist_manifest=$repo_root/apps/web/dist/version.json

usage() {
  cat >&2 <<'EOF'
Usage: scripts/pages-release.sh <internal|paid>

Reads $XDG_CONFIG_HOME/ai-image-playground/pages.env, whose keys are prefixed INTERNAL_ or
PAID_ (see deploy/pages.env.example).

The edition is asserted against the working copy: `paid` needs ./private, `internal` needs it
absent, because the overlay is compiled in by mere file presence.
EOF
  exit 2
}

edition=${1:-}
[ "$#" -le 1 ] || usage
case "$edition" in
  internal)
    prefix=INTERNAL
    bundle=public
    ;;
  paid)
    prefix=PAID
    bundle=private
    ;;
  *) usage ;;
esac

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

BFF_ENABLED=true
export BFF_ENABLED BFF_BASE_URL CLOUDFLARE_ACCOUNT_ID
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
    append_deploy_log "$edition-web" "pages:$pages_project" failed || true
  fi
}
trap on_exit EXIT

stage "Build and upload the $bundle bundle to Pages project $pages_project"
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
  "$repo_root/scripts/pages-deploy.sh" "$bundle" "$pages_project"
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

stage "Wait for $public_origin/version.json to report $built_version"
deadline=$(($(date +%s) + 60))
while :; do
  # The query string defeats any edge cache in front of the manifest.
  body=$(curl -fsS --max-time 10 "$public_origin/version.json?release-check=$(date +%s)" 2>/dev/null || printf '')
  if [ "$(printf '%s' "$body" | version_of)" = "$built_version" ]; then
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Timed out after 60s: $public_origin/version.json does not report $built_version." >&2
    exit 1
  fi
  sleep 3
done

released=true
append_deploy_log "$edition-web" "pages:$pages_project" ok
printf '\nReleased %s: version=%s\n' "$pages_project" "$built_version"
echo "recorded in $deployments_log"
