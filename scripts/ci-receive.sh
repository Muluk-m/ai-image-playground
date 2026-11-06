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

# Only release data is accepted. The deployment runtime is installed out of band at this path;
# it is not read from the uploaded archive and therefore cannot be replaced by a caller.
runtime_root=${AIP_DEPLOY_RUNTIME_ROOT:-$HOME/deploy-runtime}
runtime="$runtime_root/scripts/vps-deploy.sh"
[ -x "$runtime" ] || {
  echo "Deployment runtime is not installed: $runtime" >&2
  rm -rf "$release"
  exit 1
}
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
