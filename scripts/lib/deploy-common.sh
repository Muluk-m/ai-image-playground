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
