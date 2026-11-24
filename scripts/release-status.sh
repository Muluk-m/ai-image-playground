#!/bin/sh
set -eu
# Read-only: which commits each production side still lacks, compared with <target>.
#   scripts/release-status.sh [<target commit, default origin/main>]
# Endpoints come from pages.env (PAID_BFF_BASE_URL, PAID_PUBLIC_ORIGIN, ADMIN_PUBLIC_ORIGIN), the
# same file pages-release.sh reads; RELEASE_API / RELEASE_WEB / RELEASE_ADMIN override them.
# RELEASE_STATUS_FETCH=0 skips `git fetch` (CI already has the history).
# Release with: gh workflow run deploy.yml --ref main [-f mode=full] [-f reason=...]

env_file=${PAGES_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/pages.env}
if [ -f "$env_file" ]; then
  # shellcheck source=/dev/null
  . "$env_file"
fi
api=${RELEASE_API:-${PAID_BFF_BASE_URL:-https://api.muvloom.online}}
web=${RELEASE_WEB:-${PAID_PUBLIC_ORIGIN:-https://muvloom.online}}
admin=${RELEASE_ADMIN:-${ADMIN_PUBLIC_ORIGIN:-https://admin.muvloom.online}}

[ "${RELEASE_STATUS_FETCH:-1}" = 0 ] || git fetch -q origin main
target=$(git rev-parse --verify "${1:-origin/main}^{commit}")
echo "target: $(git log -1 --format='%h %s' "$target")"

# served <label> <url> <api|site>
served() {
  echo
  if [ "$3" = api ]; then endpoint=${2%/}/health; else endpoint=${2%/}/version.json; fi
  if ! body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null); then
    echo "$1: $endpoint did not answer"
    return 0
  fi
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  # Same parsing as ci-deploy-target.sh: the API reports <40-hex>[+<overlay>]; sites report
  # <short commit>[+<overlay>]-<build time>, and a build without git reports only the time.
  if [ "$3" = api ]; then
    commit=$(printf '%s\n' "${version%%+*}" | sed -n 's/^\([0-9a-f]\{40\}\)$/\1/p')
  else
    commit=$(printf '%s\n' "$version" | sed -n 's/^\([0-9a-f]\{7,40\}\)[+-].*/\1/p')
  fi
  if [ -z "$commit" ] || ! deployed=$(git rev-parse --verify --quiet "$commit^{commit}"); then
    echo "$1: serves '$version', not a commit in this history"
    return 0
  fi
  short=$(git log -1 --format=%h "$deployed")
  if [ "$deployed" = "$target" ]; then
    echo "$1: up to date ($short)"
  elif git merge-base --is-ancestor "$target" "$deployed"; then
    echo "$1: serves $short, already ahead of the target"
  elif ! git merge-base --is-ancestor "$deployed" "$target"; then
    echo "$1: serves $short, which is not an ancestor of the target"
  else
    echo "$1: serves $short; $(git rev-list --count "$deployed..$target") commit(s) to ship:"
    git log --no-merges --format='  - %h %s' "$deployed..$target"
  fi
}

served API "$api" api
served "muvloom 前端" "$web" site
served Admin "$admin" site
