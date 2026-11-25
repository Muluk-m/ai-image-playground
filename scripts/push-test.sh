#!/usr/bin/env bash
# push-test.sh — the only way to put work branches on the test site.
#
#   scripts/push-test.sh [--no-dispatch] [--wait-ci <seconds>] <branch>...
#
# Deploy test (.github/workflows/deploy-test.yml) kept failing for two reasons this script removes:
#   1. Branches went into `test` without ever running CI, so the deploy was the first place their
#      type errors and broken tests showed up. Here every branch must first have a `Web checks`
#      run on its exact pushed commit (pull request, push or manual dispatch) where every job Deploy
#      test would otherwise rerun succeeded. A branch with no run gets one dispatched, and we wait.
#   2. `main` moved between "merge main into test" and the push, so scripts/ci-check-test-branch.sh
#      rejected the push. Here the merge happens in a throwaway worktree from the latest
#      origin/test, origin/main is fetched again right before pushing, and a moved main or a
#      rejected push (someone else pushed test) simply starts the merge again.
#
# Never force-pushes, never rebases test, never touches the caller's checkout. A merge conflict
# stops the script with test unchanged; resolve it in a relay worktree as docs/agents/release.md
# describes. The job list comes from scripts/ci-reuse-web-checks.sh so there is one list.
#
# Environment (mostly for tests): PUSH_TEST_REPO (owner/name, default Muluk-m/ai-image-playground),
# PUSH_TEST_REMOTE (default origin), PUSH_TEST_POLL (default 20), PUSH_TEST_ATTEMPTS (default 5).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=${PUSH_TEST_REPO:-Muluk-m/ai-image-playground}
remote=${PUSH_TEST_REMOTE:-origin}
poll=${PUSH_TEST_POLL:-20}
attempts=${PUSH_TEST_ATTEMPTS:-5}
wait_ci=2700
dispatch=true

usage() {
  cat <<'EOF'
Usage: scripts/push-test.sh [options] <branch>...

Merges the latest origin/main and the given (already pushed) work branches into origin/test and
pushes it, which deploys https://test.muvloom.online. Each branch's pushed commit must pass
Web checks first; a branch without a run gets one dispatched.

Options:
  --no-dispatch         Fail instead of dispatching Web checks for a branch that has no run
  --wait-ci <seconds>   Max seconds to wait for Web checks (default: 2700)
  -h, --help            Show this help
EOF
}

die() {
  echo "push-test: $*" >&2
  exit "${code:-1}"
}

branches=()
while [ "$#" -gt 0 ]; do
  case $1 in
    --no-dispatch) dispatch=false; shift ;;
    --wait-ci)
      [ "$#" -ge 2 ] || die "missing value for --wait-ci"
      wait_ci=$2
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; code=2 die "unknown option $1" ;;
    *) branches+=("$1"); shift ;;
  esac
