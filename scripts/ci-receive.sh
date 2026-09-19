#!/bin/sh
set -eu
# SSH forced command for the GitHub Actions deploy key on the production VPS. Installed as
# ~/bin/aip-ci-receive and bound to the key in ~/.ssh/authorized_keys:
#
#   command="/home/ubuntu/bin/aip-ci-receive",restrict ssh-ed25519 AAAA… github-actions-deploy
#
# The only accepted command is `deploy <release-id> <internal|paid|all> <run-id>`, with the
# release directory as a gzipped tar on stdin (`tar -C "$out" -czf - .`). It unpacks into
# ~/releases/<release-id>, which must not exist yet, and runs that release's vps-deploy.sh.
# Anything else is refused before a file is written.

reject() {
  echo "Rejected: expected 'deploy <aip-<12 hex>-<12 hex>> <internal|paid|all> <run-id>'" >&2
  exit 2
}

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
case "$target" in internal | paid | all) ;; *) reject ;; esac
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

# Only plain files and directories, named ./<safe components>: no absolute paths, no `..`,
# no hidden components, no links or devices.
tar -tzf "$incoming/release.tgz" >"$incoming/names" || { echo "Unreadable release archive" >&2; exit 1; }
tar -tvzf "$incoming/release.tgz" >"$incoming/listing"
if grep -Evx '\./|(\./)?[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*/?' "$incoming/names" >/dev/null ||
  grep -Ev '^[-d]' "$incoming/listing" >/dev/null; then
  echo "Unsafe archive: only relative plain files and directories are accepted" >&2
  exit 1
fi

mkdir "$release"
created=1
tar -xzf "$incoming/release.tgz" -C "$release"
[ -f "$release/scripts/vps-deploy.sh" ] || { echo "Release has no scripts/vps-deploy.sh" >&2; exit 1; }
created=

DEPLOY_ACTOR=github-actions/run-$run_id
export DEPLOY_ACTOR
set +e
sh "$release/scripts/vps-deploy.sh" "$target" "$release"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  # Keep the failed release for inspection, out of the way of a retry of the same commit.
  failed=$release.failed-run-$run_id
  rm -rf "$failed"
  mv "$release" "$failed" && echo "Failed release kept at $failed" >&2
fi
exit "$status"
