#!/bin/sh
set -eu
# Read-only: which commits on origin/main are not in production yet, per side.
#   scripts/release-status.sh
# Origins default to the public muvloom endpoints; override with RELEASE_API, RELEASE_WEB, RELEASE_ADMIN.
# Release with: gh workflow run deploy.yml --ref main [-f mode=full] [-f reason=...]

api=${RELEASE_API:-https://api.muvloom.online}
web=${RELEASE_WEB:-https://muvloom.online}
admin=${RELEASE_ADMIN:-https://admin.muvloom.online}

git fetch -q origin main
tip=$(git rev-parse origin/main)
echo "origin/main: $(git log -1 --format='%h %s' "$tip")"

# served <label> <url> <api|site>
served() {
  if [ "$3" = api ]; then endpoint=${2%/}/health; else endpoint=${2%/}/version.json; fi
  body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null) || {
    echo
    echo "$1: $endpoint did not answer"
    return 0
  }
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  # The API reports <commit>+<commit>; sites report <short commit>-<build time>.
  commit=$(printf '%s\n' "${version%%+*}" | sed -n 's/^\([0-9a-f]\{7,40\}\).*/\1/p')
  echo
  if [ -z "$commit" ] || ! deployed=$(git rev-parse --verify --quiet "$commit^{commit}"); then
    echo "$1: serves '$version', not a commit in this history"
    return 0
  fi
  if [ "$deployed" = "$tip" ]; then
    echo "$1: up to date ($(git log -1 --format=%h "$deployed"))"
    return 0
  fi
  if ! git merge-base --is-ancestor "$deployed" "$tip"; then
    echo "$1: serves $(git log -1 --format=%h "$deployed"), which is not an ancestor of origin/main"
    return 0
  fi
  echo "$1: serves $(git log -1 --format=%h "$deployed"); $(git rev-list --count "$deployed..$tip") commit(s) behind:"
  git log --no-merges --format='  - %h %s' "$deployed..$tip"
}

served API "$api" api
served "muvloom 前端" "$web" site
served Admin "$admin" site
