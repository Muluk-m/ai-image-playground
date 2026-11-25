#!/usr/bin/env bash
# test-sync.sh — the only way to push the shared test branch (and so deploy the test site).
#
#   scripts/test-sync.sh [--no-dispatch] [--wait-ci <seconds>] [branch ...]
#
# With no branches it only brings test up to date with main.
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
# Environment (mostly for tests): TEST_SYNC_REPO (owner/name, default Muluk-m/ai-image-playground),
# TEST_SYNC_REMOTE (default origin), TEST_SYNC_POLL (default 20), TEST_SYNC_ATTEMPTS (default 5),
# TEST_SYNC_FOLLOW_WAIT (seconds to watch Deploy test's branch check after pushing, default 600).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=${TEST_SYNC_REPO:-Muluk-m/ai-image-playground}
remote=${TEST_SYNC_REMOTE:-origin}
poll=${TEST_SYNC_POLL:-20}
attempts=${TEST_SYNC_ATTEMPTS:-5}
follow_wait=${TEST_SYNC_FOLLOW_WAIT:-600}
wait_ci=2700
dispatch=true

usage() {
  cat <<'EOF'
Usage: scripts/test-sync.sh [options] [branch ...]

Merges the latest origin/main and the given (already pushed) work branches into origin/test and
pushes it, which deploys https://test.muvloom.online. With no branches, only main is merged. Each branch's pushed commit must first pass
the Web checks jobs Deploy test gates on (REQUIRED in scripts/ci-reuse-web-checks.sh); a branch
without a run gets one dispatched.

Options:
  --no-dispatch         Fail instead of dispatching Web checks for a branch that has no run
  --wait-ci <seconds>   Max seconds to wait for Web checks (default: 2700)
  -h, --help            Show this help
EOF
}

die() {
  echo "test-sync: $*" >&2
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
    main | test) shift ;; # always merged / the target: nothing to add
    *) branches+=("$1"); shift ;;
  esac
