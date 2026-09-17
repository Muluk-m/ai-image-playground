#!/bin/sh
set -eu

# One entry point for a VPS rollout (README option 4): sync the checkout, refresh the private
# overlay, build, roll out, record. Runs on the host, inside the repository checkout.

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"

deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
private_token_file=$config_root/secrets/private-repo-token
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
DEPLOY_KEEP_IMAGES=${DEPLOY_KEEP_IMAGES:-5}
DEPLOY_MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-8}

public_sha=-
private_sha=-
current_edition=

edition_tag() {
  case "$1" in
    internal) printf '%s-%s' "$INTERNAL_IMAGE" "$public_sha" ;;
    *) printf '%s-%s-%s' "$PAID_IMAGE" "$public_sha" "$private_sha" ;;
  esac
}

on_exit() {
  if [ "$?" -ne 0 ] && [ -n "$current_edition" ]; then
    append_deploy_log "$current_edition" "$(edition_tag "$current_edition")" failed || true
  fi
}
trap on_exit EXIT

update_private() {
  set --
  if [ -f "$private_token_file" ]; then
    private_remote=$(git -C "$private_root" remote get-url origin)
    case "$private_remote" in
      https://github.com/*) ;;
      *)
        echo "Refusing to send the token in $private_token_file to $private_remote." >&2
        echo "The overlay origin must be an https://github.com/ remote." >&2
        exit 1
        ;;
    esac
    T=$(cat "$private_token_file")
    export T
    # The token must never become a command-line argument; git's helper shell expands $T.
    # shellcheck disable=SC2016
    set -- -c 'credential.helper=' \
      -c 'credential.helper=!f(){ echo username=x-access-token; echo password=$T; }; f'
  fi
  if ! git -C "$private_root" "$@" pull -q --ff-only; then
    unset T
    echo "Fast-forwarding $private_root failed." >&2
    echo "Put a GitHub token with read access to the private repository in $private_token_file, then chmod 600 it." >&2
    exit 1
  fi
  unset T
}

# prune_old_images <moving-alias> <tag-just-rolled-out>
#
# Every deploy leaves a commit-qualified image behind as a rollback target, and nothing used to
# remove them: the host filled up. Keep the newest $DEPLOY_KEEP_IMAGES per edition, plus whatever
# is still running. A failed removal is reported and ignored; the rollout already succeeded.
prune_old_images() {
  running=$(docker ps --format '{{.Image}}' | sort -u | tr '\n' ' ')
  stale=$(docker images --format '{{.Repository}}:{{.Tag}}' "${1%%:*}" |
    select_stale_images "$1" "$DEPLOY_KEEP_IMAGES" "$2 $running")
  if [ -z "$stale" ]; then
    echo "no images to prune for $1 (keeping $DEPLOY_KEEP_IMAGES)"
    return 0
  fi
  for image in $stale; do
    if docker rmi "$image" >/dev/null 2>&1; then
      echo "pruned $image"
    else
      echo "could not prune $image; leaving it" >&2
    fi
  done
}

# Image pruning alone does not keep the disk in check: BuildKit keeps every superseded layer in
# its cache, and that is what actually fills the host (27G of cache next to 4G of images, 17G of
# it referenced by nothing). Drop only the unreferenced part; the cache the next build reuses
# stays. A failure here is reported and ignored: the rollout already succeeded.
prune_build_cache() {
  if reclaimed=$(docker builder prune -f 2>/dev/null | tail -n 1); then
    echo "build cache: ${reclaimed:-nothing to reclaim}"
  else
    echo "could not prune the build cache; leaving it" >&2
  fi
}

stage "Sync the checkout to $ref"
if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to deploy: tracked files are modified in $repo_root." >&2
  git -C "$repo_root" status --short --untracked-files=no >&2
  exit 1
fi
git -C "$repo_root" fetch -q origin
git -C "$repo_root" checkout -q --detach "$ref"
public_sha=$(git -C "$repo_root" rev-parse --short HEAD)
echo "public $public_sha  $(git -C "$repo_root" log -1 --pretty=%s)"

stage "Refresh the private overlay"
case "$editions" in
  *paid*)
    if [ ! -d "$private_root/.git" ]; then
      echo "No private overlay clone at $private_root; the paid edition needs one." >&2
      echo "Clone the private repository there over HTTPS first." >&2
      exit 1
    fi
    update_private
    private_sha=$(git -C "$private_root" rev-parse --short HEAD)
    echo "private $private_sha  $(git -C "$private_root" log -1 --pretty=%s)"
    ;;
  *)
    echo "Skipped: the internal edition builds without ./private."
    ;;
esac

# A build that fills the disk takes PostgreSQL down with it: both share this filesystem. Refuse
# while there is still room to recover, instead of finding out halfway through a layer export.
stage "Check free space for the build"
free_gb=$(docker_root_free_gb)
echo "${free_gb}G free, ${DEPLOY_MIN_FREE_GB}G required"
if [ "$free_gb" -lt "$DEPLOY_MIN_FREE_GB" ]; then
  echo "Refusing to build: less than ${DEPLOY_MIN_FREE_GB}G free where Docker keeps its data." >&2
  echo "Old commit-qualified images are the usual cause. List them with" >&2
  echo "  docker images 'ai-image-playground'" >&2
  echo "remove the ones no rollback needs, then deploy again. DEPLOY_MIN_FREE_GB in" >&2
  echo "$deploy_env overrides the threshold." >&2
  exit 1
fi

stage "Build the images"
for edition in $editions; do
  prefix=$(printf '%s' "$edition" | tr '[:lower:]' '[:upper:]')
  tag=$(edition_tag "$edition")
  current_edition=$edition
  # Baked into the image and reported in each service's heartbeat. Same shape as the frontend's
  # version.json: <public sha>, or <public sha>+<private sha> for the paid edition.
  case "$edition" in
    internal)
      APP_VERSION=$public_sha "$repo_root/scripts/app-compose.sh" build "$tag"
      ;;
    *)
      paid_version=$public_sha
      [ "$private_sha" = "-" ] || paid_version="$public_sha+$private_sha"
      APP_VERSION=$paid_version "$repo_root/scripts/app-compose.sh" build-private "$tag"
      ;;
  esac
  moving_alias=$(edition_var "$prefix" IMAGE)
  docker tag "$tag" "$moving_alias"
  echo "built $tag, aliased to $moving_alias"
  current_edition=
done

for edition in $editions; do
  prefix=$(printf '%s' "$edition" | tr '[:lower:]' '[:upper:]')
  project=$(edition_var "$prefix" PROJECT)
  tag=$(edition_tag "$edition")
  current_edition=$edition

  stage "Roll out $project with $tag"
  APP_IMAGE=$tag
  export APP_IMAGE
  if ! "$repo_root/scripts/app-compose.sh" up "$project"; then
    "$repo_root/scripts/app-compose.sh" status "$project" >&2 || true
    exit 1
  fi
  append_deploy_log "$edition" "$tag" ok
  current_edition=
  echo "recorded in $deployments_log"
  prune_old_images "$(edition_var "$prefix" IMAGE)" "$tag"
done

stage "Prune the unreferenced build cache"
prune_build_cache

printf '\nDeployed public=%s private=%s\n' "$public_sha" "$private_sha"
for edition in $editions; do
  prefix=$(printf '%s' "$edition" | tr '[:lower:]' '[:upper:]')
  printf '  %-8s %s -> %s\n' "$edition" "$(edition_tag "$edition")" "$(edition_var "$prefix" PROJECT)"
done
