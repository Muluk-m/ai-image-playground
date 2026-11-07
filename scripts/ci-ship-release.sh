#!/usr/bin/env bash
# ci-ship-release.sh <release-dir> <paid|test> <run-id>
#
# Streams a built release to the VPS receiver (scripts/ci-receive.sh behind a forced-command key)
# and rolls it out. Test and production share one host deploy lock. When the lock is busy the
# receiver changes nothing and exits 75; this script then waits and retries only while the holder
# is the *other* environment's CI receive. That holder moves a different deployment, so going
# after it never moves this one to an unexpected commit. Any other holder (a manual rollback,
# app-compose, a rollout of the same target) still fails at once: a queued rollout would undo it.
#
# Environment: VPS_SSH_USER, VPS_SSH_HOST, VPS_KEY_FILE, VPS_KNOWN_HOSTS_FILE.
# DEPLOY_LOCK_WAIT_SECONDS (default 900) bounds the wait, DEPLOY_LOCK_RETRY_SECONDS (default 30)
# spaces the attempts. AIP_SHIP_SSH replaces ssh in tests.
set -euo pipefail

release_dir=$1
target=$2
run_id=$3
case "$target" in
  paid) other=test ;;
  test) other=paid ;;
  *)
    echo "unknown target: $target" >&2
    exit 2
    ;;
esac
release_id=$(basename -- "$release_dir")
wait_limit=${DEPLOY_LOCK_WAIT_SECONDS:-900}
retry_every=${DEPLOY_LOCK_RETRY_SECONDS:-30}
ssh_bin=${AIP_SHIP_SSH:-ssh}
stderr_copy=$(mktemp)
trap 'rm -f "$stderr_copy"' EXIT

waited=0
while :; do
  # The receiver's output (stderr included) goes to the job log and to a copy that names the
  # lock holder. PIPESTATUS keeps tar's and ssh's own statuses apart from tee's.
  set +e
  tar -C "$release_dir" -czf - . |
    "$ssh_bin" -i "${VPS_KEY_FILE:-}" -o IdentitiesOnly=yes -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${VPS_KNOWN_HOSTS_FILE:-}" \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=10 \
      "${VPS_SSH_USER:-}@${VPS_SSH_HOST:-}" "deploy $release_id $target $run_id" 2>&1 |
    tee "$stderr_copy"
  codes=("${PIPESTATUS[@]}")
  set -e
  status=${codes[1]}
  if [ "$status" -eq 0 ] && [ "${codes[0]}" -ne 0 ]; then status=${codes[0]}; fi
  [ "$status" -eq 75 ] || exit "$status"

  # The receiver prints the holder's owner file indented by two spaces; `what=` names the entry.
  if ! grep -q "^  what=receive $other " "$stderr_copy"; then
    echo "::error::VPS deploy lock is held by a rollout that is not the $other CI deploy (manual rollback, app-compose or another $target rollout). Nothing was changed; re-run this job once it finishes."
    exit 75
  fi
  if [ "$waited" -ge "$wait_limit" ]; then
    echo "::error::The $other deploy still holds the VPS deploy lock after ${waited}s. Nothing was changed; re-run this job once it finishes."
    exit 75
  fi
  echo "The $other deploy holds the VPS deploy lock; retrying in ${retry_every}s (waited ${waited}s of ${wait_limit}s)."
  sleep "$retry_every"
  waited=$((waited + retry_every))
done
