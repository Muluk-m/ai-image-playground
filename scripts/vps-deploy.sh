#!/bin/sh
set -eu
# Receiver only: no git checkout, dependency installation or image build on production.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"
target=${1:-}
case "$target" in internal) editions=internal ;; paid) editions=paid ;; all) editions='internal paid' ;; *) echo "Usage: $0 internal|paid|all /absolute/release-directory" >&2; exit 2 ;; esac
release=${2:-}
case "$release" in /*) ;; *) echo "Prebuilt release required. Run build-vps-release.sh on macmini2 first." >&2; exit 2 ;; esac
[ -f "$release/SHA256SUMS" ] || { echo "Incomplete release: no checksums" >&2; exit 1; }
release=$(CDPATH= cd -- "$release" && pwd)
[ "$repo_root" = "$release" ] || { echo "Run the receiver shipped inside this release directory." >&2; exit 1; }
deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
[ ! -f "$deploy_env" ] || . "$deploy_env"
INTERNAL_PROJECT=${INTERNAL_PROJECT:-image-playground-internal}
INTERNAL_IMAGE=${INTERNAL_IMAGE:-ai-image-playground:vps-main}
PAID_PROJECT=${PAID_PROJECT:-image-playground-paid}
PAID_IMAGE=${PAID_IMAGE:-ai-image-playground:paid}
DEPLOY_KEEP_IMAGES=${DEPLOY_KEEP_IMAGES:-2}
DEPLOY_MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-8}
public_sha=-
private_sha=-
current_edition=
image=
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$current_edition" ]; then
    append_deploy_log "$current_edition" "$image" failed || true
  fi
  release_deploy_lock "$deploy_lock"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_deploy_lock "$deploy_lock" "receive $target $release"
(cd "$release" && sha256sum --strict -c SHA256SUMS)
# The archive's mere presence selects `docker load`, so nothing unlisted may sit in the release.
listed=$(sed 's/^[0-9a-f]*  //' "$release/SHA256SUMS" | LC_ALL=C sort)
present=$(cd "$release" && find . -type f ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)
[ "$listed" = "$present" ] || { echo "Release files not covered by SHA256SUMS" >&2; exit 1; }
# Require exactly one record per requested edition and only inert, well-formed fields. The sixth
# column, the registry digest, is `-` or absent in archive releases.
awk -F '\t' -v repo="$ghcr_repository@sha256:" '
  (NF != 5 && NF != 6) || $1 !~ /^(internal|paid|backup)$/ || seen[$1]++ { exit 1 }
  NF == 6 && $6 != "-" && (index($6, repo) != 1 || substr($6, length(repo) + 1) !~ /^[0-9a-f]+$/ || length($6) != length(repo) + 64) { exit 1 }
  $2 !~ /^ai-image-playground:(vps-main|paid|backup)-[0-9a-f-]+$/ { exit 1 }
  $3 !~ /^sha256:[0-9a-f]+$/ || length($3) != 71 { exit 1 }
  $4 !~ /^[0-9a-f]+$/ || length($4) != 40 { exit 1 }
  $5 != "-" && ($5 !~ /^[0-9a-f]+$/ || length($5) != 40) { exit 1 }
' "$release/images.tsv" || { echo "Invalid image manifest" >&2; exit 1; }
for edition in $editions backup; do
  [ "$(awk -F '\t' -v e="$edition" '$1==e { n++ } END { print n+0 }' "$release/images.tsv")" = 1 ] || { echo "Missing $edition image" >&2; exit 1; }
done
free_gb=$(docker_root_free_gb)
[ "$free_gb" -ge "$DEPLOY_MIN_FREE_GB" ] || { echo "Insufficient Docker disk space: ${free_gb}G" >&2; exit 1; }
if [ -f "$release/images.tar.gz" ]; then
  docker load -i "$release/images.tar.gz"
else
  awk -F '\t' 'NF != 6 || $6 == "-" { exit 1 }' "$release/images.tsv" ||
    { echo "Release has neither an image archive nor registry digests" >&2; exit 1; }
  ghcr_login "${GHCR_PULL_TOKEN_FILE:-$config_root/ghcr-pull-token}"
  # Pull by digest, then give each image the local tag that rollout, rollback and pruning use.
  while IFS="$(printf '\t')" read -r edition image expected_id public_sha private_sha repo_digest; do
    docker pull "$repo_digest" </dev/null
    docker tag "$repo_digest" "$image"
  done < "$release/images.tsv"
fi
# Check every image before changing any service or running a migration.
while IFS="$(printf '\t')" read -r edition image expected_id public_sha private_sha repo_digest; do
  if [ -f "$release/images.tar.gz" ]; then
    [ "$(docker image inspect "$image" --format '{{.Id}}')" = "$expected_id" ] || { echo "Image ID mismatch: $image" >&2; exit 1; }
  else
    # A pull by digest is content-addressed; the image ID is not comparable across hosts (a
    # containerd-backed build host reports the manifest digest, this host the config digest).
    docker image inspect "$image" --format '{{range .RepoDigests}}{{println .}}{{end}}' |
      grep -qxF "$repo_digest" || { echo "Image digest mismatch: $image" >&2; exit 1; }
  fi
  [ "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ] || { echo "Wrong image platform: $image" >&2; exit 1; }
  version=$public_sha
  if [ "$edition" = paid ]; then
    [ "$private_sha" != - ] || exit 1
    version=$public_sha+$private_sha
  fi
  actual=$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_VERSION=//p')
  [ "$actual" = "$version" ] || { echo "APP_VERSION mismatch: $image" >&2; exit 1; }
  if [ "$edition" = backup ]; then
    docker run --rm --network none --memory 256m --entrypoint pg_dump "$image" --version
    continue
  fi
  # Execute the target native module before touching services or schema.
  docker run --rm --network none --memory 256m --entrypoint bun "$image" -e '
    import sharp from "./apps/bff/node_modules/sharp";
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    if ((await sharp(png).metadata()).width !== 2) process.exit(1);
  '
done < "$release/images.tsv"
# Untagging alone leaves the release's registry digest reference holding the layers, so each
# pruned tag hands its image id to release_untagged_image.
prune_old_images() {
  running=$(docker ps --format '{{.Image}}' | sort -u | tr '\n' ' ')
  stale=$(docker images --format '{{.Repository}}:{{.Tag}}' "${1%%:*}" |
    select_stale_images "$1" "$DEPLOY_KEEP_IMAGES" "$2 $running")
  if [ -z "$stale" ]; then
    echo "no images to prune for $1 (keeping $DEPLOY_KEEP_IMAGES)"
    return 0
  fi
  for image in $stale; do
    image_id=$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)
    if docker rmi "$image" >/dev/null 2>&1; then
      echo "pruned $image"
      [ -z "$image_id" ] || release_untagged_image "$image_id"
    else
      echo "could not prune $image; leaving it" >&2
    fi
  done
}

backup_image=$(awk -F '\t' '$1=="backup" { print $2 }' "$release/images.tsv")
for edition in $editions; do
  record=$(awk -F '\t' -v e="$edition" '$1==e' "$release/images.tsv")
  IFS="$(printf '\t')" read -r current_edition image expected_id public_sha private_sha repo_digest <<EOF
$record
EOF
  prefix=$(printf '%s' "$edition" | tr '[:lower:]' '[:upper:]')
  project=$(edition_var "$prefix" PROJECT)
  APP_IMAGE=$image BACKUP_IMAGE=$backup_image "$release/scripts/app-compose.sh" up "$project"
  docker tag "$image" "$(edition_var "$prefix" IMAGE)"
  append_deploy_log "$edition" "$image" ok
  current_edition=
  prune_old_images "$(edition_var "$prefix" IMAGE)" "$image"
done
docker tag "$backup_image" ai-image-playground-pg-backup:local
prune_old_images ai-image-playground:backup "$backup_image"
prune_old_releases "$release"
echo "Deployed prebuilt release: $release"
