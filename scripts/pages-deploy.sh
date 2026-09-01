#!/bin/sh
set -eu

# Builds the standalone frontend bundle and uploads it to one Cloudflare Pages project
# (README options 3 and 4).
#
# Usage:
#   scripts/pages-deploy.sh public <pages-project> [branch]
#   scripts/pages-deploy.sh private <pages-project> [branch]
#
# EXTRA_ASSETS_DIR=<dir> copies untracked deployment files into dist/op/ before the upload.
#
# NOTIFY_UPDATE=true makes open tabs show the update banner for this release. The default is a
# silent release: the manifest still ships, but running tabs migrate on their next natural reload.
# The manifest itself is written by build:static-host, not here.
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

# Checked before the build so a typo does not cost a full build first.
if [ -n "${EXTRA_ASSETS_DIR:-}" ] && [ ! -d "$EXTRA_ASSETS_DIR" ]; then
  echo "EXTRA_ASSETS_DIR=$EXTRA_ASSETS_DIR is not a directory." >&2
  exit 1
fi

cd "$repo_root"
pnpm --filter @image-playground/web build:static-host

if [ -n "${EXTRA_ASSETS_DIR:-}" ]; then
  mkdir -p "$repo_root/apps/web/dist/op"
  cp -R "$EXTRA_ASSETS_DIR"/. "$repo_root/apps/web/dist/op/"
  echo "Copied $EXTRA_ASSETS_DIR into dist/op/ (published at /op/<file>)."
fi

cd "$repo_root/apps/web"
set -- --project-name "$project"
[ -z "$branch" ] || set -- "$@" --branch "$branch"
pnpm exec wrangler pages deploy "$@"
