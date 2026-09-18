# Sourced by scripts/vps-deploy.sh and scripts/pages-release.sh. Not a program.
#
# append_deploy_log reads $public_sha and $private_sha from the caller, which sets both to a
# short commit or to `-`.

config_root=${XDG_CONFIG_HOME:-${HOME:?HOME must be set}/.config}/ai-image-playground
deployments_log=$config_root/deployments.log
# shellcheck disable=SC2034  # the sourcing script passes it to acquire/release_deploy_lock.
deploy_lock=$config_root/deploy.lock

# Private GHCR package the release images move through; GHCR requires the owner in lowercase.
ghcr_repository=ghcr.io/muluk-m/ai-image-playground
ghcr_user=Muluk-m

# ghcr_login <token-file>
#
# Reuses the credentials Docker already holds for ghcr.io (a CI login action, or an earlier
# login on this host) and only otherwise logs in with the token file. The token goes in through
# stdin, so it never appears in argv, the process list or the output.
ghcr_login() {
  if docker login "${ghcr_repository%%/*}" </dev/null >/dev/null 2>&1; then
    return 0
  fi
  if [ ! -r "$1" ]; then
    echo "Not logged in to ${ghcr_repository%%/*} and no readable token file at $1" >&2
    return 1
  fi
  docker login "${ghcr_repository%%/*}" -u "$ghcr_user" --password-stdin <"$1" >/dev/null
}

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

# release_was_deployed <release-directory>
#
# True when every application image the release carries is in the deploy log with result=ok, so
# `docker load` has consumed its archive long ago. A release still being copied in, or one that
# never went out, is not deployed and keeps its archive.
release_was_deployed() {
  [ -f "$1/images.tsv" ] && [ -f "$deployments_log" ] || return 1
  images=$(awk -F '\t' '$1 != "backup" { print $2 }' "$1/images.tsv")
  [ -n "$images" ] || return 1
  for image in $images; do
    grep -q " image=$image by=.* result=ok\$" "$deployments_log" || return 1
  done
}