done
[ "${#branches[@]}" -gt 0 ] || { usage >&2; code=2 die "name at least one work branch"; }
for b in "${branches[@]}"; do
  case $b in
    main | test | "$remote"/*) code=2 die "'$b' is not a work branch (give the bare branch name)" ;;
  esac
done

required_json=$(sed -n '/^REQUIRED=(/,/^)/p' "$here/ci-reuse-web-checks.sh" | grep -o "'[^']*'" | tr -d "'" |
  jq -R . | jq -sc .)
[ "$(jq length <<<"$required_json")" -gt 0 ] || die "could not read REQUIRED from ci-reuse-web-checks.sh"

git fetch -q "$remote" main test "${branches[@]}" || die "git fetch failed (is every branch pushed?)"

# Each branch's pushed commit; a local branch that differs from it would silently leave work out.
shas=()
for b in "${branches[@]}"; do
  sha=$(git rev-parse -q --verify "refs/remotes/$remote/$b^{commit}") || die "$remote/$b does not exist; push it first"
  if local=$(git rev-parse -q --verify "refs/heads/$b^{commit}"); then
    [ "$local" = "$sha" ] || die "local $b ($local) differs from $remote/$b ($sha); push or reset it first"
  fi
  shas+=("$sha")
done

# ok | bad <run-id> | pending | none — over every Web checks run of the commit, any event.
# ok: some run has every required job succeeded. Otherwise the newest run decides.
verdict() {
  local sha=$1 runs ids id status jobs v newest=
  runs=$(gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$sha&per_page=20") || { echo pending; return; }
  ids=$(jq -r --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.created_at) | reverse | .[:5][] | "\(.id) \(.status)"' <<<"$runs") ||
    { echo pending; return; }
  [ -n "$ids" ] || { echo none; return; }
  while read -r id status; do
    jobs=$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" | jq -c '[.jobs[] | {name, conclusion}]') ||
      jobs='[]'
    v=$(jq -r --argjson req "$required_json" --arg status "$status" '
      . as $jobs
      | [$req[] | . as $n | ([$jobs[] | select(.name == $n)] | first) as $j
        | if $j == null then "missing"
          elif $j.conclusion == "success" then "ok"
          elif $j.conclusion == null then "pending"
          else "bad" end] as $v
      | if all($v[]; . == "ok") then "ok"
        elif any($v[]; . == "bad") then "bad"
        elif $status != "completed" then "pending"
        else "bad" end' <<<"$jobs")
    [ "$v" != ok ] || { echo ok; return; }
    [ -n "$newest" ] || newest="$v $id"
  done <<<"$ids"
  case $newest in
    pending*) echo pending ;;
    *) echo "bad ${newest#* }" ;;
  esac
}

started=$(date +%s)
dispatched=()
for i in "${!branches[@]}"; do
  b=${branches[$i]} sha=${shas[$i]}
  while :; do
    read -r v run_id <<<"$(verdict "$sha")"
    case $v in
      ok)
        echo "push-test: $b ${sha:0:9} passed Web checks."
        break
        ;;
      bad)
        failed=$(gh api "repos/$repo/actions/runs/$run_id/jobs?filter=latest&per_page=100" |
          jq -r '[.jobs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null) | .name] | join(", ")' || true)
        die "$b ${sha:0:9} failed Web checks (run $run_id: ${failed:-see the run}). Fix the branch, push, rerun this.
  gh run view $run_id --repo $repo --log-failed"
        ;;
      none)
        if [[ " ${dispatched[*]-} " != *" $b "* ]]; then
          [ "$dispatch" = true ] || die "$b ${sha:0:9} has no Web checks run (open a PR or drop --no-dispatch)"
          gh api -X POST "repos/$repo/actions/workflows/web.yml/dispatches" -f "ref=$b" >/dev/null ||
            die "could not dispatch Web checks for $b"
          dispatched+=("$b")
          echo "push-test: dispatched Web checks for $b ${sha:0:9}; waiting."
        fi
        ;;
      *) ;;
    esac
    [ $(($(date +%s) - started)) -lt "$wait_ci" ] || die "Web checks for $b ${sha:0:9} not done after ${wait_ci}s"
    sleep "$poll"
  done
  behind=$(git rev-list --count "$sha..refs/remotes/$remote/main")
  [ "$behind" -eq 0 ] ||
    echo "push-test: note: $b is $behind commit(s) behind main; its CI did not see them, Deploy test's gates will."
done

wt=
cleanup() { [ -z "$wt" ] || { git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; }; }
trap cleanup EXIT

for attempt in $(seq 1 "$attempts"); do
  git fetch -q "$remote" main test "${branches[@]}" || die "git fetch failed"
  for i in "${!branches[@]}"; do
    now=$(git rev-parse "refs/remotes/$remote/${branches[$i]}")
    [ "$now" = "${shas[$i]}" ] || die "${branches[$i]} moved to ${now:0:9} while waiting; rerun to check the new commit"
  done
  test_sha=$(git rev-parse "refs/remotes/$remote/test")
  main_sha=$(git rev-parse "refs/remotes/$remote/main")

  cleanup
  wt=$(mktemp -d "${TMPDIR:-/tmp}/push-test.XXXXXX")
  rmdir "$wt"
  git worktree add -q --detach "$wt" "$test_sha"
  for ref in main "${branches[@]}"; do
    if ! git -C "$wt" merge -q --no-edit -m "Merge $ref into test" "refs/remotes/$remote/$ref" >/dev/null; then
      files=$(git -C "$wt" diff --name-only --diff-filter=U | sed 's/^/    /')
      git -C "$wt" merge --abort || true
      code=3 die "merging $ref into test conflicts; test is unchanged. Conflicting files:
$files
  Resolve it in a relay worktree from $remote/test (docs/agents/release.md), then push test from there."
    fi
  done
  head=$(git -C "$wt" rev-parse HEAD)
  if [ "$head" = "$test_sha" ]; then
    echo "push-test: test already contains main and ${branches[*]}; nothing to push."
    exit 0
  fi

  git fetch -q "$remote" main
  if [ "$(git rev-parse "refs/remotes/$remote/main")" != "$main_sha" ]; then
    echo "push-test: main moved while merging; merging again (attempt $attempt/$attempts)."
    continue
  fi
  if git -C "$wt" push -q "$remote" "HEAD:refs/heads/test"; then
    echo "push-test: pushed test ${head:0:9} (main ${main_sha:0:9} + ${branches[*]})."
    echo "  Follow it: gh run list --repo $repo --workflow deploy-test.yml --commit $head"
    exit 0
  fi
  echo "push-test: push rejected (someone else pushed test); merging again (attempt $attempt/$attempts)."
done
die "gave up after $attempts attempts; test or main keeps moving"
