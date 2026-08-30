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
  scripts/app-compose.sh rollback <project> <image> [env-file]

The default env file is:
  $XDG_CONFIG_HOME/ai-image-playground/apps/<project>/app.env
or $HOME/.config/ai-image-playground/apps/<project>/app.env.
EOF
  exit 2
}

command=${1:-}
[ -n "$command" ] || usage
shift

if [ "$command" = build ] || [ "$command" = build-private ]; then
  image=${1:-ai-image-playground:local}
  if [ "$command" = build-private ]; then
    docker build \
      --build-context private-overlay="$repo_root/private" \
      --build-arg PRIVATE_OVERLAY_PRESENT=true \
      --tag "$image" \
      "$repo_root"
  else
    docker build --tag "$image" "$repo_root"
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

env_file=${1:-$config_root/$project/app.env}
[ "$#" -le 1 ] || usage

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

# The public frontend is hosted separately, so this project starts no nginx.
activate_backend_then_ingress() {
  compose up --detach --wait "$@" dependency-check bff worker admin pg-backup
  compose up --detach --wait "$@" cloudflared
}

case "$command" in
  up)
    require_migrator_env
    require_tunnel_credentials
    activate_backend_then_ingress
    ;;
  stop|down)
    compose down --remove-orphans
    ;;
  status)
    compose ps
    ;;
  rollback)
    require_migrator_env
    require_tunnel_credentials
    APP_IMAGE=$rollback_image
    export APP_IMAGE
    activate_backend_then_ingress --force-recreate
    ;;
  *)
    usage
    ;;
esac