done
need_int --wait-ci "$wait_ci"
need_int TEST_SYNC_POLL "$poll"
need_int TEST_SYNC_ATTEMPTS "$attempts"
need_int TEST_SYNC_FOLLOW_WAIT "$follow_wait"
# bash 3.2 treats "${arr[@]}" of an empty array as unset under `set -u`; these expand to nothing.
all() { [ "${#branches[@]}" -eq 0 ] || printf '%s\n' "${branches[@]}"; }
idx() { local i=0; while [ "$i" -lt "${#branches[@]}" ]; do echo "$i"; i=$((i + 1)); done; }
for b in $(all); do
  case $b in
    "$remote"/*) code=2 die "'$b' is not a work branch (give the bare branch name)" ;;
  esac
done
names=${branches[*]-}

# Explicit refspecs so single-branch clones still get refs/remotes/$remote/<name>.
fetch() {
  local specs=() ref
  for ref in "$@"; do specs+=("+refs/heads/$ref:refs/remotes/$remote/$ref"); done
  git fetch -q "$remote" "${specs[@]}"
}

required_json=$(sed -n '/^REQUIRED=(/,/^)/p' "$here/ci-reuse-web-checks.sh" | grep -o "'[^']*'" | tr -d "'" |
  jq -R . | jq -sc .)
[ "$(jq length <<<"$required_json")" -gt 0 ] || die "could not read REQUIRED from ci-reuse-web-checks.sh"

# shellcheck disable=SC2046 # branch names have no whitespace
fetch main test $(all) || die "git fetch failed (is every branch pushed?)"

# Each branch's pushed commit; a local branch that differs from it would silently leave work out.
shas=()
for b in $(all); do
  sha=$(git rev-parse -q --verify "refs/remotes/$remote/$b^{commit}") || die "$remote/$b does not exist; push it first"
  if local=$(git rev-parse -q --verify "refs/heads/$b^{commit}"); then
    [ "$local" = "$sha" ] || die "local $b ($local) differs from $remote/$b ($sha); push or reset it first"
  fi
  shas+=("$sha")
done

# One line about the commit's Web checks, decided by its most recently started run (any event; a
# rerun keeps its id and created_at but gets a new run_started_at) so an old green never hides a
# newer red. A format dispatch (biome --write before lint) proves nothing and is
# passed over. Prints one of:
#   ok | pending | none | error
#   bad <run-id> <failed jobs> | missing <run-id> <required jobs that were skipped or absent>
verdict() {
  local sha=$1 runs ids id status jobs
  runs=$(gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$sha&per_page=100") || { echo error; return; }
  ids=$(jq -r --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.run_started_at // .created_at) | reverse | .[:10][] | "\(.id) \(.status)"' <<<"$runs") ||
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
for i in $(idx); do
  b=${branches[$i]} sha=${shas[$i]}
  while :; do
    read -r v run_id detail <<<"$(verdict "$sha")"
    [ "$v" = error ] && errors=$((errors + 1)) || errors=0
    case $v in
      ok)
        echo "test-sync: $b ${sha:0:9} passed Web checks."
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
          echo "test-sync: dispatched Web checks for $b ${sha:0:9}; waiting."
        fi
        ;;
      error)
        echo "test-sync: warning: GitHub API call failed ($errors in a row)." >&2
        [ "$errors" -lt 3 ] || die "GitHub API keeps failing; check \`gh auth status\` and network, then rerun."
        ;;
      *) ;;
    esac
    [ $(($(date +%s) - started)) -lt "$wait_ci" ] || die "Web checks for $b ${sha:0:9} not done after ${wait_ci}s"
    sleep "$poll"
  done
  behind=$(git rev-list --count "$sha..refs/remotes/$remote/main")
  [ "$behind" -eq 0 ] ||
    echo "test-sync: note: $b is $behind commit(s) behind main; its CI did not see them, Deploy test's gates will."
done

# test already holds everything: make sure that commit actually has (or gets) a deployment.
# Returns 0 when it is already deployed; otherwise a run is going and `since` is set to the
# earliest creation time branch_check should accept for it (empty: any run of the commit).
since=
ensure_deployed() {
  local sha=$1 last status conclusion url
  since=
  last=$(gh api "repos/$repo/actions/workflows/deploy-test.yml/runs?head_sha=$sha&per_page=20" |
    jq -r --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.created_at) | last // {} | "\(.status // "none")|\(.conclusion // "")|\(.html_url // "")"') ||
    die "could not read Deploy test runs for ${sha:0:9}"
  IFS='|' read -r status conclusion url <<<"$last"
  if [ "$status" != completed ] && [ "$status" != none ]; then
    echo "test-sync: Deploy test for ${sha:0:9} is $status: $url"
    return 1
  elif [ "$conclusion" = success ]; then
    echo "test-sync: ${sha:0:9} is already deployed to the test site: $url"
    return 0
  fi
  # A few seconds of slack for clock skew; the run it replaces finished before now.
  since=$(date -u -r $(($(date +%s) - 5)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$(($(date +%s) - 5))" +%Y-%m-%dT%H:%M:%SZ)
  gh api -X POST "repos/$repo/actions/workflows/deploy-test.yml/dispatches" -f ref=test >/dev/null ||
    die "could not dispatch Deploy test"
  echo "test-sync: last Deploy test for ${sha:0:9} was ${conclusion:-missing}; dispatched a new one."
  return 1
}

# Deploy test checks "test contains main" when its Backend images job starts, a minute or two
# after the push (or dispatch); main can move in between. Watch that one step of the newest push or
# dispatch run of the commit created at or after $2: ok | behind | unknown <why>.
branch_check() {
  local sha=$1 after=${2-} run id jobs step deadline
  deadline=$(($(date +%s) + follow_wait))
  while :; do
    run=$(gh api "repos/$repo/actions/workflows/deploy-test.yml/runs?head_sha=$sha&per_page=20" |
      jq -c --arg sha "$sha" --arg after "$after" '[.workflow_runs[]
        | select(.head_sha == $sha and (.event == "push" or .event == "workflow_dispatch") and .created_at >= $after)]
        | sort_by(.created_at) | last // empty' 2>/dev/null) || run=
    if [ -n "$run" ]; then
      id=$(jq -r .id <<<"$run")
      jobs=$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" 2>/dev/null) || jobs='{"jobs":[]}'
      step=$(jq -r '[.jobs[] | select(.name == "Backend images") | .steps[]? | select(.name | contains("ci-check-test-branch"))
        | .conclusion // "pending"] | first // "pending"' <<<"$jobs" 2>/dev/null) || step=pending
      case $step in
        success) echo ok; return ;;
        failure) echo behind; return ;;
        pending) [ "$(jq -r .status <<<"$run")" != completed ] || { echo "unknown run $id ended before the branch check"; return; } ;;
        *) echo "unknown branch check $step in run $id"; return ;;
      esac
    fi
    [ "$(date +%s)" -lt "$deadline" ] || { echo "unknown no verdict after ${follow_wait}s"; return; }
    sleep "$poll"
  done
}

wt=
cleanup() { [ -z "$wt" ] || { git worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; }; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for attempt in $(seq 1 "$attempts"); do
  # shellcheck disable=SC2046
  fetch main test $(all) || die "git fetch failed"
  for i in $(idx); do
    now=$(git rev-parse "refs/remotes/$remote/${branches[$i]}")
    [ "$now" = "${shas[$i]}" ] || die "${branches[$i]} moved to ${now:0:9} while waiting; rerun to check the new commit"
  done
  test_sha=$(git rev-parse "refs/remotes/$remote/test")
  main_sha=$(git rev-parse "refs/remotes/$remote/main")

  cleanup
  wt=$(mktemp -d "${TMPDIR:-/tmp}/aip-test-sync.XXXXXX")
  rmdir "$wt"
  git worktree add -q --detach "$wt" "$test_sha"
  # --ff overrides a user's merge.ff=only, which would otherwise turn every real merge into a "conflict".
  # Merge the exact commits checked above, never the remote-tracking refs: another fetch (an IDE,
  # another terminal) may move those at any moment, and the worktree shares them.
  for i in -1 $(idx); do
    if [ "$i" = -1 ]; then ref=main rev=$main_sha; else ref=${branches[$i]} rev=${shas[$i]}; fi
    if ! git -C "$wt" merge -q --ff --no-edit -m "Merge $ref into test" "$rev" >/dev/null; then
      files=$(git -C "$wt" diff --name-only --diff-filter=U | sed 's/^/    /')
      git -C "$wt" merge --abort || true
      code=3 die "merging $ref into test conflicts; test is unchanged. Conflicting files:
$files
  Resolve it in a relay worktree from $remote/test (docs/agents/release.md), then push test from there."
    fi
  done
  head=$(git -C "$wt" rev-parse HEAD)
  if [ "$head" = "$test_sha" ]; then
    echo "test-sync: test already contains main and ${names:-nothing else}; nothing to push."
    ensure_deployed "$test_sha" && exit 0
    pushed=$test_sha
  else
    pushed=''
  fi

  if [ -z "$pushed" ]; then
    fetch main
    if [ "$(git rev-parse "refs/remotes/$remote/main")" != "$main_sha" ]; then
      echo "test-sync: main moved while merging; merging again (attempt $attempt/$attempts)."
      continue
    fi
    # Every branch already passed Web checks; the pre-push hook would only re-run typecheck on the merge.
    if ! out=$(AIP_PRE_PUSH=skip git push -q "$remote" "$head:refs/heads/test" 2>&1); then
      # Retry only when test really moved under us; anything else (permissions, protection, network)
      # will not fix itself.
      now=$(git ls-remote "$remote" refs/heads/test | cut -f1) || now=
      if [ -z "$now" ] || [ "$now" = "$test_sha" ]; then
        die "push to test failed:
$out"
      fi
      echo "test-sync: test moved to ${now:0:9} while pushing; merging again (attempt $attempt/$attempts)."
      continue
    fi
    pushed=$head
    since=
    echo "test-sync: pushed test ${head:0:9} (main ${main_sha:0:9} + ${names:-nothing else}); watching Deploy test's branch check."
  fi
  read -r check why <<<"$(branch_check "$pushed" "$since")"
  case $check in
    ok)
      echo "test-sync: Deploy test accepted ${pushed:0:9} (test contains main); it continues on its own."
      echo "  Follow it: gh run list --repo $repo --workflow deploy-test.yml --commit $pushed"
      exit 0
      ;;
    behind)
      echo "test-sync: main moved before Deploy test started, so it rejected ${pushed:0:9}; merging again (attempt $attempt/$attempts)."
      continue
      ;;
    *)
      echo "test-sync: warning: could not confirm Deploy test's branch check ($why)." >&2
      echo "  Check it: gh run list --repo $repo --workflow deploy-test.yml --commit $pushed"
      exit 0
      ;;
  esac
done
die "gave up after $attempts attempts; test or main keeps moving"
