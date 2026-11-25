#!/bin/sh
set -eu
# Manual VPS disk cleanup entrypoint. Holds the shared host deploy lock (`deploy.lock`) so manual
# cleanup never races a concurrent paid/test CI rollout and deletes a freshly pulled image before
# its containers start. Exits 75 without changing anything if a rollout holds the lock.
#
# Usage:
#   scripts/vps-reclaim-disk.sh [keep]
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"

keep=${1:-}
case "$keep" in
  ''|*[!0-9]*)
    if [ -n "$keep" ]; then
      echo "Usage: $0 [keep]" >&2
      exit 2
    fi ;;
esac

deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
# shellcheck source=/dev/null
[ ! -f "$deploy_env" ] || . "$deploy_env"

cleanup() {
  release_deploy_lock "$deploy_lock"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_host_deploy_lock "reclaim-disk" || exit $?
before_gb=$(docker_root_free_gb)
echo "Docker disk free before cleanup: ${before_gb}G"
if [ -x "$repo_root/scripts/segmenter-deploy.sh" ]; then
  SEGMENTER_PREV_RETENTION_SECONDS="${SEGMENTER_PREV_RETENTION_SECONDS:-}" \
    "$repo_root/scripts/segmenter-deploy.sh" prune || true
fi
releases_root=${RELEASES_ROOT:-${HOME:?HOME must be set}/releases}
reclaim_deploy_disk "$releases_root/.none" "" "$keep"
after_gb=$(docker_root_free_gb)
echo "Docker disk free after cleanup: ${after_gb}G"
