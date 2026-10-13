#!/bin/sh
set -eu
# Print the next production release (MAJOR.MINOR.PATCH) on stdout.
#
# MAJOR and MINOR are the first two numbers of the root package.json "version".
# The owner changes those by editing that field (and sets its patch back to 0).
# PATCH is not taken from the file: it is one higher than the highest git tag
# vMAJOR.MINOR.N on this line, or 0 when no such tag exists. A new MAJOR or MINOR
# therefore starts again at .0. This script does not create the tag.
repo=${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$repo/package.json" | head -n 1)
if [ -z "$version" ]; then
  echo "root package.json version must be MAJOR.MINOR.PATCH" >&2
  exit 1
fi
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
tags=$(git -C "$repo" tag -l "v${major}.${minor}.*" | grep -E "^v${major}\\.${minor}\\.[0-9]+$" || true)
if [ -z "$tags" ]; then
  printf '%s.%s.0\n' "$major" "$minor"
  exit 0
fi
patch=$(printf '%s\n' "$tags" | sed -n "s/^v${major}\\.${minor}\\.//p" | sort -n | tail -n 1)
printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))"
