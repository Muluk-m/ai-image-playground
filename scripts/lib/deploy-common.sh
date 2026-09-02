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
