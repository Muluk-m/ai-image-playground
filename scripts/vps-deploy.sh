#!/bin/sh
set -eu

# One entry point for a VPS rollout (README option 4): sync the checkout, refresh the private
# overlay, build, roll out, verify, record. Runs on the host, inside the repository checkout.
#
# scripts/app-compose.sh and scripts/infra-compose.sh stay the building blocks for anything this
# does not cover (rollback, stop, ad-hoc compose).

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_home=${XDG_CONFIG_HOME:-${HOME:?HOME must be set}/.config}
config_root=$config_home/ai-image-playground
deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
deployments_log=${DEPLOYMENTS_LOG:-$config_root/deployments.log}
private_token_file=${PRIVATE_REPO_TOKEN_FILE:-$config_root/secrets/private-repo-token}
private_root=$repo_root/private

usage() {
  cat >&2 <<'EOF'
Usage: scripts/vps-deploy.sh <internal|paid|all> [git-ref]

Deploys one or both editions on this host. The default git ref is origin/main.

Project names and image tags come from $XDG_CONFIG_HOME/ai-image-playground/deploy.env
(see deploy/deploy.env.example); every key there is optional.
EOF
  exit 2
}

target=${1:-}
ref=${2:-origin/main}
[ -n "$target" ] || usage
[ "$#" -le 2 ] || usage

case "$target" in
  internal) editions='internal' ;;
  paid) editions='paid' ;;
  all) editions='internal paid' ;;
  *) usage ;;
esac

if [ -f "$deploy_env" ]; then
  # shellcheck source=/dev/null
  . "$deploy_env"
fi
INTERNAL_PROJECT=${INTERNAL_PROJECT:-image-playground-internal}
INTERNAL_IMAGE=${INTERNAL_IMAGE:-ai-image-playground:vps-main}
PAID_PROJECT=${PAID_PROJECT:-image-playground-paid}
PAID_IMAGE=${PAID_IMAGE:-ai-image-playground:paid}

internal_tag=$INTERNAL_IMAGE
paid_tag=$PAID_IMAGE
public_sha=-
private_sha=-

stage() {
  printf '\n==> [%s/6] %s\n' "$1" "$2"
}

edition_project() {
  case "$1" in
    internal) printf '%s' "$INTERNAL_PROJECT" ;;
    *) printf '%s' "$PAID_PROJECT" ;;
  esac
}

edition_image() {
  case "$1" in
    internal) printf '%s' "$INTERNAL_IMAGE" ;;
    *) printf '%s' "$PAID_IMAGE" ;;
  esac
}

edition_tag() {
  case "$1" in
    internal) printf '%s' "$internal_tag" ;;
    *) printf '%s' "$paid_tag" ;;
  esac
}

set_edition_tag() {
  case "$1" in
    internal) internal_tag=$2 ;;
    *) paid_tag=$2 ;;
  esac
}

append_log() {
  mkdir -p "$(dirname -- "$deployments_log")"
  printf '%s %s public=%s private=%s image=%s by=%s@%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$public_sha" "$private_sha" \
    "$2" "$(whoami)" "$(hostname)" "$3" >>"$deployments_log"
}

pending=$editions
pop_pending() {
  case "$pending" in
    *' '*) pending=${pending#* } ;;
    *) pending= ;;
  esac
}

on_exit() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ]; then
    for failed_edition in $pending; do
      append_log "$failed_edition" "$(edition_tag "$failed_edition")" failed || true
    done
  fi
}
trap on_exit EXIT

update_private() {
  # The token never becomes a command-line argument: git expands $T inside the helper it runs.
  # The empty helper first clears any inherited one, so no cached credential is consulted.
  if [ -f "$private_token_file" ]; then
    T=$(cat "$private_token_file")
    export T
    # shellcheck disable=SC2016  # $T must reach git unexpanded; git's helper shell expands it.
    if git -C "$private_root" \
      -c 'credential.helper=' \
      -c 'credential.helper=!f(){ echo username=x-access-token; echo password=$T; }; f' \
      pull -q --ff-only; then
      unset T
      return 0
    fi
    unset T
    echo "Private overlay pull failed with the token in $private_token_file." >&2
    echo "Check that the token still has read access to the private repository." >&2
    exit 1
  fi

  if git -C "$private_root" pull -q --ff-only; then
    return 0
  fi
  echo "Private overlay pull failed and no token file exists at $private_token_file." >&2
  echo "Write a GitHub token with read access to the private repository there, then chmod 600 it." >&2
  exit 1
}