# prune_old_releases <current-release-directory>
#
# Every release directory carries a ~1 GB image archive, and nothing else ever deletes it: a
# day of rollouts filled a fifth of the production disk. Once a release has gone out its images
# live in Docker (kept for rollback by prune_old_images), so its archive and any transport tar it
# arrived in are copies. The scripts stay: rollback runs from them. The current release keeps
# its archive so it can be rerun, and releases that never went out are left alone.
prune_old_releases() {
  releases_root=$(dirname -- "$1")
  for dir in "$releases_root"/*/; do
    dir=${dir%/}
    [ "$dir" != "$1" ] || continue
    [ -f "$dir/images.tar.gz" ] || continue
    release_was_deployed "$dir" || continue
    rm -f "$dir/images.tar.gz" && echo "removed the loaded image archive of $(basename -- "$dir")"
  done
  for tar in "$releases_root"/*.transport.tar; do
    [ -f "$tar" ] || continue
    dir=${tar%.transport.tar}
    [ "$dir" != "$1" ] || continue
    [ -d "$dir" ] && release_was_deployed "$dir" || continue
    rm -f "$tar" && echo "removed $(basename -- "$tar")"
  done
}

# deploy_process_token <pid>
#
# Prints something about a running process that a later process with the same PID would not
# reproduce, so a recycled PID cannot look like the original lock holder. On Linux that is field
# 22 of /proc/<pid>/stat, the start time in clock ticks. Where there is no /proc (macOS, and the
# workstation running the tests) it prints nothing and staleness falls back to `kill -0` alone:
# an unrelated process that inherited the PID then reads as a live holder and the rollout is
# refused, which is the safe direction. DEPLOY_PROC_ROOT exists so the tests can drive both paths.
deploy_process_token() {
  process_stat=${DEPLOY_PROC_ROOT:-/proc}/$1/stat
  [ -r "$process_stat" ] || return 0
  # The comm field is parenthesized and may contain spaces and parentheses; the greedy match
  # drops everything through the last ") ", after which $20 is field 22.
  awk '{ sub(/^.*\) /, ""); print $20 }' "$process_stat"
}

# deploy_lock_field <owner-file> <key> prints one `key=value` line's value, empty when absent.
deploy_lock_field() {
  [ -r "$1" ] || return 0
  awk -v key="$2=" 'index($0, key) == 1 { print substr($0, length(key) + 1); exit }' "$1"
}

# deploy_lock_holder_alive <lock-dir> succeeds while the process named in the owner file may still
# be running. An owner file that is missing or unreadable also counts as alive: the other process
# is between its mkdir and its write, and that is exactly a rollout starting.
deploy_lock_holder_alive() {
  holder_pid=$(deploy_lock_field "$1/owner" pid)
  case "$holder_pid" in
    '' | *[!0-9]*) return 0 ;;
  esac
  kill -0 "$holder_pid" 2>/dev/null || return 1
  holder_token=$(deploy_lock_field "$1/owner" token)
  live_token=$(deploy_process_token "$holder_pid")
  if [ -n "$holder_token" ] && [ "$holder_token" != '-' ] &&
    [ -n "$live_token" ] && [ "$holder_token" != "$live_token" ]; then
    return 1
  fi
  return 0
}

# acquire_deploy_lock <lock-dir> <description>
#
# Succeeds holding the lock, fails having printed the current holder. `mkdir` is the primitive:
# it is atomic, and flock(1) does not exist on macOS. A caller that cannot take the lock must
# stop rather than queue: a queued rollout would move production to another commit the moment
# the first one finished. A holder whose process is gone is taken over; there is deliberately no
# takeover based on how long the lock has been held, because a normal rollout runs for well over
# ten minutes and such a timer is itself a way to end up with two of them.
acquire_deploy_lock() {
  lock_dir=$1
  lock_what=$2
  mkdir -p "$(dirname -- "$lock_dir")"
  lock_attempt=0
  while [ "$lock_attempt" -lt 2 ]; do
    lock_attempt=$((lock_attempt + 1))
    if mkdir "$lock_dir" 2>/dev/null; then
      printf 'pid=%s\ntoken=%s\nsince=%s\nby=%s@%s\nwhat=%s\n' \
        "$$" "$(deploy_process_token "$$")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(whoami)" "$(hostname)" "$lock_what" >"$lock_dir/owner"
      return 0
    fi
    if deploy_lock_holder_alive "$lock_dir"; then
      echo "Refusing to start: another rollout holds $lock_dir." >&2
      if [ -r "$lock_dir/owner" ]; then
        sed 's/^/  /' "$lock_dir/owner" >&2
      else
        echo "  (no owner file yet: the other rollout is still taking the lock)" >&2
      fi
      echo "Wait for it to finish. If you are certain nothing is running, remove $lock_dir." >&2
      return 1
    fi
    echo "stale lock in $lock_dir: holder pid $(deploy_lock_field "$lock_dir/owner" pid) is gone, taking it over"
    rm -rf "$lock_dir"
  done
  echo "Refusing to start: lost the race for $lock_dir to another rollout." >&2
  return 1
}

# release_deploy_lock <lock-dir> removes the lock only when this process is the one holding it,
# so an exit trap can never delete the lock of the rollout that is actually running — including
# the trap of a rollout that just refused to start.
release_deploy_lock() {
  [ -d "$1" ] || return 0
  if [ "$(deploy_lock_field "$1/owner" pid)" = "$$" ]; then
    rm -rf "$1"
  fi
  return 0
}

# should_prune_build_cache <free-gb> <threshold-gb>
#
# Pruning is only worth doing while the disk is actually short. The threshold sits above
# DEPLOY_MIN_FREE_GB so that a pruned host still clears the pre-build check after the next build
# has written its layers.
should_prune_build_cache() {
  [ "$1" -lt "$2" ]
}

# docker_root_free_gb prints the whole gigabytes free on the filesystem holding Docker data.
docker_root_free_gb() {
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || printf '')
  [ -d "$docker_root" ] || docker_root=/var/lib/docker
  [ -d "$docker_root" ] || docker_root=/
  df -Pk "$docker_root" | awk 'NR == 2 { printf "%d", $4 / 1024 / 1024 }'
}
