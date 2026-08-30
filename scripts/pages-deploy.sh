#!/bin/sh
set -eu

# Builds the standalone frontend bundle and uploads it to one Cloudflare Pages project
# (README options 3 and 4).
#
# Usage:
#   scripts/pages-deploy.sh public <pages-project> [branch]
#   scripts/pages-deploy.sh private <pages-project> [branch]
#
# The edition is asserted against the working copy instead of inferred, because the overlay is
# included by mere file presence (apps/web/src/lib/privateOverlay.tsx globs
# ../../private/apps/web/index.tsx).

usage() {
  echo "Usage: $0 <public|private> <pages-project> [branch]" >&2
  exit 1
}

edition=${1:-}
project=${2:-}
branch=${3:-}
[ -n "$edition" ] || usage
[ -n "$project" ] || usage
[ "$#" -le 3 ] || usage

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
overlay_entry="$repo_root/private/apps/web/index.tsx"

case "$edition" in
  public)
    if [ -f "$overlay_entry" ]; then
      echo "Refusing to build a public bundle: the private overlay is present at $overlay_entry." >&2
      echo "Build the public bundle from a checkout without ./private, or move that tree aside." >&2
      exit 1
    fi
    ;;
  private)
    if [ ! -f "$overlay_entry" ]; then
      echo "Missing private overlay at $overlay_entry; a private bundle needs it." >&2
      exit 1
    fi
    PRIVATE_WEB_OVERLAY_ENTRY="$overlay_entry"
    export PRIVATE_WEB_OVERLAY_ENTRY
    ;;
  *)
    usage
    ;;
esac

if [ "${BFF_ENABLED:-false}" = true ] && [ -z "${BFF_BASE_URL:-}" ]; then
  echo "BFF_ENABLED=true requires BFF_BASE_URL=<api origin>." >&2
  exit 1
fi

cd "$repo_root"
pnpm --filter @image-playground/web build:static-host

cd "$repo_root/apps/web"
set -- --project-name "$project"
[ -z "$branch" ] || set -- "$@" --branch "$branch"
pnpm exec wrangler pages deploy "$@"
