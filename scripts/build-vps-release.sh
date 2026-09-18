#!/bin/sh
set -eu
# Run on a GitHub Actions runner or, as the manual fallback, on macmini2. Export committed inputs
# so another checkout cannot change this build.
#
# RELEASE_TRANSPORT=registry (default) pushes each image to GHCR and records its digest in
# images.tsv; the VPS pulls by digest. RELEASE_TRANSPORT=archive instead writes images.tar.gz
# into the release, for when GHCR is unavailable.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"
if [ "$(uname -s)" != Darwin ] && [ "${GITHUB_ACTIONS:-}" != true ]; then
  echo "Build in GitHub Actions or on macmini2; production VPS must only receive images." >&2
  exit 1
fi
target=${1:-}
case "$target" in internal) editions=internal ;; paid) editions=paid ;; all) editions='internal paid' ;; *) echo "Usage: $0 internal|paid|all /absolute/output-directory" >&2; exit 2 ;; esac
transport=${RELEASE_TRANSPORT:-registry}
case "$transport" in registry|archive) ;; *) echo "RELEASE_TRANSPORT must be registry or archive, not $transport" >&2; exit 2 ;; esac
output=${2:?An unused absolute output directory is required}
case "$output" in /*) ;; *) exit 2 ;; esac
[ ! -e "$output" ] || { echo "Output already exists: $output" >&2; exit 1; }
[ -z "$(git -C "$repo_root" status --porcelain --untracked-files=no)" ] || { echo "Commit tracked source changes before building." >&2; exit 1; }
public_sha=$(git -C "$repo_root" rev-parse HEAD)
private_sha=-
case "$target" in paid|all)
  [ -z "$(git -C "$repo_root/private" status --porcelain --untracked-files=no)" ] || { echo "Commit private source changes before building." >&2; exit 1; }
  private_sha=$(git -C "$repo_root/private" rev-parse HEAD)
;; esac
build_lock=$config_root/image-build.lock
snapshot=
cleanup() {
  [ -z "$snapshot" ] || rm -rf "$snapshot"
  release_deploy_lock "$build_lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
acquire_deploy_lock "$build_lock" "images $target $public_sha $private_sha"
# Fail on missing registry credentials now rather than after the builds.
[ "$transport" = archive ] || ghcr_login "${GHCR_PUSH_TOKEN_FILE:-$config_root/ghcr-push-token}"
snapshot=$(mktemp -d)
mkdir "$snapshot/public" "$snapshot/private"
git -C "$repo_root" archive "$public_sha" > "$snapshot/public.tar"
tar -xf "$snapshot/public.tar" -C "$snapshot/public"
if [ "$private_sha" != - ]; then
  git -C "$repo_root/private" archive "$private_sha" > "$snapshot/private.tar"
  tar -xf "$snapshot/private.tar" -C "$snapshot/private"
fi
# A dedicated builder limits both the whole compiler budget and concurrent Dockerfile stages.
builder=aip-release
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container \
    --driver-opt memory=6g,memory-swap=6g,cpu-quota=400000 \
    --buildkitd-config "$snapshot/public/deploy/buildkitd.toml"
fi
docker buildx inspect "$builder" --bootstrap >/dev/null
limits=$(docker inspect buildx_buildkit_aip-release0 --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.CpuQuota}}')
[ "$limits" = '6442450944 6442450944 400000' ] || { echo "Unexpected release builder resource limits: $limits" >&2; exit 1; }
# push_image <local-image> <registry-tag> pushes the image to GHCR and sets $repo_digest to the
# digest reference the VPS pulls. In archive transport it only sets $repo_digest to `-`.
push_image() {
  repo_digest=-
  [ "$transport" = registry ] || return 0
  remote=$ghcr_repository:$2
  docker tag "$1" "$remote"
  if ! docker push "$remote" >"$snapshot/push.log"; then
    cat "$snapshot/push.log"
    echo "Push failed: $remote" >&2
    exit 1
  fi
  cat "$snapshot/push.log"
  pushed=$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' "$snapshot/push.log" | tail -n 1)
  [ -n "$pushed" ] || { echo "No digest in the push output for $remote" >&2; exit 1; }
  repo_digest=$ghcr_repository@$pushed
  # Only the local tag names the image from here on; untagging leaves the image itself in place.
  docker rmi "$remote" >/dev/null || true
}
mkdir -p "$output/scripts/lib" "$output/deploy"
cp "$snapshot/public/scripts/vps-deploy.sh" "$snapshot/public/scripts/app-compose.sh" \
  "$snapshot/public/scripts/rollout-runtime.sh" "$output/scripts/"
cp "$snapshot/public/scripts/lib/deploy-common.sh" "$output/scripts/lib/"
cp "$snapshot/public/deploy/compose.app.yaml" "$output/deploy/"
: > "$output/images.tsv"
images=
for edition in $editions; do
  version=$public_sha
  image=ai-image-playground:vps-main-$(printf %.12s "$public_sha")
  registry_tag=internal-$(printf %.12s "$public_sha")
  set --
  if [ "$edition" = paid ]; then
    version=$public_sha+$private_sha
    image=ai-image-playground:paid-$(printf %.12s "$public_sha")-$(printf %.12s "$private_sha")
    registry_tag=paid-$(printf %.12s "$public_sha")-$(printf %.12s "$private_sha")
    set -- --build-context "private-overlay=$snapshot/private" --build-arg PRIVATE_OVERLAY_PRESENT=true
  fi
  docker buildx build --builder "$builder" --platform linux/amd64 --load \
    --build-arg "APP_VERSION=$version" --tag "$image" "$@" "$snapshot/public"
  image_id=$(docker image inspect "$image" --format '{{.Id}}')
  push_image "$image" "$registry_tag"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$edition" "$image" "$image_id" "$public_sha" "$private_sha" \
    "$repo_digest" >> "$output/images.tsv"
  images="$images $image"
done
# The backup sidecar is also prebuilt; production Compose has no build context.
backup_image=ai-image-playground:backup-$(printf %.12s "$public_sha")
docker buildx build --builder "$builder" --platform linux/amd64 --load \
  --build-arg "APP_VERSION=$public_sha" --tag "$backup_image" "$snapshot/public/deploy/backup"
backup_id=$(docker image inspect "$backup_image" --format '{{.Id}}')
push_image "$backup_image" "backup-$(printf %.12s "$public_sha")"
printf 'backup\t%s\t%s\t%s\t-\t%s\n' "$backup_image" "$backup_id" "$public_sha" "$repo_digest" >> "$output/images.tsv"
images="$images $backup_image"
if [ "$transport" = archive ]; then
  # Separate commands preserve save failures (a shell pipeline would only report gzip's status).
  # shellcheck disable=SC2086
  docker save -o "$output/images.tar" $images
  gzip "$output/images.tar"
fi
# Every file in the release, so the receiver can also refuse anything unlisted.
(cd "$output" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256 > "$snapshot/SHA256SUMS")
mv "$snapshot/SHA256SUMS" "$output/SHA256SUMS"
echo "Release ready ($transport): $output (copy to VPS, then run scripts/vps-deploy.sh $target $output)"
