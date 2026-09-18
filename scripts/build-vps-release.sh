#!/bin/sh
set -eu
# Run on macmini2. Export committed inputs so another checkout cannot change this build.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"
[ "$(uname -s)" = Darwin ] || { echo "Build on macmini2; production VPS must only receive images." >&2; exit 1; }
target=${1:-}
case "$target" in internal) editions=internal ;; paid) editions=paid ;; all) editions='internal paid' ;; *) echo "Usage: $0 internal|paid|all /absolute/output-directory" >&2; exit 2 ;; esac
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
mkdir -p "$output/scripts/lib" "$output/deploy"
cp "$snapshot/public/scripts/vps-deploy.sh" "$snapshot/public/scripts/app-compose.sh" "$output/scripts/"
cp "$snapshot/public/scripts/lib/deploy-common.sh" "$output/scripts/lib/"
cp "$snapshot/public/deploy/compose.app.yaml" "$output/deploy/"
: > "$output/images.tsv"
images=
for edition in $editions; do
  version=$public_sha
  image=ai-image-playground:vps-main-$(printf %.12s "$public_sha")
  set --
  if [ "$edition" = paid ]; then
    version=$public_sha+$private_sha
    image=ai-image-playground:paid-$(printf %.12s "$public_sha")-$(printf %.12s "$private_sha")
    set -- --build-context "private-overlay=$snapshot/private" --build-arg PRIVATE_OVERLAY_PRESENT=true
  fi
  docker buildx build --builder "$builder" --platform linux/amd64 --load \
    --build-arg "APP_VERSION=$version" --tag "$image" "$@" "$snapshot/public"
  image_id=$(docker image inspect "$image" --format '{{.Id}}')
  printf '%s\t%s\t%s\t%s\t%s\n' "$edition" "$image" "$image_id" "$public_sha" "$private_sha" >> "$output/images.tsv"
  images="$images $image"
done
# Separate commands preserve save failures (a shell pipeline would only report gzip's status).
# shellcheck disable=SC2086
docker save -o "$output/images.tar" $images
gzip "$output/images.tar"
(cd "$output" && shasum -a 256 images.tar.gz images.tsv scripts/vps-deploy.sh scripts/app-compose.sh scripts/lib/deploy-common.sh deploy/compose.app.yaml > SHA256SUMS)
echo "Release ready: $output (copy to VPS, then run scripts/vps-deploy.sh $target $output)"
