#!/bin/sh
set -eu
# SSH forced command for the GitHub Actions deploy keys on the production VPS. Installed as
# ~/bin/aip-ci-receive and bound to each key in ~/.ssh/authorized_keys with a fixed scope; the
# caller cannot choose it, so a key can only deploy the targets its scope names:
#
#   command="/home/ubuntu/bin/aip-ci-receive release",restrict ssh-ed25519 AAAA… production
#   command="/home/ubuntu/bin/aip-ci-receive test",restrict ssh-ed25519 AAAA… test
#
# Scope `release` accepts only paid, scope `test` accepts only test. No scope, or any
# other word, refuses everything.
#
# The archive is data only. Deployment code lives in the server-side runtime selected below; a
# caller may not replace it by uploading a different shell script.
#
# paid runs the deployment code of the very commit it deploys: the receiver reads the public
# commit from images.tsv, checks that it is on main of the public repository (merging into main
# already needs Nain's sign-off), and unpacks that commit's deploy/ and scripts/ into
# ~/deploy-runtimes/<sha>. test, whose branch is pushed without review, never executes scripts from
# the test branch; instead it fetches main and runs main's latest deployment runtime (warning only
# when the test commit itself modified deploy/ or scripts/), so neither environment depends on a
# hand-copied runtime directory on the host.
#
# The only accepted command is `deploy <release-id> <target> <run-id>`, with the release data as a
# gzipped tar on stdin (`tar -C "$out" -czf - .`). It unpacks into `~/releases/<release-id>`,
# which must not exist yet, and invokes the selected runtime.
# Anything else is refused before a file is written.

receiver_path=$0

reject() {
  echo "Rejected: expected 'deploy <aip-<12 hex>-<12 hex>> <target> <run-id>' with a target this key may deploy" >&2
  exit 2
}

# The scope comes from the forced command in authorized_keys, never from the caller.
scope=${1:-}
case "$scope" in release | test) ;; *) echo "Rejected: this key has no deploy scope" >&2; exit 2 ;; esac

# Word-split without globbing; IFS splitting also means no word can hold a newline.
set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
set +f
[ "$#" -eq 4 ] && [ "$1" = deploy ] || reject
release_id=$2
target=$3
run_id=$4
printf '%s\n' "$release_id" | grep -Eqx 'aip-[0-9a-f]{12}-[0-9a-f]{12}' || reject
case "$scope:$target" in release:paid | test:test) ;; *) reject ;; esac
printf '%s\n' "$run_id" | grep -Eqx '[0-9]{1,20}' || reject

releases_root=${HOME:?HOME must be set}/releases
release=$releases_root/$release_id
mkdir -p "$releases_root"
if [ -e "$release" ]; then
  # The same commit again (a manual re-run): keep the earlier directory for rollback and use one
  # named after this run.
  release=$release.run-$run_id
  if [ -e "$release" ]; then
    echo "Release directory already exists: $release. Remove it or deploy it by hand." >&2
    exit 1
  fi
fi

