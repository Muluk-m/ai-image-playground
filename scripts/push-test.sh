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
pushes it, which deploys https://test.muvloom.online. Each branch's pushed commit must first pass
the Web checks jobs Deploy test gates on (REQUIRED in scripts/ci-reuse-web-checks.sh); a branch
without a run gets one dispatched.

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

need_int() {
  case $2 in
    '' | *[!0-9]*) code=2 die "$1 must be a whole number of seconds or attempts, got '$2'" ;;
  esac
}

branches=()
while [ "$#" -gt 0 ]; do
  case $1 in
    --no-dispatch) dispatch=false; shift ;;
    --wait-ci)
      [ "$#" -ge 2 ] || code=2 die "missing value for --wait-ci"
      wait_ci=$2
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; code=2 die "unknown option $1" ;;
    *) branches+=("$1"); shift ;;
  esac
done
need_int --wait-ci "$wait_ci"
need_int PUSH_TEST_POLL "$poll"
need_int PUSH_TEST_ATTEMPTS "$attempts"
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

# One line about the commit's Web checks, decided by its newest run (any event) so an old green
# never hides a newer red. A format dispatch (biome --write before lint) proves nothing and is
# passed over. Prints one of:
#   ok | pending | none | error
#   bad <run-id> <failed jobs> | missing <run-id> <required jobs that were skipped or absent>
verdict() {
  local sha=$1 runs ids id status jobs
  runs=$(gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$sha&per_page=20") || { echo error; return; }
  ids=$(jq -r --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.created_at) | reverse | .[:10][] | "\(.id) \(.status)"' <<<"$runs") ||
    { echo error; return; }
  while read -r id status; do
    [ -n "$id" ] || continue
    jobs=$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100") || { echo error; return; }
    if jq -e '[.jobs[] | select(.name == "lint") | .steps[]?
        | select(.name == "Apply optional formatting fixes" and .conclusion != null and .conclusion != "skipped")] | length > 0' \
      <<<"$jobs" >/dev/null 2>&1; then
      continue
    fi
    jq -r --argjson req "$required_json" --arg status "$status" --arg id "$id" '
      [.jobs[] | {name, conclusion}] as $jobs
      | [$req[] | . as $n | ([$jobs[] | select(.name == $n)] | first) as $j
        | {n: $n, v: (if $j == null or $j.conclusion == "skipped" then "missing"
                      elif $j.conclusion == "success" then "ok"
                      elif $j.conclusion == null then "pending"
                      else "bad" end)}] as $v
      | if all($v[]; .v == "ok") then "ok"
        elif any($v[]; .v == "bad") then "bad \($id) \([$v[] | select(.v == "bad") | .n] | join(", "))"
        elif $status != "completed" then "pending"
        else "missing \($id) \([$v[] | select(.v == "missing") | .n] | join(", "))" end' <<<"$jobs" ||
      echo error
    return
  done <<<"$ids"
  echo none
}

started=$(date +%s)
errors=0
dispatched=()
for i in "${!branches[@]}"; do
  b=${branches[$i]} sha=${shas[$i]}
  while :; do
    read -r v run_id detail <<<"$(verdict "$sha")"
    [ "$v" = error ] && errors=$((errors + 1)) || errors=0
    case $v in
      ok)
        echo "push-test: $b ${sha:0:9} passed Web checks."
        break
        ;;
      bad)
        die "$b ${sha:0:9} failed Web checks (run $run_id: $detail). Fix the branch, push, rerun this.
  gh run view $run_id --repo $repo --log-failed"
        ;;
      missing)
        die "$b ${sha:0:9}: Web checks run $run_id finished without these required jobs: $detail.
  REQUIRED in scripts/ci-reuse-web-checks.sh must match the job names in .github/workflows/web.yml."
        ;;
      none)
        if [[ " ${dispatched[*]-} " != *" $b "* ]]; then
          [ "$dispatch" = true ] || die "$b ${sha:0:9} has no Web checks run (open a PR or drop --no-dispatch)"
          gh api -X POST "repos/$repo/actions/workflows/web.yml/dispatches" -f "ref=$b" >/dev/null ||
            die "could not dispatch Web checks for $b (gh auth status?)"
          dispatched+=("$b")
          echo "push-test: dispatched Web checks for $b ${sha:0:9}; waiting."
        fi
        ;;
      error)
        echo "push-test: warning: GitHub API call failed ($errors in a row)." >&2
        [ "$errors" -lt 3 ] || die "GitHub API keeps failing; check \`gh auth status\` and network, then rerun."
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

# test already holds everything: make sure that commit actually has (or gets) a deployment.
ensure_deployed() {
  local sha=$1 last status conclusion url
  last=$(gh api "repos/$repo/actions/workflows/deploy-test.yml/runs?head_sha=$sha&per_page=20" |
    jq -r --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.created_at) | last // {} | "\(.status // "none")|\(.conclusion // "")|\(.html_url // "")"') ||
    die "could not read Deploy test runs for ${sha:0:9}"
  IFS='|' read -r status conclusion url <<<"$last"
  if [ "$status" != completed ] && [ "$status" != none ]; then
    echo "push-test: Deploy test for ${sha:0:9} is $status: $url"
  elif [ "$conclusion" = success ]; then
    echo "push-test: ${sha:0:9} is already deployed to the test site: $url"
  else
    gh api -X POST "repos/$repo/actions/workflows/deploy-test.yml/dispatches" -f ref=test >/dev/null ||
      die "could not dispatch Deploy test"
    echo "push-test: last Deploy test for ${sha:0:9} was ${conclusion:-missing}; dispatched a new one."
  fi
}

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
    ensure_deployed "$test_sha"
    exit 0
  fi

  git fetch -q "$remote" main
  if [ "$(git rev-parse "refs/remotes/$remote/main")" != "$main_sha" ]; then
    echo "push-test: main moved while merging; merging again (attempt $attempt/$attempts)."
    continue
  fi
  if out=$(git -C "$wt" push -q "$remote" "HEAD:refs/heads/test" 2>&1); then
    echo "push-test: pushed test ${head:0:9} (main ${main_sha:0:9} + ${branches[*]})."
    echo "  Follow it: gh run list --repo $repo --workflow deploy-test.yml --commit $head"
    exit 0
  fi
  # Retry only when test really moved under us; anything else (permissions, protection, network)
  # will not fix itself.
  now=$(git ls-remote "$remote" refs/heads/test | cut -f1) || now=
  if [ -z "$now" ] || [ "$now" = "$test_sha" ]; then
    die "push to test failed:
$out"
  fi
  echo "push-test: test moved to ${now:0:9} while pushing; merging again (attempt $attempt/$attempts)."
done
die "gave up after $attempts attempts; test or main keeps moving"
