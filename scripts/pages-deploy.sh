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
# NOINDEX_ORIGINS="<https origin> ..." appends a host-scoped `X-Robots-Tag: noindex` rule per
# origin to dist/_headers, for extra custom domains of the same project that must not be indexed.
#
# PAGES_ASSET_ORIGIN=<https origin> copies the hashed files of recent releases from that live site
# into dist before upload (scripts/retain-pages-assets.mjs). pages-release.sh sets it.
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

if [ -n "${NOINDEX_ORIGINS:-}" ]; then
  [ "$app" = web ] || { echo "NOINDEX_ORIGINS is only supported by the web bundle." >&2; exit 1; }
  # One project can serve several custom domains; robots.txt is one static file for all of them,
  # so a domain that must stay out of search results gets a host-scoped X-Robots-Tag instead.
  # Crawlers still fetch its pages (robots.txt allows them) and therefore see the noindex.
  for origin in $NOINDEX_ORIGINS; do
    case "$origin" in
      https://*) ;;
      *) echo "NOINDEX_ORIGINS entries must be https:// origins, got $origin." >&2; exit 1 ;;
    esac
    printf '\n%s/*\n  X-Robots-Tag: noindex, nofollow\n' "${origin%/}" >> "$dist_dir/_headers"
  done
  echo "Added host-scoped noindex headers for: $NOINDEX_ORIGINS"
fi

# Open tabs keep importing the previous releases' hashed chunks, which a new Pages deployment no
# longer serves. pages-release.sh sets PAGES_ASSET_ORIGIN; preview deploys publish this build only.
# PAGES_RETAIN_ASSETS=0 publishes this build only, so old hashed URLs 404 at once.
if [ "${PAGES_RETAIN_ASSETS:-1}" = 0 ]; then
  echo "PAGES_RETAIN_ASSETS=0: not retaining previous hashed assets; open tabs on older releases reload once."
elif [ -n "${PAGES_ASSET_ORIGIN:-}" ]; then
  node "$repo_root/scripts/retain-pages-assets.mjs" "$dist_dir" "$PAGES_ASSET_ORIGIN"
fi

if [ "$app" = web ]; then
  # Run the exact final dist before any upload; a failed smoke leaves the current site intact.
  sh "$repo_root/scripts/pages-browser-smoke.sh" --dist "$dist_dir"
fi

cd "$repo_root/apps/$app"
pnpm exec wrangler pages deploy "$dist_dir" --project-name "$project" --branch "$branch"