verify_project() {
  states=$(docker ps --all \
    --filter "label=com.docker.compose.project=$1" \
    --format '{{.Label "com.docker.compose.service"}} {{.State}} {{.Status}}')
  if [ -z "$states" ]; then
    echo "No containers belong to project $1." >&2
    exit 1
  fi

  # dependency-check and migrate are one-shots, so exited 0 is a pass; cloudflared declares no
  # healthcheck, so a plain running state is a pass too.
  offenders=$(printf '%s\n' "$states" | awk '
    {
      state = $2
      status = ""
      for (i = 3; i <= NF; i++) status = status (i > 3 ? " " : "") $i
    }
    state == "running" && status !~ /\(unhealthy\)/ && status !~ /\(health: starting\)/ { next }
    state == "exited" && status ~ /^Exited \(0\)/ { next }
    { print }
  ')
  if [ -n "$offenders" ]; then
    echo "Project $1 is not ready:" >&2
    printf '%s\n' "$offenders" >&2
    "$repo_root/scripts/app-compose.sh" status "$1" >&2 || true
    exit 1
  fi

  service_count=$(printf '%s\n' "$states" | wc -l | tr -d ' ')
  echo "$service_count services healthy or exited 0."
}

stage 1 "Sync the checkout to $ref"
if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to deploy: tracked files are modified in $repo_root." >&2
  git -C "$repo_root" status --short --untracked-files=no >&2
  exit 1
fi
git -C "$repo_root" fetch -q origin
git -C "$repo_root" checkout -q --detach "$ref"
public_sha=$(git -C "$repo_root" rev-parse --short HEAD)
echo "public $public_sha  $(git -C "$repo_root" log -1 --pretty=%s)"

stage 2 "Refresh the private overlay"
case "$target" in
  internal)
    echo "Skipped: the internal edition builds without ./private."
    ;;
  *)
    if [ ! -d "$private_root/.git" ]; then
      echo "No private overlay clone at $private_root; the paid edition needs one." >&2
      echo "Clone the private repository there over HTTPS first." >&2
      exit 1
    fi
    update_private
    private_sha=$(git -C "$private_root" rev-parse --short HEAD)
    echo "private $private_sha  $(git -C "$private_root" log -1 --pretty=%s)"
    ;;
esac

stage 3 "Build the images"
for edition in $editions; do
  image=$(edition_image "$edition")
  case "$edition" in
    internal)
      tag="$image-$public_sha"
      "$repo_root/scripts/app-compose.sh" build "$image"
      ;;
    *)
      tag="$image-$public_sha-$private_sha"
      "$repo_root/scripts/app-compose.sh" build-private "$image"
      ;;
  esac
  # The commit-qualified tag is what `app-compose.sh rollback` rolls back to later.
  docker tag "$image" "$tag"
  set_edition_tag "$edition" "$tag"
  echo "built $image, tagged $tag"
done

for edition in $editions; do
  project=$(edition_project "$edition")
  tag=$(edition_tag "$edition")

  stage 4 "Roll out $project with $tag"
  APP_IMAGE=$tag
  export APP_IMAGE
  "$repo_root/scripts/app-compose.sh" up "$project"

  stage 5 "Verify $project"
  verify_project "$project"

  stage 6 "Record the deployment"
  append_log "$edition" "$tag" ok
  echo "appended to $deployments_log"
  pop_pending
done

printf '\nDeployed public=%s private=%s\n' "$public_sha" "$private_sha"
for edition in $editions; do
  printf '  %-8s %s -> %s\n' "$edition" "$(edition_tag "$edition")" "$(edition_project "$edition")"
done
