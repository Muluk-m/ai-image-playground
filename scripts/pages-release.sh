#!/bin/sh
set -eu

# One entry point for a Cloudflare Pages release (README option 4): build and upload one
# edition's frontend, then confirm the live version manifest carries this commit.
#
# Runs on a workstation, not on the VPS. scripts/pages-deploy.sh stays the building block for
# one-off uploads with hand-set environment variables.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_home=${XDG_CONFIG_HOME:-${HOME:?HOME must be set}/.config}
config_root=$config_home/ai-image-playground
pages_env=${PAGES_ENV_FILE:-$config_root/pages.env}
deployments_log=${DEPLOYMENTS_LOG:-$config_root/deployments.log}

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

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to verify the released version." >&2
  exit 1
}

if [ ! -f "$pages_env" ]; then
  echo "Pages environment file not found: $pages_env" >&2
  echo "Copy deploy/pages.env.example there and replace every placeholder." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$pages_env"

lookup() {
  eval "printf '%s' \"\${${prefix}_$1:-}\""
}

require() {
  if [ -z "$2" ]; then
    echo "${prefix}_$1 is required in $pages_env." >&2
    exit 1
  fi
}

pages_project=$(lookup PAGES_PROJECT)
bff_base_url=$(lookup BFF_BASE_URL)
public_origin=$(lookup PUBLIC_ORIGIN)
account_id=$(lookup CLOUDFLARE_ACCOUNT_ID)
token_file=$(lookup CLOUDFLARE_TOKEN_FILE)
extra_assets_dir=$(lookup EXTRA_ASSETS_DIR)
notify_update=$(lookup NOTIFY_UPDATE)

require PAGES_PROJECT "$pages_project"
require BFF_BASE_URL "$bff_base_url"
require PUBLIC_ORIGIN "$public_origin"
require CLOUDFLARE_ACCOUNT_ID "$account_id"
public_origin=${public_origin%/}

public_sha=$(git -C "$repo_root" rev-parse --short HEAD)
private_sha=-
if [ -d "$repo_root/private/.git" ]; then
  private_sha=$(git -C "$repo_root/private" rev-parse --short HEAD)
fi

append_log() {
  mkdir -p "$(dirname -- "$deployments_log")"
  printf '%s %s public=%s private=%s image=%s by=%s@%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$edition-web" "$public_sha" "$private_sha" \
    "pages:$pages_project" "$(whoami)" "$(hostname)" "$1" >>"$deployments_log"
}

released=false
on_exit() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ] && [ "$released" = false ]; then
    append_log failed || true
  fi
}
trap on_exit EXIT

BFF_ENABLED=true
BFF_BASE_URL=$bff_base_url
CLOUDFLARE_ACCOUNT_ID=$account_id
export BFF_ENABLED BFF_BASE_URL CLOUDFLARE_ACCOUNT_ID
if [ -n "$extra_assets_dir" ]; then
  EXTRA_ASSETS_DIR=$extra_assets_dir
  export EXTRA_ASSETS_DIR
fi
if [ -n "$notify_update" ]; then
  NOTIFY_UPDATE=$notify_update
  export NOTIFY_UPDATE
fi

printf '\n==> [1/2] Build and upload the %s bundle to Pages project %s\n' "$bundle" "$pages_project"
# The branch argument is always `main`: from a detached HEAD wrangler otherwise infers the branch
# name `head` and publishes a preview alias instead of production.
if [ -n "$token_file" ]; then
  if [ ! -f "$token_file" ]; then
    echo "${prefix}_CLOUDFLARE_TOKEN_FILE points at a missing file: $token_file" >&2
    exit 1
  fi
  (
    # shellcheck source=/dev/null
    . "$token_file"
    if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
      echo "$token_file sets no CLOUDFLARE_API_TOKEN." >&2
      exit 1
    fi
    export CLOUDFLARE_API_TOKEN
    "$repo_root/scripts/pages-deploy.sh" "$bundle" "$pages_project" main
  )
else
  echo "No ${prefix}_CLOUDFLARE_TOKEN_FILE set; wrangler will use its own OAuth login."
  env -u CLOUDFLARE_API_TOKEN "$repo_root/scripts/pages-deploy.sh" "$bundle" "$pages_project" main
fi

printf '\n==> [2/2] Wait for %s/version.json to report %s\n' "$public_origin" "$public_sha"
live_version=
deadline=$(($(date +%s) + 60))
while :; do
  # The query string defeats any edge cache in front of the manifest.
  body=$(curl -fsS --max-time 10 "$public_origin/version.json?release-check=$(date +%s)" 2>/dev/null || printf '')
  live_version=$(
    printf '%s' "$body" |
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n 1
  )
  case "$live_version" in
    "$public_sha"*) break ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Timed out after 60s: $public_origin/version.json still reports ${live_version:-nothing}." >&2
    exit 1
  fi
  sleep 3
done

released=true
append_log ok
printf '\nReleased %s: version=%s public=%s private=%s\n' \
  "$pages_project" "$live_version" "$public_sha" "$private_sha"
echo "appended to $deployments_log"
