#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$repo_root/deploy/compose.app.yaml"
. "$repo_root/scripts/lib/deploy-common.sh"
apps_root=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps

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
  env_file=${APP_ENV_FILE:-$apps_root/$project/app.env}
else
  env_file=${1:-$apps_root/$project/app.env}
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

# The log collector's Unix socket. Docker's fluentd driver dials it from the host, so the path is
# the same on both sides; one directory per deployment keeps their logs apart. rollout-runtime.sh
# derives the same path for the containers it creates.
LOG_FORWARD_DIR=$ops_root/log-forward/$project
mkdir -p "$LOG_FORWARD_DIR"
export LOG_FORWARD_DIR

# Observability (ADR 0033, P2): one switch in app.env turns on the `observability` profile
# (OpenObserve, the OTel Collector, the read-only proxy) and the log collector's second output to
# it. Off, the profile stays inactive and that output matches no tag. Read here rather than through
# --env-file because profiles and this match are decided before compose interpolates anything.
# The last assignment of $1, read the way Compose reads an env file: CRLF tolerated, a quoted
# value taken as is, otherwise a ` #` comment and surrounding blanks dropped.
app_env_value() {
  value=$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1[[:space:]]*=//p" "$env_file" |
    tail -n 1 | tr -d '\r')
  value=${value#"${value%%[![:space:]]*}"}
  case $value in
    \"*) value=${value#\"}; value=${value%%\"*} ;;
    \'*) value=${value#\'}; value=${value%%\'*} ;;
    *) value=$(printf '%s' "$value" | sed -e 's/^#.*$//' -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  printf '%s' "$value"
}
observability_enabled() {
  [ "$(app_env_value OBSERVABILITY_ENABLED)" = true ]
}
# A value built from another variable (${...}) is Compose's to expand, not ours: rather than guess,
# start_observability leaves the services exactly as they are.
observability_switch_unreadable() {
  case $(app_env_value OBSERVABILITY_ENABLED) in *'$'*) return 0 ;; *) return 1 ;; esac
}
if observability_enabled; then
  COMPOSE_PROFILES=observability
  OBS_LOG_MATCH='*'
else
  COMPOSE_PROFILES=
  OBS_LOG_MATCH=__observability_off__
fi
export COMPOSE_PROFILES OBS_LOG_MATCH

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

# Before anything else is (re)created, so their first lines have somewhere to go. Not waited on and
# never fatal: the containers forward asynchronously and catch up once it answers.
start_log_collector() {
  compose up --detach --no-deps log-collector ||
    echo "Warning: the log collector did not start; containers keep running and logs stay in docker logs." >&2
  start_observability
}

# Same footing as the log collector: watches the deployment, is not part of it. A failure here is a
# warning; server_logs keeps the logs and the BFF drops spans it cannot export.
start_observability() {
  if observability_switch_unreadable; then
    echo "Warning: OBSERVABILITY_ENABLED in $env_file refers to another variable; write true or false. Observability services left as they are." >&2
    return 0
  fi
  if ! observability_enabled; then
    # Switched off: take the containers down so they stop holding memory. Their volumes stay, so
    # switching back on picks up where it left off. A no-op where they never ran.
    (
      COMPOSE_PROFILES=observability
      export COMPOSE_PROFILES
      compose rm --stop --force openobserve otel-collector obs-proxy
    ) >/dev/null 2>&1 || true
    return 0
  fi
  # Loopback ports are per deployment; two deployments on one host falling back to the same
  # default would leave the second without observability and only a warning to show for it.
  if [ -z "$(app_env_value OBS_PROXY_HOST_PORT)" ] || [ -z "$(app_env_value OBS_UI_HOST_PORT)" ]; then
    echo "Warning: OBSERVABILITY_ENABLED=true but OBS_PROXY_HOST_PORT or OBS_UI_HOST_PORT is not set in $env_file; observability services not started." >&2
    return 0
  fi
  # The worker's log-pipeline alert reads OpenObserve through the proxy; without the address the
  # rule quietly stops observing, so say so on every deploy.
  if [ -z "$(app_env_value OBS_PROXY_URL)" ]; then
    echo "Warning: OBSERVABILITY_ENABLED=true but OBS_PROXY_URL is not set in $env_file; the log-pipeline alert is not observed." >&2
  fi
  compose up --detach --no-deps openobserve otel-collector obs-proxy ||
    echo "Warning: the observability services did not start; server_logs still has the logs." >&2
}

# up and rollback move production, and the log collector and first install below touch containers
# before rollout-runtime.sh runs, so the host deploy lock is taken here, before any of that. A
# lock held by a live process stops the command with 75 and nothing changed; one held by an
# ancestor (vps-deploy.sh) is inherited, and rollout-runtime.sh inherits ours in turn.
take_host_lock() {
  acquire_host_deploy_lock "app-compose $command $project" || exit $?
  trap 'release_deploy_lock "$deploy_lock"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

activate_backend_then_ingress() {
  start_log_collector
  compose up --detach --wait dependency-check bff worker admin
  compose up --detach --wait cloudflared pg-backup
  write_container_names
  # Started last and not waited on: the collector watches the deployment, it is not part of it,
  # so a collector that cannot start must not fail a rollout. The board shows it as missing.
  compose up --detach host-collector
  # Once more, so a collector recreated just now is named too.
  write_container_names
}

release_managed() {
  if [ -e "$APP_CONFIG_DIR/releases/current" ] || [ -e "$APP_CONFIG_DIR/releases/route.json" ]; then
    return 0
  fi
  managed=$(timeout 10 docker ps -a --filter "label=app.runtime.project=$project" --format '{{.Names}}') || {
    echo 'Cannot establish runtime inventory; refusing Compose changes' >&2
    exit 1
  }
  [ -n "$managed" ]
}

case "$command" in
  up)
    require_migrator_env
    require_tunnel_credentials
    take_host_lock
    compose_bff=$(timeout 10 docker ps -a --filter "name=^/$project-bff-1$" --format '{{.Names}}') || exit 1
    if release_managed || [ -n "$compose_bff" ]; then
      # Without the observability profile, so the Collector and OpenObserve images are not candidates.
      rollout_image=${APP_IMAGE:-$(COMPOSE_PROFILES= && export COMPOSE_PROFILES && compose config --images | head -n 1)}
      start_log_collector
      "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollout_image"
    else
      activate_backend_then_ingress
    fi
    ;;
  stop|down)
    if release_managed; then
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
    take_host_lock
    APP_IMAGE=$rollback_image
    export APP_IMAGE
    start_log_collector
    "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollback_image"
    ;;
  *)
    usage
    ;;
esac
