#!/bin/sh
set -eu
# Refuses to build the test site from a branch that is behind main. Run inside a checkout of the
# test branch with origin/main fetched and full history.
#
#   scripts/ci-check-test-branch.sh [remote]
#
# Exits 0 when test already contains main, and fails otherwise having printed how far behind it
# is and which commits are missing.
#
# Why this is a failure and not an automatic merge: a test site built from a branch that is
# behind main shows behaviour nobody is going to ship, and the difference is invisible on the
# page. Merging it here would also mean resolving conflicts unattended — deciding between two
# versions of the same change, which is how a test site ends up running something that exists
# nowhere else. A red run is the signal; push test with scripts/push-test.sh, which merges main and retries.

remote=${1:-origin}

main=$(git rev-parse "$remote/main")
head=$(git rev-parse HEAD)

if git merge-base --is-ancestor "$main" "$head"; then
  echo "test contains $remote/main ($main)."
  exit 0
fi

behind=$(git rev-list --count "$head..$main")
echo "::error::test is behind $remote/main by $behind commit(s). Rerun scripts/push-test.sh <branch>... (it merges $remote/main and retries); the test site is only built from a branch that already contains main."
echo
echo "Missing from test:"
git log --oneline --no-decorate "$head..$main"
exit 1
