#!/bin/sh
set -eu
# Brings the shared test branch up to date and pushes it, in one step and without touching any
# working tree: fetches, merges origin/main and the given branches into origin/test in a throwaway
# worktree, pushes the result to test (which starts Deploy test), and removes the worktree.
#
#   scripts/test-sync.sh [branch ...]
#
# Other sessions' commits already on test are kept; nothing is force-pushed. A conflict stops the
# script with nothing pushed: resolving it is a decision between two versions of the same change,
# which ci-check-test-branch.sh leaves to whoever pushes test, not to automation.

remote=${TEST_SYNC_REMOTE:-origin}
repo=$(git rev-parse --show-toplevel)
# Explicit refspecs ensure single-branch clones still create/update refs/remotes/$remote/*.
git -C "$repo" fetch -q "$remote" \
  "+refs/heads/main:refs/remotes/$remote/main" \
  "+refs/heads/test:refs/remotes/$remote/test"
for ref in "$@"; do
  case $ref in main | test) continue ;; esac
  git -C "$repo" fetch -q "$remote" "+refs/heads/$ref:refs/remotes/$remote/$ref"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/aip-test-sync.XXXXXX")
rmdir "$work"
cleanup() { git -C "$repo" worktree remove --force "$work" >/dev/null 2>&1 || rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$repo" worktree add -q --detach "$work" "$remote/test"

for ref in main "$@"; do
  if git -C "$work" merge-base --is-ancestor "$remote/$ref" HEAD; then
    echo "test already contains $remote/$ref"
    continue
  fi
  if ! git -C "$work" merge -q --ff --no-edit -m "Merge $remote/$ref into test" "$remote/$ref"; then
    git -C "$work" merge --abort >/dev/null 2>&1 || true
    echo "Merging $remote/$ref into test conflicts; nothing was pushed. Resolve it by hand." >&2
    exit 1
  fi
  echo "Merged $remote/$ref into test"
done

if [ "$(git -C "$work" rev-parse HEAD)" = "$(git -C "$repo" rev-parse "$remote/test")" ]; then
  echo "test is already up to date; nothing to push. Run Deploy test by hand to redeploy it."
  exit 0
fi
# Only merges of commits that already passed their own checks; the pre-push hook would re-run
# typecheck on the whole merge for nothing.
AIP_PRE_PUSH=skip git -C "$work" push -q "$remote" HEAD:test
echo "Pushed test at $(git -C "$work" rev-parse --short HEAD); Deploy test starts from this push."
