# Sourced by scripts/vps-deploy.sh and scripts/pages-release.sh. Not a program.
#
# append_deploy_log reads $public_sha and $private_sha from the caller, which sets both to a
# short commit or to `-`.

config_root=${XDG_CONFIG_HOME:-${HOME:?HOME must be set}/.config}/ai-image-playground
deployments_log=$config_root/deployments.log

# append_deploy_log <name> <image-or-version> <ok|failed>
# shellcheck disable=SC2154  # public_sha and private_sha belong to the sourcing script.
append_deploy_log() {
  mkdir -p "$config_root"
  printf '%s %s public=%s private=%s image=%s by=%s@%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$public_sha" "$private_sha" "$2" \
    "$(whoami)" "$(hostname)" "$3" >>"$deployments_log"
}

# edition_var <PREFIX> <KEY> reads $<PREFIX>_<KEY>, empty when unset.
edition_var() {
  eval "printf '%s' \"\${$1_$2:-}\""
}

stage() {
  printf '\n==> %s\n' "$1"
}

# select_stale_images <moving-alias> <keep> <protected-tags>
#
# Reads one edition's image references on stdin, newest first, and prints the ones to delete.
# Only commit-qualified tags are candidates (<alias>-<sha> or <alias>-<sha>-<sha>): the moving
# alias itself and hand-named images such as <alias>-relay-removal are never touched. A
# protected tag (the one just rolled out, or one a container still runs) is kept without using
# up one of the <keep> slots, so a rollback target never disappears because of it.
select_stale_images() {
  awk -v alias="$1" -v keep="$2" -v protected="$3" '
    BEGIN {
      n = split(protected, list, " ")
      for (i = 1; i <= n; i++) guard[list[i]] = 1
      prefix = alias "-"
    }
    {
      if (index($0, prefix) != 1) next
      suffix = substr($0, length(prefix) + 1)
      if (suffix !~ /^[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+(-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]+)?$/) next
      if ($0 in guard) next
      kept++
      if (kept > keep) print $0
    }
  '
}

# docker_root_free_gb prints the whole gigabytes free on the filesystem holding Docker data.
docker_root_free_gb() {
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || printf '')
  [ -d "$docker_root" ] || docker_root=/var/lib/docker
  [ -d "$docker_root" ] || docker_root=/
  df -Pk "$docker_root" | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }'
}

# acquire_deploy_lock <lock-dir> <what>
#
# One rollout at a time on this host. Two overlapping `vps-deploy.sh all` runs build four images
# next to PostgreSQL, both backends and cloudflared, and that took the host down (SSH and the
# tunnel stopped answering, the API returned 530). The second caller is refused, never queued:
# a queue would start the next build the moment this one ends, which is the same pile-up.
#
# `mkdir` is the atomic step and works in plain sh on Linux and macOS alike (flock is util-linux
# only). A lock whose holder is gone is reclaimed; a lock with no pid yet is a holder still
# starting up, and is only considered abandoned once it is older than a minute.
acquire_deploy_lock() {
  deploy_lock_dir=$1
  mkdir -p "$(dirname "$deploy_lock_dir")"
  if ! mkdir "$deploy_lock_dir" 2>/dev/null; then
    holder=$(cat "$deploy_lock_dir/pid" 2>/dev/null || printf '')
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "Refusing to deploy: another deploy is running on this host." >&2
      sed 's/^/  /' "$deploy_lock_dir/info" >&2 2>/dev/null || true
      echo "Wait for it to finish; do not start a second build next to it." >&2
      return 1
    fi
    if [ -z "$holder" ] && [ -z "$(find "$deploy_lock_dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      echo "Refusing to deploy: another deploy is starting on this host." >&2
      return 1
    fi
    echo "Reclaiming a deploy lock left behind by pid ${holder:-unknown}, which is gone." >&2
    rm -rf "$deploy_lock_dir"
    if ! mkdir "$deploy_lock_dir" 2>/dev/null; then
      echo "Refusing to deploy: another deploy took the lock first." >&2
      return 1
    fi
  fi
  printf '%s\n' "$$" >"$deploy_lock_dir/pid"
  printf 'pid=%s started=%s by=%s@%s what=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$(whoami)" "$(hostname)" "$2" >"$deploy_lock_dir/info"
}

# release_deploy_lock removes the lock only if this process holds it, so a refused second caller
# cannot delete the first one's lock on its way out.
release_deploy_lock() {
  [ -n "${deploy_lock_dir:-}" ] || return 0
  if [ "$(cat "$deploy_lock_dir/pid" 2>/dev/null || printf '')" = "$$" ]; then
    rm -rf "$deploy_lock_dir"
  fi
}

# available_memory_mb prints MemAvailable in whole megabytes, or nothing where /proc/meminfo is
# missing (macOS): the caller then skips the check rather than guessing.
available_memory_mb() {
  meminfo=${DEPLOY_MEMINFO_FILE:-/proc/meminfo}
  [ -r "$meminfo" ] || return 0
  awk '$1 == "MemAvailable:" { printf "%d", $2 / 1024 }' "$meminfo"
}
