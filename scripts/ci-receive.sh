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
# ~/deploy-runtimes/<sha>. So a merged change to the deployment scripts takes effect with its own
# release instead of waiting for someone to copy files to the server. test, whose branch is pushed
# without review, keeps the fixed ~/deploy-runtime and only gets a warning when that lags behind.
#
# The only accepted command is `deploy <release-id> <target> <run-id>`, with the release data as a
# gzipped tar on stdin (`tar -C "$out" -czf - .`). It unpacks into `~/releases/<release-id>`,
# which must not exist yet, and invokes the server-installed runtime.
# Anything else is refused before a file is written.

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
cleanup() {
  status=$?
  rm -rf "$incoming"
  # A release that never reached its receiver is removed so the run can simply be retried.
  if [ "$status" -ne 0 ] && [ -n "$created" ]; then rm -rf "$release"; fi
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

# The public commit's deploy/ and scripts/, verified to be on main. Prints the runtime directory.
# The mirror holds commits only (blob:none); file contents are fetched when a runtime is unpacked.
paid_runtime() {
  printf '%s\n' "$release_commit" | grep -Eqx '[0-9a-f]{40}' || {
    echo "Release manifest names no public commit for $target; refusing to guess a runtime" >&2
    return 1
  }
  runtimes=${AIP_DEPLOY_RUNTIMES_ROOT:-$HOME/deploy-runtimes}
  mirror=$runtimes/.mirror.git
  dir=$runtimes/$release_commit
  url=${AIP_RUNTIME_GIT_URL:-https://github.com/Muluk-m/ai-image-playground.git}
  mkdir -p "$runtimes"
  if [ ! -d "$mirror" ]; then
    git init -q --bare "$mirror"
    git -C "$mirror" remote add origin "$url"
  fi
  git -C "$mirror" remote set-url origin "$url"
  # Main is fetched on every deploy so the ancestry check always sees the current branch. A host
  # that cannot reach GitHub may still redeploy a commit it verified before, never a new one.
  if ! GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60 \
    git -C "$mirror" fetch -q --filter=blob:none origin '+refs/heads/main:refs/heads/main' >&2; then
    if [ -f "$dir/.verified" ]; then
      echo "Warning: could not fetch main from $url; using runtime $release_commit verified on $(cat "$dir/.verified")" >&2
      printf '%s\n' "$dir"
      return 0
    fi
    echo "Cannot fetch main from $url to verify $release_commit; not deploying with an unverified runtime" >&2
    return 1
  fi
  git -C "$mirror" merge-base --is-ancestor "$release_commit" refs/heads/main 2>/dev/null || {
    echo "Refusing: $release_commit is not on main of $url" >&2
    return 1
  }
  if [ ! -d "$dir" ]; then
    incoming_runtime=$(mktemp -d "$runtimes/.incoming.XXXXXX")
    if ! git -C "$mirror" archive "$release_commit" deploy scripts | tar -x -C "$incoming_runtime" ||
      [ ! -x "$incoming_runtime/scripts/vps-deploy.sh" ]; then
      rm -rf "$incoming_runtime"
      echo "Could not unpack the deployment runtime of $release_commit" >&2
      return 1
    fi
    printf '%s\n' "$release_commit" > "$incoming_runtime/.commit"
    mv "$incoming_runtime" "$dir"
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "$dir/.verified"
  # For hands-on work: the runtime the last paid deploy used.
  ln -sfn "$dir" "$runtimes/current-paid"
  # Keep the five most recent runtimes besides the one in use; a rollback to an older commit
  # unpacks it again.
  ls -1dt "$runtimes"/[0-9a-f]* 2>/dev/null | grep -v "/$release_commit\$" | tail -n +6 |
    while IFS= read -r old; do rm -rf "$old"; done
  printf '%s\n' "$dir"
}

if [ "$target" = paid ]; then
  runtime_root=$(paid_runtime) || {
    rm -rf "$release"
    exit 1
  }
else
  # Only release data is accepted. test's runtime is installed out of band at this path; it is not
  # read from the uploaded archive and therefore cannot be replaced by a caller.
  runtime_root=${AIP_DEPLOY_RUNTIME_ROOT:-$HOME/deploy-runtime}
  installed=$(cat "$runtime_root/.commit" 2>/dev/null || echo unknown)
  if [ -n "$release_commit" ] && [ "$installed" != "$release_commit" ]; then
    echo "Warning: $runtime_root is at $installed, this release is $release_commit; deployment scripts changed since may not apply to $target" >&2
  fi
fi
runtime="$runtime_root/scripts/vps-deploy.sh"
[ -x "$runtime" ] || {
  echo "Deployment runtime is not installed: $runtime" >&2
  rm -rf "$release"
  exit 1
}
echo "Deployment runtime: $runtime_root ($(cat "$runtime_root/.commit" 2>/dev/null || echo unknown))" >&2
DEPLOY_ACTOR=github-actions/run-$run_id
export DEPLOY_ACTOR
set +e
sh "$runtime" "$target" "$release"
status=$?
set -e
if [ "$status" -eq 75 ]; then
  # vps-deploy.sh found the host deploy lock held and changed nothing (EX_TEMPFAIL). That is a
  # busy host, not a failed release: drop the unpacked directory so the same run can be retried.
  rm -rf "$release"
  echo "Deploy lock busy; release $release_id was not applied. Retry once the running deploy finishes." >&2
elif [ "$status" -ne 0 ]; then
  # Keep the failed release for inspection, out of the way of a retry of the same commit.
  failed=$release.failed-run-$run_id
  rm -rf "$failed"
  mv "$release" "$failed" && echo "Failed release kept at $failed" >&2
fi
exit "$status"
