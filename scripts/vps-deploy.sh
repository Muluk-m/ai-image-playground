#!/bin/sh
set -eu
# Receiver only: no git checkout, dependency installation or image build on production.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"
target=${1:-}
case "$target" in internal) editions=internal ;; paid) editions=paid ;; test) editions='test' ;; all) editions='internal paid' ;; *) echo "Usage: $0 internal|paid|test|all /absolute/release-directory" >&2; exit 2 ;; esac
release=${2:-}
case "$release" in /*) ;; *) echo "Prebuilt release required. Run build-vps-release.sh on macmini2 first." >&2; exit 2 ;; esac
[ -f "$release/SHA256SUMS" ] || { echo "Incomplete release: no checksums" >&2; exit 1; }
release=$(CDPATH= cd -- "$release" && pwd)
[ "$repo_root" = "$release" ] || { echo "Run the receiver shipped inside this release directory." >&2; exit 1; }
deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
# shellcheck source=/dev/null
[ ! -f "$deploy_env" ] || . "$deploy_env"
INTERNAL_PROJECT=${INTERNAL_PROJECT:-image-playground-internal}
INTERNAL_IMAGE=${INTERNAL_IMAGE:-ai-image-playground:vps-main}
PAID_PROJECT=${PAID_PROJECT:-image-playground-paid}
PAID_IMAGE=${PAID_IMAGE:-ai-image-playground:paid}
TEST_PROJECT='image-playground-test'
# shellcheck disable=SC2034  # edition_var reads the target alias.
TEST_IMAGE='ai-image-playground:test'
DEPLOY_KEEP_IMAGES=${DEPLOY_KEEP_IMAGES:-2}
DEPLOY_MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-8}
if [ "$target" = test ]; then
  sh "$repo_root/scripts/check-test-isolation.sh" runtime "$config_root/apps/$TEST_PROJECT"
  MIGRATOR_ENV_FILE=$config_root/apps/$TEST_PROJECT/migrate.env
  export MIGRATOR_ENV_FILE
fi
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
awk -F '\t' -v repo="$ghcr_repository@sha256:" -v target="$target" '
  target == "test" && $1 != "test" && $1 != "backup" && $1 != "segmenter" { exit 1 }
  target != "test" && $1 == "segmenter" { exit 1 }
  $1 == "test" && $2 !~ /^ai-image-playground:test-/ { exit 1 }
  $1 == "segmenter" && ($2 !~ /^ai-image-playground:segmenter-/ || $5 != "-") { exit 1 }
  (NF != 5 && NF != 6) || $1 !~ /^(internal|paid|test|backup|segmenter)$/ || seen[$1]++ { exit 1 }
  NF == 6 && $6 != "-" && (index($6, repo) != 1 || substr($6, length(repo) + 1) !~ /^[0-9a-f]+$/ || length($6) != length(repo) + 64) { exit 1 }
  $2 !~ /^ai-image-playground:(vps-main|paid|test|backup|segmenter)-[0-9a-f-]+$/ { exit 1 }
  $3 !~ /^sha256:[0-9a-f]+$/ || length($3) != 71 { exit 1 }
  $4 !~ /^[0-9a-f]+$/ || length($4) != 40 { exit 1 }
  $5 != "-" && ($5 !~ /^[0-9a-f]+$/ || length($5) != 40) { exit 1 }
' "$release/images.tsv" || { echo "Invalid image manifest" >&2; exit 1; }
for edition in $editions backup; do
  [ "$(awk -F '\t' -v e="$edition" '$1==e { n++ } END { print n+0 }' "$release/images.tsv")" = 1 ] || { echo "Missing $edition image" >&2; exit 1; }
done
# Free anything past the retention window before refusing the pull. Tags in this release stay:
# a rollback or a retry may already have them locally, and deleting them would make the pull
# below mandatory. Running containers are protected as well.
release_images=$(awk -F '\t' 'NF >= 2 { printf "%s ", $2 }' "$release/images.tsv")
reclaim_deploy_disk "$release" "$release_images"
free_gb=$(docker_root_free_gb)
echo "Docker disk free: ${free_gb}G"
if [ "$free_gb" -lt "$DEPLOY_MIN_FREE_GB" ]; then
  echo "Docker disk still ${free_gb}G free; dropping rollback images beyond the one in use" >&2
  reclaim_deploy_disk "$release" "$release_images" 1
  free_gb=$(docker_root_free_gb)
  echo "Docker disk free after dropping rollback images: ${free_gb}G"
fi
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
  if [ "$edition" = paid ] || [ "$edition" = test ]; then
    [ "$private_sha" != - ] || exit 1
    version=$public_sha+$private_sha
  fi
  actual=$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_VERSION=//p')
  [ "$actual" = "$version" ] || { echo "APP_VERSION mismatch: $image" >&2; exit 1; }
  if [ "$edition" = backup ]; then
    docker run --rm --network none --memory 256m --entrypoint pg_dump "$image" --version
    continue
  fi
  if [ "$edition" = segmenter ]; then
    # Loads the baked weights and runs one prompt under the production limits.
    docker run --rm --network none --memory 900m --memory-swap 900m --cpus 2 "$image" \
      node server.mjs --self-test
    continue
  fi
  # Execute the target native module before touching services or schema.
  docker run --rm --network none --memory 256m --entrypoint bun "$image" -e '
    import sharp from "./apps/bff/node_modules/sharp";
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    if ((await sharp(png).metadata()).width !== 2) process.exit(1);
  '
done < "$release/images.tsv"
backup_image=$(awk -F '\t' '$1=="backup" { print $2 }' "$release/images.tsv")
segmenter_image=$(awk -F '\t' '$1=="segmenter" { print $2 }' "$release/images.tsv")
segmenter_up=
rolled_out=
for edition in $editions; do
  record=$(awk -F '\t' -v e="$edition" '$1==e' "$release/images.tsv")
  IFS="$(printf '\t')" read -r current_edition image expected_id public_sha private_sha repo_digest <<EOF
$record
EOF
  prefix=$(printf '%s' "$edition" | tr '[:lower:]' '[:upper:]')
  project=$(edition_var "$prefix" PROJECT)
  # The shared segmenter (deploy/compose.segmenter.yaml): one container for every edition. A
  # release that carries it starts or updates it once, before the executors that call it; each
  # edition in SEGMENTER_EDITIONS (default: test only; adding internal/paid needs Nain's go-ahead)
  # is then attached to it and its executors get its address. It
  # is optional: if it does not come up, the executors are not told about it and edit-region
  # cards fall back to the agent's box, so a failure here warns instead of failing the release.
  AGENT_SEGMENTER_URL=
  case " ${SEGMENTER_EDITIONS:-test} " in
    *" $edition "*) segmenter_wanted=1 ;;
    *) segmenter_wanted= ;;
  esac
  if [ -n "$segmenter_wanted" ] && [ -z "$segmenter_image" ] && [ -z "$segmenter_up" ]; then
    # A release without the image (production today) reuses the running shared instance.
    if "$release/scripts/segmenter-deploy.sh" healthy -; then segmenter_up=ok; else segmenter_up=failed; fi
  fi
  if [ -n "$segmenter_wanted" ] && [ -n "$segmenter_image" ] && [ -z "$segmenter_up" ]; then
    segmenter_up=failed
    if "$release/scripts/segmenter-deploy.sh" up "$segmenter_image"; then
      segmenter_up=ok
      docker tag "$segmenter_image" ai-image-playground:segmenter
      rolled_out="$rolled_out $segmenter_image"
    else
      echo "Warning: the segmenter did not start; edit-region cards fall back to the agent's box." >&2
    fi
  fi
  if [ -n "$segmenter_wanted" ] && [ "$segmenter_up" = ok ]; then
    AGENT_SEGMENTER_URL=http://segmenter:8080
  fi
  export AGENT_SEGMENTER_URL
  APP_IMAGE=$image BACKUP_IMAGE=$backup_image "$release/scripts/app-compose.sh" up "$project"
  # The app network exists only once the project is up; the executors resolve `segmenter` per
  # request, so attaching right after is soon enough, and before the first card is asked for.
  if [ -n "$AGENT_SEGMENTER_URL" ] && ! "$release/scripts/segmenter-deploy.sh" attach "$project"; then
    echo "Warning: could not attach the segmenter to $project; edit-region cards fall back to the agent's box." >&2
  fi
  docker tag "$image" "$(edition_var "$prefix" IMAGE)"
  append_deploy_log "$edition" "$image" ok
  current_edition=
  rolled_out="$rolled_out $image"
done
# The moving backup alias is what a hand rollback of the sidecar looks up. Test receives do
# not own that alias; production does. Either way the commit-qualified backup tag is pruned
# with the other editions below, including backups a test receive pulled and used to leave.
if [ "$target" != test ]; then
  docker tag "$backup_image" ai-image-playground-pg-backup:local
fi
reclaim_deploy_disk "$release" "$rolled_out $backup_image"
echo "Deployed prebuilt release: $release"
