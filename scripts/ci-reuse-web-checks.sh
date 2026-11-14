#!/usr/bin/env bash
# ci-reuse-web-checks.sh
#
# Deploy test (.github/workflows/deploy-test.yml) calls this to decide whether the checks it
# would run were already run, on this very commit, by the `Web checks` workflow that every push
# to `test` also triggers. Writes `reused=true|false` to $GITHUB_OUTPUT and always exits 0:
# anything short of a positive answer is `false`, and Deploy test then runs its own gates exactly
# as before. It never returns true without proof.
#
# Proof, all of it required:
#   - a web.yml run for event `push`, branch `test`, head_sha == $SHA (push runs use the workflow
#     file at that commit, so the gates are the ones that commit defines);
#   - that run is completed and every job in REQUIRED below ended `success` (a skipped or missing
#     job is not success, so a trimmed or renamed web.yml job falls back to the full run).
# While the run is still in progress this waits; a required job that already failed ends the wait.
# No run after WEB_RUN_GRACE seconds, or still running after WEB_WAIT_LIMIT seconds, is `false`.
#
# REQUIRED must follow the job names in web.yml. It covers what Deploy test's own gates cover:
# public lint/typecheck/build and browser startup (lint, typecheck, build), the database-backed
# and web tests (bff, web-test), and the overlay pinned by private.lock (with-overlay: lint and
# private tests; with-overlay (build), with-overlay (typecheck)).
#
# Environment: GH_TOKEN, REPO (owner/name), SHA, GITHUB_OUTPUT.
# WEB_RUN_GRACE (default 240), WEB_WAIT_LIMIT (default 1500), WEB_POLL (default 10).
set -u

REQUIRED=(
  'lint' 'typecheck' 'build'
  'bff (bff 1/3)' 'bff (bff 2/3)' 'bff (bff 3/3)' 'bff (packages)'
  'web-test (1/3)' 'web-test (2/3)' 'web-test (3/3)'
  'with-overlay' 'with-overlay (build)' 'with-overlay (typecheck)'
)

repo=${REPO:?REPO is required}
sha=${SHA:?SHA is required}
out=${GITHUB_OUTPUT:-/dev/stdout}
grace=${WEB_RUN_GRACE:-240}
limit=${WEB_WAIT_LIMIT:-1500}
poll=${WEB_POLL:-10}

finish() {
  echo "reused=$1" >> "$out"
  echo "::notice::Web checks reuse for $sha: $1 ($2)"
  exit 0
}

required_json=$(printf '%s\n' "${REQUIRED[@]}" | jq -R . | jq -s -c .) || finish false "jq failed"

waited=0
while :; do
  # Newest run of the exact commit. A failed read is just another poll.
  run=$(gh api "repos/$repo/actions/workflows/web.yml/runs?head_sha=$sha&event=push&branch=test&per_page=20" |
    jq -c --arg sha "$sha" '[.workflow_runs[] | select(.head_sha == $sha and .event == "push" and .head_branch == "test")] | sort_by(.created_at) | last // empty' 2>/dev/null) || run=
  if [ -z "$run" ]; then
    [ "$waited" -lt "$grace" ] || finish false "no Web checks run for the commit after ${waited}s"
  else
    id=$(jq -er .id <<<"$run") || id=
    status=$(jq -er .status <<<"$run") || status=
    jobs=
    if [ -n "$id" ]; then
      jobs=$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
        jq -c '[.jobs[] | {name, conclusion}]' 2>/dev/null) || jobs=
    fi
    if [ -n "$jobs" ]; then
      # One word for all required jobs: ok (all success), bad (one finished without success),
      # otherwise pending (not started, not finished or not listed yet).
      verdict=$(jq -r --argjson req "$required_json" '
        . as $jobs
        | [$req[] | . as $n | ([$jobs[] | select(.name == $n)] | first) as $j
          | if $j == null then "pending"
            elif $j.conclusion == "success" then "ok"
            elif $j.conclusion == null then "pending"
            else "bad" end] as $v
        | if any($v[]; . == "bad") then "bad"
          elif all($v[]; . == "ok") then "ok"
          else "pending" end' <<<"$jobs") || verdict=pending
      case "$verdict" in
        bad) finish false "run $id: a required job did not succeed" ;;
        ok) [ "$status" != completed ] || finish true "run $id: every required job succeeded" ;;
        *) [ "$status" != completed ] || finish false "run $id completed without every required job" ;;
      esac
    fi
  fi
  [ "$waited" -lt "$limit" ] || finish false "Web checks still not conclusive after ${waited}s"
  sleep "$poll"
  waited=$((waited + poll))
done