incoming=$(mktemp -d "$releases_root/.incoming.XXXXXX")
created=
# shellcheck disable=SC2329  # invoked via trap cleanup EXIT
cleanup() {
  status=$?
  rm -rf "$incoming"
  # A release that never reached its receiver is removed so the run can simply be retried.
  if [ "$status" -ne 0 ] && [ -n "$created" ]; then rm -rf "$release"; fi
  if [ -n "${runtimes:-}" ]; then rm -f "$runtimes/.lock.owner.tmp.$$" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# A release without an image archive is well under a megabyte; cap what a key holder can write.
limit=$((64 * 1024 * 1024))
head -c "$((limit + 1))" >"$incoming/release.tgz"
[ "$(wc -c <"$incoming/release.tgz")" -le "$limit" ] || { echo "Release archive exceeds $limit bytes" >&2; exit 1; }

# Only plain data files are accepted: the manifest, its checksum file, and optionally an image
# archive. In particular, an uploaded shell script or deployment directory is invalid.
tar -tzf "$incoming/release.tgz" >"$incoming/names" || { echo "Unreadable release archive" >&2; exit 1; }
tar -tvzf "$incoming/release.tgz" >"$incoming/listing"
if grep -Evx '\./|\./(SHA256SUMS|images\.tsv|images\.tar\.gz)' "$incoming/names" >/dev/null ||
  grep -Ev '^[-d]' "$incoming/listing" >/dev/null; then
  echo "Unsafe archive: only SHA256SUMS, images.tsv, and optional images.tar.gz are accepted" >&2
  exit 1
fi

mkdir "$release"
created=1
tar -xzf "$incoming/release.tgz" -C "$release"
created=
[ -f "$release/SHA256SUMS" ] && [ -f "$release/images.tsv" ] || {
  echo "Incomplete release: SHA256SUMS and images.tsv are required" >&2
  rm -rf "$release"
  exit 1
}

release_commit=$(awk -F '\t' -v target="$target" '$1 == target { print $4; exit }' "$release/images.tsv")

# Overrides for the test suite only. Over SSH (SSH_CONNECTION set) they are ignored, so a key
# holder can never point the runtime at another repository or directory, even if sshd were one
# day configured to pass environment variables through.
if [ -z "${SSH_CONNECTION:-}" ]; then
  runtimes=${AIP_DEPLOY_RUNTIMES_ROOT:-$HOME/deploy-runtimes}
  runtime_url=${AIP_RUNTIME_GIT_URL:-https://github.com/Muluk-m/ai-image-playground.git}
else
  runtimes=$HOME/deploy-runtimes
  runtime_url=https://github.com/Muluk-m/ai-image-playground.git
fi

# Files a runtime cannot work without; an unpack that lost any of them is refused.
runtime_files='scripts/vps-deploy.sh scripts/rollout-runtime.sh scripts/app-compose.sh scripts/lib/deploy-common.sh deploy/compose.app.yaml'
mirror=$runtimes/.mirror.git

process_token() {
  if [ ! -d "/proc/$$" ]; then
    printf '%s' -
    return 0
  fi
  stat_line=$(cat "/proc/$1/stat" 2>/dev/null || true)
  [ -n "$stat_line" ] || return 0
  printf '%s\n' "$stat_line" | awk '{ sub(/^.*\) /, ""); print $20 }'
}

prepare_mirror() {
  mkdir -p "$runtimes"
  # Left over by an unpack that was killed. The caller holds the runtimes lock, so no other
  # receiver is mid-unpack.
  rm -rf "$runtimes"/.incoming.* 2>/dev/null || true
  [ -d "$mirror" ] || git init -q --bare "$mirror" >&2
  # Re-aligned on every deploy, so a mirror created halfway (killed between init and remote add)
  # heals instead of failing every later deploy.
  git -C "$mirror" remote add origin "$runtime_url" >/dev/null 2>&1 ||
    git -C "$mirror" remote set-url origin "$runtime_url" >&2
}

fetch_main() {
  GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60 \
    git -C "$mirror" fetch -q --filter=blob:none origin '+refs/heads/main:refs/heads/main' >&2
}

with_timeout() {
  seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

# Unpacks <commit>'s deploy/ and scripts/ into ~/deploy-runtimes/<commit> if not already present,
# marks it verified from main, and prints the directory.
unpack_runtime() {
  commit=$1
  dir=$runtimes/$commit
  if [ ! -d "$dir" ]; then
    (
      incoming_runtime=$(mktemp -d "$runtimes/.incoming.XXXXXX")
      trap 'rm -rf "$incoming_runtime" "$incoming_runtime.tar"' EXIT
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
      # git's own exit status, not the tail of a pipe: a lazy blob fetch that dies halfway must not
      # leave a truncated runtime that still happens to contain vps-deploy.sh.
      if ! git -C "$mirror" archive -o "$incoming_runtime.tar" "$commit" deploy scripts >&2 ||
        ! tar -xf "$incoming_runtime.tar" -C "$incoming_runtime" >&2; then
        echo "Could not unpack the deployment runtime of $commit" >&2
        exit 1
      fi
      rm -f "$incoming_runtime.tar"
      for file in $runtime_files; do
        [ -f "$incoming_runtime/$file" ] || {
          echo "Deployment runtime of $commit lacks $file; refusing it" >&2
          exit 1
        }
      done
      [ -x "$incoming_runtime/scripts/vps-deploy.sh" ] || {
        echo "Deployment runtime of $commit has no executable scripts/vps-deploy.sh" >&2
        exit 1
      }
      # A symlink could make a checked path execute something outside the runtime.
      if [ -n "$(find "$incoming_runtime" -type l | head -n 1)" ]; then
        echo "Deployment runtime of $commit contains a symlink; refusing it" >&2
        exit 1
      fi
      printf '%s\n' "$commit" > "$incoming_runtime/.commit"
      mv "$incoming_runtime" "$dir"
    ) || return 1
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/.verified"
  # Pruning keeps the most recently used runtimes; using one counts.
  touch "$dir"
  printf '%s\n' "$dir"
}

# The public commit's deploy/ and scripts/, verified to be on main. Prints the runtime directory.
# The mirror holds commits only (blob:none); file contents are fetched when a runtime is unpacked.
paid_runtime() {
  printf '%s\n' "$release_commit" | grep -Eqx '[0-9a-f]{40}' || {
    echo "Release manifest names no public commit for $target; refusing to guess a runtime" >&2
    return 1
  }
  dir=$runtimes/$release_commit
  prepare_mirror
  # Main is fetched on every deploy so the ancestry check always sees the current branch. A host
  # that cannot reach GitHub may still redeploy a commit it verified before, never a new one.
  if ! fetch_main; then
    if [ -f "$dir/.verified" ]; then
      echo "Warning: could not fetch main from $runtime_url; using runtime $release_commit verified on $(cat "$dir/.verified")" >&2
      touch "$dir"
      printf '%s\n' "$dir"
      return 0
    fi
    echo "Cannot fetch main from $runtime_url to verify $release_commit; not deploying with an unverified runtime" >&2
    return 1
  fi
  git -C "$mirror" merge-base --is-ancestor "$release_commit" refs/heads/main 2>/dev/null || {
    echo "Refusing: $release_commit is not on main of $runtime_url" >&2
    return 1
  }
  unpack_runtime "$release_commit"
}

# test's branch can be pushed without review, so it never runs scripts from the test commit; it
# runs the latest deployment runtime on main. Drift is reported only when the test commit's own
# deploy/ or scripts/ trees differ from main's, not on every commit SHA difference.
test_runtime() {
  prepare_mirror
  if ! fetch_main; then
    for candidate in \
      "$runtimes/$(git -C "$mirror" rev-parse --verify refs/heads/main 2>/dev/null || echo none)" \
      "$(readlink "$runtimes/current-test" 2>/dev/null || true)" \
      "$(readlink "$runtimes/current-paid" 2>/dev/null || true)"
    do
      [ -n "$candidate" ] && [ -f "$candidate/.verified" ] || continue
      fallback_commit=$(cat "$candidate/.commit" 2>/dev/null || echo unknown)
      echo "Warning: could not fetch main from $runtime_url; using runtime $fallback_commit verified on $(cat "$candidate/.verified")" >&2
      touch "$candidate"
      printf '%s\n' "$candidate"
      return 0
    done
    echo "Cannot fetch main from $runtime_url to verify a runtime for test; not deploying with an unverified runtime" >&2
    return 1
  fi
  main_commit=$(git -C "$mirror" rev-parse refs/heads/main)
  dir=$(unpack_runtime "$main_commit") || return 1
  if printf '%s\n' "$release_commit" | grep -Eqx '[0-9a-f]{40}' &&
    [ "$release_commit" != "$main_commit" ]; then
    # mirror is a promisor repo (blob:none): without GIT_NO_LAZY_FETCH=1, cat-file and rev-parse
    # implicitly lazy-fetch missing commits/trees with no wall-clock bound.
    if ! GIT_NO_LAZY_FETCH=1 git -C "$mirror" cat-file -e "$release_commit^{tree}" 2>/dev/null; then
      # Diagnostic only: main's runtime is already unpacked, so cap this single commit/tree probe
      # tightly instead of stalling test or blocking paid under the shared runtimes lock.
      with_timeout 10 env GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=10 \
        git -C "$mirror" fetch -q --filter=blob:none --no-tags origin "$release_commit" >/dev/null 2>&1 || true
    fi
    if GIT_NO_LAZY_FETCH=1 git -C "$mirror" cat-file -e "$release_commit^{tree}" 2>/dev/null; then
      main_trees=$(GIT_NO_LAZY_FETCH=1 git -C "$mirror" rev-parse "$main_commit:deploy" "$main_commit:scripts" 2>/dev/null || echo missing-main)
      release_trees=$(GIT_NO_LAZY_FETCH=1 git -C "$mirror" rev-parse "$release_commit:deploy" "$release_commit:scripts" 2>/dev/null || echo missing-release)
      if [ "$main_trees" != "$release_trees" ]; then
        echo "Warning: test runs main's deployment runtime ($main_commit); deploy/ or scripts/ changes in $release_commit do not apply until merged to main" >&2
      fi
    else
      echo "Warning: test runs main's deployment runtime ($main_commit); could not inspect $release_commit for deploy/ or scripts/ changes" >&2
    fi
  fi
  printf '%s\n' "$dir"
}

# After a successful deploy: keep the runtimes current-paid and current-test point at and the five
# most recently used others. Housekeeping never decides whether a release ships.
prune_runtimes() {
  keep_paid=$(readlink "$runtimes/current-paid" 2>/dev/null || true)
  keep_test=$(readlink "$runtimes/current-test" 2>/dev/null || true)
  for candidate in "$runtimes"/*; do
    name=${candidate##*/}
    [ "${#name}" -eq 40 ] || continue
    case $name in *[!0-9a-f]*) continue ;; esac
    [ "$candidate" = "$keep_paid" ] && continue
    [ "$candidate" = "$keep_test" ] && continue
    mtime=$(stat -c %Y "$candidate" 2>/dev/null || stat -f %m "$candidate" 2>/dev/null || echo 0)
    printf '%s %s\n' "$mtime" "$candidate"
  done | sort -rn | tail -n +6 | while read -r _ old; do rm -rf "$old" || true; done
}

# One receiver at a time, from preparing the runtime through the deploy, the current-<target>
# pointer and pruning: the host deploy lock is only taken inside vps-deploy.sh and released before
# those last two steps. Busy means the same as a busy host lock (75): nothing changed, retry;
# recording `what=receive <target> ...` lets ci-ship-release.sh wait when the other environment's
# CI deploy holds this lock, while still failing at once on same-target contention.
#
# Acquire retries briefly so a contender arriving between a new holder's `flock` and its atomic
# `.lock.owner` rename (or just as an exiting holder releases fd 9) either wins the lock or reads
# a complete, live owner snapshot from memory without racing file removal under `set -e`.
acquire_runtimes_lock() {
  mkdir -p "$runtimes"
  exec 9>"$runtimes/.lock"
  attempt=0
  owner_snapshot=
  while :; do
    if flock -n 9; then
      owner_tmp="$runtimes/.lock.owner.tmp.$$"
      printf 'pid=%s\ntoken=%s\nwhat=receive %s %s\n' \
        "$$" "$(process_token "$$")" "$target" "$release" > "$owner_tmp" &&
        mv -f "$owner_tmp" "$runtimes/.lock.owner"
      return 0
    fi
    raw_owner=$(cat "$runtimes/.lock.owner" 2>/dev/null || true)
    owner_snapshot=
    if [ -n "$raw_owner" ]; then
      holder_pid=$(printf '%s\n' "$raw_owner" | awk -F= '$1 == "pid" { print $2; exit }')
      holder_what=$(printf '%s\n' "$raw_owner" | awk -F= '$1 == "what" { print substr($0, 6); exit }')
      if [ -n "$holder_pid" ] && [ -n "$holder_what" ] && kill -0 "$holder_pid" 2>/dev/null; then
        holder_token=$(printf '%s\n' "$raw_owner" | awk -F= '$1 == "token" { print $2; exit }')
        live_token=$(process_token "$holder_pid")
        if [ -n "$live_token" ] && { [ -z "$holder_token" ] || [ "$holder_token" = - ] ||
          [ "$live_token" = - ] || [ "$holder_token" = "$live_token" ]; }; then
          owner_snapshot=$raw_owner
          break
        fi
      fi
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 10 ] || break
    sleep 0.05
  done
  rm -rf "$release"
  echo "Deploy lock busy: another receiver holds $runtimes/.lock; release $release_id was not applied. Retry once it finishes." >&2
  if [ -n "$owner_snapshot" ]; then
    printf '%s\n' "$owner_snapshot" | sed 's/^/  /' >&2
  fi
  exit 75
}

