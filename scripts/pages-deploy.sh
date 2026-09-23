#!/bin/sh
set -eu

# Builds the standalone frontend bundle and uploads it to one Cloudflare Pages project
# (README options 3 and 4).
#
# Usage:
#   scripts/pages-deploy.sh web public <pages-project> [branch]
#   scripts/pages-deploy.sh web private <pages-project> [branch]
#   scripts/pages-deploy.sh admin private <pages-project> [branch]
#
# The branch selects the Pages alias. Production is `main`, and it has to be passed explicitly:
# an omitted branch always resolves to a preview alias, never to production.
#
# PAGES_DEPLOY_DRY_RUN=1 prints the resolved target and exits before the build.
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
  echo "Usage: $0 <web|admin> <public|private> <pages-project> [branch]" >&2
  exit 1
}

app=${1:-}
edition=${2:-}
project=${3:-}
case "$app" in web|admin) ;; *) usage ;; esac
[ -n "$edition" ] || usage
[ -n "$project" ] || usage
[ "$#" -le 4 ] || usage

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$app" in
  web) overlay_entry="$repo_root/private/apps/web/index.tsx" ;;
  admin) overlay_entry="$repo_root/private/apps/admin/index.tsx" ;;
esac

# A forgotten third argument used to default to `main`, which published an unmerged branch to
# production. The default now names a preview alias even when the checkout sits on main.
default_branch() {
  head_name=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'HEAD')
  case "$head_name" in
    main | HEAD | '')
      printf 'preview-%s' "$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || printf 'local')"
      ;;
    *) printf '%s' "$head_name" ;;
  esac
}

branch=${4:-$(default_branch)}
if [ "$branch" = main ]; then
  echo "target: production (main)"
else
  echo "target: preview ($branch)"
fi
[ "${PAGES_DEPLOY_DRY_RUN:-}" != 1 ] || exit 0

case "$edition" in
  public)
    if [ -f "$overlay_entry" ]; then
      echo "Refusing to build a public $app bundle: the private overlay is present at $overlay_entry." >&2
      echo "Build the public bundle from a checkout without ./private, or move that tree aside." >&2
      exit 1
    fi
    [ "$app" = web ] || { echo "Admin has no public edition." >&2; exit 1; }
    ;;
  private)
    if [ ! -f "$overlay_entry" ]; then
      echo "Missing private overlay at $overlay_entry; a private $app bundle needs it." >&2
      exit 1
    fi
    case "$app" in
      web) PRIVATE_WEB_OVERLAY_ENTRY="$overlay_entry"; export PRIVATE_WEB_OVERLAY_ENTRY ;;
      admin) PRIVATE_ADMIN_OVERLAY_ENTRY="$overlay_entry"; export PRIVATE_ADMIN_OVERLAY_ENTRY ;;
    esac
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
if [ -n "${EXTRA_ASSETS_DIR:-}" ] && [ "$app" != web ]; then
  echo "EXTRA_ASSETS_DIR is only supported by the web bundle." >&2
  exit 1
fi
if [ -n "${EXTRA_ASSETS_DIR:-}" ] && [ ! -d "$EXTRA_ASSETS_DIR" ]; then
  echo "EXTRA_ASSETS_DIR=$EXTRA_ASSETS_DIR is not a directory." >&2
  exit 1
fi

cd "$repo_root"
pnpm --filter "@image-playground/$app" build:static-host

dist_dir="$repo_root/apps/$app/dist"
if [ -n "${EXTRA_ASSETS_DIR:-}" ]; then
  mkdir -p "$dist_dir/op"
  cp -R "$EXTRA_ASSETS_DIR"/. "$dist_dir/op/"
  echo "Copied $EXTRA_ASSETS_DIR into $app dist/op/ (published at /op/<file>)."
fi

cd "$repo_root/apps/$app"
pnpm exec wrangler pages deploy "$dist_dir" --project-name "$project" --branch "$branch"
