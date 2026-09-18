#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/deploy/compose.app.yaml"
config_root=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/app-compose.sh build [image]
  scripts/app-compose.sh build-private [image]
  scripts/app-compose.sh up <project> [env-file]
  scripts/app-compose.sh stop <project> [env-file]
  scripts/app-compose.sh status <project> [env-file]
  scripts/app-compose.sh compose <project> <docker compose args...>
  scripts/app-compose.sh rollback <project> <image> [env-file]

The default env file is:
  $XDG_CONFIG_HOME/ai-image-playground/apps/<project>/app.env
or $HOME/.config/ai-image-playground/apps/<project>/app.env.

APP_IMAGE=<tag> in the environment overrides the image named in that env file.
EOF
  exit 2
}

command=${1:-}
[ -n "$command" ] || usage
shift

if [ "$command" = build ] || [ "$command" = build-private ]; then
  [ "$(uname -s)" = Darwin ] || { echo "Build on macmini2; VPS accepts prebuilt releases only." >&2; exit 1; }
  image=${1:-ai-image-playground:local}
  if [ "$command" = build-private ]; then
    # A public build caches these two stages with an empty overlay; reusing that
    # cache leaves the overlay dependencies out of the pnpm store.
    docker build \
      --no-cache-filter private-manifests,deps \
      --build-context private-overlay="$repo_root/private" \
      --build-arg PRIVATE_OVERLAY_PRESENT=true \
      --build-arg APP_VERSION="${APP_VERSION:-unknown}" \
      --tag "$image" \
      "$repo_root"
  else
    docker build --build-arg APP_VERSION="${APP_VERSION:-unknown}" --tag "$image" "$repo_root"
  fi
  exit 0
fi

project=${1:-}
[ -n "$project" ] || usage
shift

rollback_image=
if [ "$command" = rollback ]; then
  rollback_image=${1:-}
  [ -n "$rollback_image" ] || usage
  shift
fi

if [ "$command" = compose ]; then
  env_file=${APP_ENV_FILE:-$config_root/$project/app.env}
else
  env_file=${1:-$config_root/$project/app.env}
  [ "$#" -le 1 ] || usage
  [ "$#" -eq 0 ] || shift
fi

if [ ! -f "$env_file" ]; then
  echo "Application environment file not found: $env_file" >&2
  echo "Copy a deploy/app.*.env.example file outside the repository and replace every placeholder." >&2
  exit 1
fi

APP_CONFIG_DIR=$(CDPATH= cd -- "$(dirname -- "$env_file")" && pwd)
APP_ENV_FILE=$APP_CONFIG_DIR/$(basename -- "$env_file")
env_file=$APP_ENV_FILE
MIGRATOR_ENV_FILE=${MIGRATOR_ENV_FILE:-$APP_CONFIG_DIR/migrate.env}
export MIGRATOR_ENV_FILE
export APP_ENV_FILE APP_CONFIG_DIR

# Read-only inputs of the operations board. The collector learns container names from a table in
# OPS_BOARD_DIR (cgroups only know IDs, and it never gets the Docker socket); admin lists recent
# deployments from the deploy log, which is only ever appended to.
#
# The table lives in a directory of its own that is mounted whole. A single-file bind mount goes
# wrong twice: Docker turns a missing source into a root-owned directory, and a rename leaves the
# container on the old file. The directory is created here, before any compose command runs.
ops_root=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground
OPS_BOARD_DIR=$ops_root/ops-board
mkdir -p "$OPS_BOARD_DIR"
# An earlier release bind-mounted the table itself, and Docker left a directory in its place.
if [ -d "$ops_root/container-names.tsv" ]; then rmdir "$ops_root/container-names.tsv" 2>/dev/null || true; fi
DEPLOYMENTS_LOG_SOURCE=$ops_root/deployments.log
[ -f "$DEPLOYMENTS_LOG_SOURCE" ] || DEPLOYMENTS_LOG_SOURCE=/dev/null
export OPS_BOARD_DIR DEPLOYMENTS_LOG_SOURCE

write_container_names() {
  names=$OPS_BOARD_DIR/container-names.tsv
  if docker ps --all --no-trunc --format '{{.ID}}	{{.Names}}' >"$names.next"; then
    mv "$names.next" "$names"
  else
    rm -f "$names.next"
    echo "Could not refresh $names; the board will show container IDs." >&2
  fi
}

compose() {
  docker compose \
    --project-name "$project" \
    --env-file "$env_file" \
    --file "$compose_file" \
    "$@"
}
require_migrator_env() {
  if [ ! -f "$MIGRATOR_ENV_FILE" ]; then
    echo "Migrator environment file not found: $MIGRATOR_ENV_FILE" >&2
    echo "Copy deploy/migrate.env.example beside app.env and replace the placeholder." >&2
    exit 1
  fi
}

require_tunnel_credentials() {
  if [ ! -f "$APP_CONFIG_DIR/cloudflared/config.yml" ] ||
    [ ! -f "$APP_CONFIG_DIR/cloudflared/credentials.json" ]; then
    echo "Tunnel files not found in $APP_CONFIG_DIR/cloudflared" >&2
    echo "Copy deploy/cloudflared/config.yml.example there and place the credentials.json written by \`cloudflared tunnel create\`." >&2
    exit 1
  fi
}

activate_backend_then_ingress() {
  compose up --detach --wait "$@" dependency-check bff worker admin
  compose up --detach --wait "$@" cloudflared pg-backup
  write_container_names
  # Started last and not waited on: the collector watches the deployment, it is not part of it,
  # so a collector that cannot start must not fail a rollout. The board shows it as missing.
  compose up --detach "$@" host-collector
  # Once more, so a collector recreated just now is named too.
  write_container_names
}

case "$command" in
  up)
    require_migrator_env
    require_tunnel_credentials
    # Release-managed once `current` exists, even after the Compose BFF has been retired.
    if [ -f "$APP_CONFIG_DIR/releases/current" ] || docker inspect "$project-bff-1" >/dev/null 2>&1; then
      rollout_image=${APP_IMAGE:-$(compose config --images | head -n 1)}
      "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollout_image"
    else
      activate_backend_then_ingress
    fi
    ;;
  stop|down)
    if [ -f "$APP_CONFIG_DIR/releases/current" ]; then
      echo "Release-managed executors are active. Refusing legacy compose-down; drain each runtime before stopping ingress." >&2
      exit 1
    fi
    compose down --remove-orphans
    ;;
  status)
    # --all, or the one-shot migrate and dependency-check containers are invisible.
    compose ps --all
    ;;
  compose)
    compose "$@"
    # Release rollouts start runtime and ancillary containers through here; name them.
    case " $* " in *" up "*) write_container_names ;; esac
    ;;
  rollback)
    require_migrator_env
    require_tunnel_credentials
    APP_IMAGE=$rollback_image
    export APP_IMAGE
    "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollback_image"
    ;;
  *)
    usage
    ;;
esac
