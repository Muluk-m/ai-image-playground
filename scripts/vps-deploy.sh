#!/bin/sh
set -eu
# This script is installed in the server-side deployment runtime. The release directory is data
# only: it is never treated as a source tree and cannot replace this script or its helpers.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$repo_root/scripts/lib/deploy-common.sh"
target=${1:-}
case "$target" in paid|test) ;; *) echo "Usage: $0 paid|test /absolute/release-directory" >&2; exit 2 ;; esac
release=${2:-}
case "$release" in /*) ;; *) echo "Prebuilt release required. Run build-vps-release.sh on macmini2 first." >&2; exit 2 ;; esac
[ -f "$release/SHA256SUMS" ] || { echo "Incomplete release: no checksums" >&2; exit 1; }
release=$(CDPATH= cd -- "$release" && pwd)
deploy_env=${DEPLOY_ENV_FILE:-$config_root/deploy.env}
# shellcheck source=/dev/null
[ ! -f "$deploy_env" ] || . "$deploy_env"
PAID_PROJECT=${PAID_PROJECT:-image-playground-paid}
PAID_IMAGE=${PAID_IMAGE:-ai-image-playground:paid}
TEST_PROJECT='image-playground-test'
# shellcheck disable=SC2034  # edition_var reads the target alias.
TEST_IMAGE='ai-image-playground:test'
DEPLOY_KEEP_IMAGES=${DEPLOY_KEEP_IMAGES:-2}
# ai-image-playground:segmenter-<version>-<commit> -> <version> (deploy/segmenter/VERSION).
segmenter_version() {
  printf '%s\n' "$1" | sed -n 's/^ai-image-playground:segmenter-\([0-9][0-9]*\)-[0-9a-f]*$/\1/p'
}
DEPLOY_MIN_FREE_GB=${DEPLOY_MIN_FREE_GB:-8}
# Config center (ADR 0035): the deployment descriptor in this runtime says where the configuration
# comes from (`configSource`), so switching is a reviewed change to deploy/deployments/<name>.json,
# never a file someone left on the host. `rendered` renders it from the release image below and
# never reads app.env; `legacy` reads app.env. Production needs Nain's approval to switch.
case "$target" in paid) config_deployment='prod'; config_project=$PAID_PROJECT ;; *) config_deployment='test'; config_project=$TEST_PROJECT ;; esac
config_rendered_dir=$config_root/rendered/$config_project
descriptor=$repo_root/deploy/deployments/$config_deployment.json
config_source=$(descriptor_config_source "$descriptor")
case $config_source in
  rendered) config_center=true ;;
  legacy) config_center=false ;;
  *) echo "$descriptor names no configSource (rendered or legacy); refusing to guess" >&2; exit 1 ;;
esac
CONFIG_SOURCE=$config_source
export CONFIG_SOURCE
echo "Configuration source: $config_source ($descriptor)"
if [ "$target" = test ] && [ "$config_center" = false ]; then
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
# Tell app-compose.sh and rollout-runtime.sh (its descendants) that this process holds the host
# lock, so they do not wait on their own parent. They still verify the claim.
export_deploy_host_lock
(cd "$release" && sha256sum --strict -c SHA256SUMS)
# The archive's mere presence selects `docker load`, so nothing unlisted may sit in the release.
listed=$(sed 's/^[0-9a-f]*  //' "$release/SHA256SUMS" | LC_ALL=C sort)
present=$(cd "$release" && find . -type f ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)
[ "$listed" = "$present" ] || { echo "Release files not covered by SHA256SUMS" >&2; exit 1; }
# Require the requested application and backup, plus an optional production segmenter.
# The sixth column is the registry digest, or `-`/absent for archive releases.
awk -F '\t' -v repo="$ghcr_repository@sha256:" -v target="$target" '
  $1 != target && $1 != "backup" && !(target == "paid" && $1 == "segmenter") { exit 1 }
  $1 == target && $2 !~ "^ai-image-playground:" target "-" { exit 1 }
  $1 == "segmenter" && ($2 !~ /^ai-image-playground:segmenter-[0-9]+-[0-9a-f]+$/ || $5 != "-") { exit 1 }
  (NF != 5 && NF != 6) || seen[$1]++ { exit 1 }
  NF == 6 && $6 != "-" && (index($6, repo) != 1 || substr($6, length(repo) + 1) !~ /^[0-9a-f]+$/ || length($6) != length(repo) + 64) { exit 1 }
  $2 !~ /^ai-image-playground:(paid|test|backup|segmenter)-[0-9a-f-]+$/ { exit 1 }
  $3 !~ /^sha256:[0-9a-f]+$/ || length($3) != 71 { exit 1 }
  $4 !~ /^[0-9a-f]+$/ || length($4) != 40 { exit 1 }
  $5 != "-" && ($5 !~ /^[0-9a-f]+$/ || length($5) != 40) { exit 1 }
' "$release/images.tsv" || { echo "Invalid image manifest" >&2; exit 1; }
for edition in "$target" backup; do
  [ "$(awk -F '\t' -v e="$edition" '$1==e { n++ } END { print n+0 }' "$release/images.tsv")" = 1 ] || { echo "Missing $edition image" >&2; exit 1; }
done
# Check whether the shared segmenter actually needs an update before reclaiming/pulling: if the
# running container already serves this VERSION, skip pulling, verifying and re-tagging an unused
# ~500 MB copy on every production release. Also retire an expired `-prev` rollback container before
# reclaiming disk so its old model weights are freed before the free-space check.
segmenter_image=$(awk -F '\t' '$1=="segmenter" { print $2 }' "$release/images.tsv")
segmenter_needed=false
if [ -n "$segmenter_image" ]; then
  if ! "$repo_root/scripts/segmenter-deploy.sh" current "$(segmenter_version "$segmenter_image")"; then
    segmenter_needed=true
  else
    echo "segmenter $(segmenter_version "$segmenter_image") already running; skipping image pull and update"
  fi
fi
if [ -x "$repo_root/scripts/segmenter-deploy.sh" ]; then
  SEGMENTER_PREV_RETENTION_SECONDS="${SEGMENTER_PREV_RETENTION_SECONDS:-}" \
    "$repo_root/scripts/segmenter-deploy.sh" prune || true
fi
# Free anything past the retention window before refusing the pull. Tags in this release stay:
# a rollback or a retry may already have them locally, and deleting them would make the pull
# below mandatory. Running containers are protected as well.
release_images=$(awk -F '\t' -v seg="$segmenter_needed" \
  'NF >= 2 && ($1 != "segmenter" || seg == "true") { printf "%s ", $2 }' "$release/images.tsv")
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
    if [ "$edition" = segmenter ] && [ "$segmenter_needed" != true ]; then
      continue
    fi
    docker pull "$repo_digest" </dev/null
    docker tag "$repo_digest" "$image"
  done < "$release/images.tsv"
fi
# Check every image before changing any service or running a migration.
while IFS="$(printf '\t')" read -r edition image expected_id public_sha private_sha repo_digest; do
  if [ "$edition" = segmenter ] && [ "$segmenter_needed" != true ]; then
    continue
  fi
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
  if { [ "$edition" = paid ] || [ "$edition" = test ]; } && [ "$private_sha" != - ]; then
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
rolled_out=
# The shared segmenter (scripts/segmenter-deploy.sh) is its own versioned component. Only
# production releases, which are built from main, carry its image; it is (re)started only when
# that version is not the one running, and the old container keeps serving every edition until
# the new one is healthy. A failure leaves the old one in place and does not fail the release.
# Test releases never carry it (the manifest check above refuses that) and only attach to it.
if [ -n "$segmenter_image" ] && [ "$segmenter_needed" = true ]; then
  if "$repo_root/scripts/segmenter-deploy.sh" up "$segmenter_image" "$(segmenter_version "$segmenter_image")"; then
    docker tag "$segmenter_image" ai-image-playground:segmenter
    rolled_out="$rolled_out $segmenter_image"
  else
    echo "Warning: the new segmenter did not start; the running one was kept." >&2
  fi
fi
record=$(awk -F '\t' -v e="$target" '$1==e' "$release/images.tsv")
IFS="$(printf '\t')" read -r current_edition image expected_id public_sha private_sha repo_digest <<EOF
$record
EOF
prefix=$(printf '%s' "$target" | tr '[:lower:]' '[:upper:]')
project=$(edition_var "$prefix" PROJECT)
if [ "$config_center" = true ]; then
  # Before any service or schema changes: a missing secret or bad descriptor stops here.
  "$repo_root/scripts/config-render.sh" "$config_deployment" "$project" "$image"
  if [ "$target" = test ]; then
    sh "$repo_root/scripts/check-test-isolation.sh" runtime "$config_rendered_dir"
  fi
fi
# Whether the target uses the shared segmenter. Under the config center the deployment descriptor
# decides (`segmenter`, rendered into deploy.env); otherwise SEGMENTER_EDITIONS, which accepts paid
# (production) and test, default test only. Enabling production requires Nain's approval. The
# target gets the shared address only while healthy; otherwise edit-region cards fall back to the
# agent's box. Detach when unavailable so a later rollback reads the same attachment state.
if [ "$config_center" = true ]; then
  segmenter_wanted=$(sed -n 's/^SEGMENTER_ENABLED=//p' "$config_rendered_dir/deploy.env" | tail -n 1)
else
  case " ${SEGMENTER_EDITIONS:-test} " in
    *" $target "*) segmenter_wanted=true ;;
    *) segmenter_wanted=false ;;
  esac
fi
AGENT_SEGMENTER_URL=
AGENT_SEGMENTER_NAMESPACE=$project
if [ "$segmenter_wanted" = true ] && "$repo_root/scripts/segmenter-deploy.sh" healthy; then
  AGENT_SEGMENTER_URL=http://segmenter:8080
fi
export AGENT_SEGMENTER_URL AGENT_SEGMENTER_NAMESPACE
if [ -z "$AGENT_SEGMENTER_URL" ] && ! "$repo_root/scripts/segmenter-deploy.sh" detach "$project"; then
  echo "Warning: could not detach the segmenter from $project." >&2
fi
APP_IMAGE=$image BACKUP_IMAGE=$backup_image "$repo_root/scripts/app-compose.sh" up "$project"
# The app network exists only once the project is up; the executors resolve `segmenter` per
# request, so attaching right after is soon enough, and before the first card is asked for.
if [ -n "$AGENT_SEGMENTER_URL" ] && ! "$repo_root/scripts/segmenter-deploy.sh" attach "$project"; then
  echo "Warning: could not attach the segmenter to $project; edit-region cards fall back to the agent's box." >&2
fi
docker tag "$image" "$(edition_var "$prefix" IMAGE)"
append_deploy_log "$target" "$image" ok
current_edition=
rolled_out="$rolled_out $image"
# The moving backup alias is what a hand rollback of the sidecar looks up. Test receives do
# not own that alias; production does. Either way the commit-qualified backup tag is pruned
# with the other editions below, including backups a test receive pulled and used to leave.
if [ "$target" != test ]; then
  docker tag "$backup_image" ai-image-playground-pg-backup:local
fi
reclaim_deploy_disk "$release" "$rolled_out $backup_image"
echo "Deployed prebuilt release: $release"
