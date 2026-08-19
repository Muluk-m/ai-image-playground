#!/bin/sh
set -eu

# Builds the standalone frontend bundle and uploads it to Cloudflare Pages (README option 3).
#
# Usage:
#   scripts/pages-deploy.sh free <branch>
#   scripts/pages-deploy.sh commercial <branch>
#
# The edition is asserted against the working copy instead of inferred: a public free bundle
# must not pick up the private overlay, and the overlay is included by mere file presence
# (apps/web/src/lib/privateOverlay.tsx globs ../../private/apps/web/index.tsx).
#
# commercial additionally requires BFF_ENABLED=true and BFF_BASE_URL=<api origin>; the build
# fails without them rather than publishing a site that cannot reach its backend.

usage() {
  echo "Usage: $0 <free|commercial> <branch>" >&2
  exit 1
}

edition=${1:-}
branch=${2:-}
[ -n "$edition" ] || usage
[ -n "$branch" ] || usage
[ "$#" -eq 2 ] || usage

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
overlay_entry="$repo_root/private/apps/web/index.tsx"

case "$edition" in
  free)
    if [ -f "$overlay_entry" ]; then
      echo "Refusing to build a free bundle: the private overlay is present at $overlay_entry." >&2
      echo "Build the free bundle from a checkout without ./private, or move that tree aside." >&2
      exit 1
    fi
    if [ "${BFF_ENABLED:-false}" != false ]; then
      echo "free builds are BYOK-only: unset BFF_ENABLED or set it to false." >&2
      exit 1
    fi
    ;;
  commercial)
    if [ ! -f "$overlay_entry" ]; then
      echo "Missing private overlay at $overlay_entry; a commercial bundle needs it." >&2
      exit 1
    fi
    if [ "${BFF_ENABLED:-}" != true ]; then
      echo "commercial builds require BFF_ENABLED=true." >&2
      exit 1
    fi
    if [ -z "${BFF_BASE_URL:-}" ]; then
      echo "commercial builds require BFF_BASE_URL=<api origin>." >&2
      exit 1
    fi
    PRIVATE_WEB_OVERLAY_ENTRY="$overlay_entry"
    export PRIVATE_WEB_OVERLAY_ENTRY
    ;;
  *)
    usage
    ;;
esac

cd "$repo_root"
pnpm --filter @image-playground/web build:static-host

cd "$repo_root/apps/web"
pnpm exec wrangler pages deploy --branch "$branch"