acquire_runtimes_lock

if [ "$target" = paid ]; then
  runtime_root=$(paid_runtime) || {
    rm -rf "$release"
    exit 1
  }
else
  runtime_root=$(test_runtime) || {
    rm -rf "$release"
    exit 1
  }
fi
runtime="$runtime_root/scripts/vps-deploy.sh"
[ -x "$runtime" ] || {
  echo "Deployment runtime is not installed: $runtime" >&2
  rm -rf "$release"
  exit 1
}
runtime_commit=$(cat "$runtime_root/.commit" 2>/dev/null || echo unknown)
main_tip=$(git -C "$mirror" rev-parse --verify refs/heads/main 2>/dev/null || true)
if [ -n "$main_tip" ] && [ "$runtime_commit" = "$main_tip" ] &&
  [ -f "$runtime_root/scripts/ci-receive.sh" ] && [ -f "$receiver_path" ] &&
  ! cmp -s "$receiver_path" "$runtime_root/scripts/ci-receive.sh"; then
  echo "Warning: installed receiver $receiver_path differs from main ($main_tip) scripts/ci-receive.sh; back up and update ~/bin/aip-ci-receive" >&2
fi
echo "Deployment runtime: $runtime_root ($runtime_commit)" >&2
DEPLOY_ACTOR=github-actions/run-$run_id
export DEPLOY_ACTOR
set +e
# fd 9 (the runtimes lock) stays with this receiver; a long-lived child must not keep it held.
sh "$runtime" "$target" "$release" 9>&-
status=$?
set -e
if [ "$status" -eq 75 ]; then
  # vps-deploy.sh found the host deploy lock held and changed nothing (EX_TEMPFAIL). That is a
  # busy host, not a failed release: drop the unpacked directory so the same run can be retried.
  rm -rf "$release"
  echo "Deploy lock busy; release $release_id was not applied. Retry once the running deploy finishes." >&2
elif [ "$status" -eq 0 ]; then
  # Only a runtime that just deployed successfully becomes the one to use by hand or offline, and
  # pruning waits until then so a run of failed deploys can never remove a live runtime.
  ln -sfn "$runtime_root" "$runtimes/current-$target" || true
  (prune_runtimes) 2>/dev/null || true
elif [ "$status" -ne 0 ]; then
  # Keep the failed release for inspection, out of the way of a retry of the same commit.
  failed=$release.failed-run-$run_id
  rm -rf "$failed"
  mv "$release" "$failed" && echo "Failed release kept at $failed" >&2
fi
exit "$status"
