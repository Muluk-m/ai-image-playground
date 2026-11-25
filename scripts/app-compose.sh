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
  docker build --build-arg APP_VERSION="${APP_VERSION:-unknown}" --tag "$image" "$repo_root"
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

explicit_env_file=
if [ "$command" = compose ]; then
  env_file=${APP_ENV_FILE:-$apps_root/$project/app.env}
else
  explicit_env_file=${1:-}
  env_file=${1:-$apps_root/$project/app.env}
  [ "$#" -le 1 ] || usage
  [ "$#" -eq 0 ] || shift
fi

# Config center (ADR 0035): once scripts/config-render.sh has written rendered/<project>, every
# service reads its own generated env file through deploy/compose.rendered.yaml and app.env is no
# longer consulted. Removing that directory falls back to app.env. The project directory keeps the
# release state either way (releases/, mounted at /run/operator).
RENDERED_DIR=${RENDERED_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/rendered/$project}
if [ -f "$RENDERED_DIR/deploy.env" ]; then
  rendered=true
  if [ -n "$explicit_env_file" ]; then
    echo "$RENDERED_DIR is in use; an env file argument would be ignored. Remove that directory to go back to app.env." >&2
    exit 2
  fi
  # `env_file: format: raw` needs Compose 2.30, `!override`/`!reset` 2.24.
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//') || compose_version=
  case $compose_version in
    '' | [3-9].* | [1-9][0-9].* | 2.3[0-9]* | 2.[4-9][0-9]*) ;;
    *) echo "Docker Compose $compose_version is too old for compose.rendered.yaml (needs 2.30+)" >&2; exit 1 ;;
  esac
  APP_CONFIG_DIR=$apps_root/$project
  mkdir -p "$APP_CONFIG_DIR"
  APP_CONFIG_DIR=$(CDPATH= cd -- "$APP_CONFIG_DIR" && pwd)
  # Only to satisfy compose.app.yaml's interpolation; the overlay replaces both.
  APP_ENV_FILE=$RENDERED_DIR/env/bff.env
  MIGRATOR_ENV_FILE=$RENDERED_DIR/env/migrate.env
  # deploy.env holds no secrets: project name, ports and switches for interpolation and profiles.
  env_file=$RENDERED_DIR/deploy.env
  export RENDERED_DIR
  # compose.app.yaml insists on pg-backup's credentials at interpolation; the overlay replaces
  # pg-backup's environment with its rendered env file, so these never reach a container.
  for name in ADMIN_DATABASE_URL S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
    export "$name=rendered"
  done
  # The rendered operator config is bind-mounted onto /run/operator/operator-config.json, inside the
  # read-only bind of this directory; the mount point has to exist on the host side.
  [ -e "$APP_CONFIG_DIR/operator-config.json" ] || : > "$APP_CONFIG_DIR/operator-config.json"
  # Tunnel connectors bind a directory that stays put (see stage_tunnels) and run as this user.
  TUNNELS_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/tunnels/$project
  TUNNEL_USER=$(id -u):$(id -g)
  export TUNNELS_DIR TUNNEL_USER
else
  rendered=false
  if [ ! -f "$env_file" ]; then
    echo "Application environment file not found: $env_file" >&2
    echo "Render the deployment with scripts/config-render.sh, or copy a deploy/app.*.env.example file outside the repository and replace every placeholder." >&2
    exit 1
  fi
  APP_CONFIG_DIR=$(CDPATH= cd -- "$(dirname -- "$env_file")" && pwd)
  APP_ENV_FILE=$APP_CONFIG_DIR/$(basename -- "$env_file")
  env_file=$APP_ENV_FILE
  MIGRATOR_ENV_FILE=${MIGRATOR_ENV_FILE:-$APP_CONFIG_DIR/migrate.env}
fi
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
enterprise_tunnel_enabled() {
  [ "$rendered" = true ] && [ "$(app_env_value ENTERPRISE_TUNNEL_ENABLED)" = true ]
}
# Everything derived from the env file. Called again after a rollback renders with the older image.
load_switches() {
  if observability_enabled; then
    COMPOSE_PROFILES=observability
    OBS_LOG_MATCH='*'
  else
    COMPOSE_PROFILES=
    OBS_LOG_MATCH=__observability_off__
  fi
  if enterprise_tunnel_enabled; then
    COMPOSE_PROFILES=${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}enterprise-tunnel
  fi
  export COMPOSE_PROFILES OBS_LOG_MATCH
  if [ "$rendered" = true ]; then
    # rollout-runtime.sh reads this; --env-file only reaches Compose.
    INFRA_NETWORK_NAME=$(app_env_value INFRA_NETWORK_NAME)
    export INFRA_NETWORK_NAME
  fi
}
load_switches

# Compose leaves a running container alone when only an inline `configs:` body changed, so a new
# collector config never reached production until someone recreated it by hand. Each collector
# carries a label with the digest of its config body; a changed body changes the label, and the
# next `up` recreates exactly that collector.
config_digest() {
  awk -v name="  $1:" '
    /^configs:/ { in_configs = 1; next }
    in_configs && /^[^ ]/ { exit }
    in_configs && $0 == name { found = 1; next }
    found && /^  [^ ]/ { exit }
    found { print }
  ' "$compose_file" | cksum | awk '{ print $1 "-" $2 }'
}
LOG_COLLECTOR_CONFIG_DIGEST=$(config_digest log-collector)
OTEL_COLLECTOR_CONFIG_DIGEST=$(config_digest otel-collector)
export LOG_COLLECTOR_CONFIG_DIGEST OTEL_COLLECTOR_CONFIG_DIGEST

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
  if [ "$rendered" = true ]; then
    docker compose \
      --project-name "$project" \
      --env-file "$env_file" \
      --file "$compose_file" \
      --file "$repo_root/deploy/compose.rendered.yaml" \
      "$@"
  else
    docker compose \
      --project-name "$project" \
      --env-file "$env_file" \
      --file "$compose_file" \
      "$@"
  fi
}

# Where the main tunnel's config.yml and credentials.json come from.
tunnel_dir() {
  if [ "$rendered" = true ]; then printf '%s' "$RENDERED_DIR/cloudflared/main"
  else printf '%s' "$APP_CONFIG_DIR/cloudflared"; fi
}
require_migrator_env() {
  if [ ! -f "$MIGRATOR_ENV_FILE" ]; then
    echo "Migrator environment file not found: $MIGRATOR_ENV_FILE" >&2
    if [ "$rendered" = true ]; then
      echo "Re-render the deployment with scripts/config-render.sh." >&2
    else
      echo "Copy deploy/migrate.env.example beside app.env and replace the placeholder." >&2
    fi
    exit 1
  fi
}

require_tunnel_credentials() {
  if [ ! -f "$(tunnel_dir)/config.yml" ] || [ ! -f "$(tunnel_dir)/credentials.json" ]; then
    echo "Tunnel files not found in $(tunnel_dir)" >&2
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
  if [ "$rendered" = false ] && [ -z "$(app_env_value OBS_PROXY_URL)" ]; then
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

# Tunnels under the config center. A connector reads its config once, at start, from the directory
# bound when it was created. rendered/<project> is replaced by rename on every render, which a bind
# mount would not follow, so connectors bind TUNNELS_DIR/<name> instead and its files are rewritten in
# place here. stage_tunnels runs before rollout-runtime.sh (which may start a stopped connector);
# sync_tunnels after it, so the cutover runs on the connector as it was.
stage_tunnels() {
  [ "$rendered" = true ] || return 0
  for name in main enterprise; do
    [ -f "$RENDERED_DIR/cloudflared/$name/config.yml" ] || continue
    mkdir -p "$TUNNELS_DIR/$name"
    chmod 700 "$TUNNELS_DIR" "$TUNNELS_DIR/$name"
    for file in config.yml credentials.json; do
      target=$TUNNELS_DIR/$name/$file
      [ -f "$RENDERED_DIR/cloudflared/$name/$file" ] || continue
      cmp -s "$RENDERED_DIR/cloudflared/$name/$file" "$target" && continue
      # Marked before the copy and cleared only once the connector came back with it: a rollout
      # failing in between leaves the mark for the next deploy, whose copy then changes nothing.
      : > "$TUNNELS_DIR/.pending-$name"
      if [ -f "$target" ]; then
        # In place: the running bind mount keeps seeing the same file.
        cat "$RENDERED_DIR/cloudflared/$name/$file" > "$target"
      else
        # New: written aside and renamed, so an interrupted copy never leaves a partial file.
        (umask 077 && cat "$RENDERED_DIR/cloudflared/$name/$file" > "$target.next")
        mv "$target.next" "$target"
      fi
    done
  done
}

tunnels_staged() {
  for name in main enterprise; do
    for file in config.yml credentials.json; do
      [ ! -f "$RENDERED_DIR/cloudflared/$name/$file" ] || [ -f "$TUNNELS_DIR/$name/$file" ] || return 1
    done
  done
}

# The connector registered with Cloudflare's edge since it last started: its log says so for each
# connection. Bounded; a connector that exits or never registers fails the deploy.
# TUNNEL_READY_SECONDS=0 skips the wait (script tests have no real connector).
connector_ready() {
  limit=${TUNNEL_READY_SECONDS:-60}
  [ "$limit" != 0 ] || return 0
  waited=0
  while [ "$waited" -lt "$limit" ]; do
    # Read each round: a restart in between starts a new run whose log has to say it again.
    started=$(docker inspect --format '{{.State.StartedAt}}' "$1" 2>/dev/null) || return 1
    [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || return 1
    if docker logs --since "$started" "$1" 2>&1 | grep -q 'Registered tunnel connection'; then
      # And it stays up: the same run, still running, a few seconds later.
      sleep 5
      [ "$(docker inspect --format '{{.State.StartedAt}}' "$1" 2>/dev/null)" = "$started" ] &&
        [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" = true ] && return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Recreate a connector bound elsewhere (the switch from app.env) or not running, restart one with
# files pending, leave the rest alone: a restart drops its edge connections. Fatal on failure, so a
# deploy never reports success while a tunnel's hostnames are unreachable.
sync_tunnel() {
  service=$1
  container=$project-$service-1
  dir=$2
  pending=$3
  source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/cloudflared"}}{{.Source}}{{end}}{{end}}' "$container" 2>/dev/null) || source=
  running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null) || running=
  if [ "$source" != "$dir" ] || [ "$running" != true ]; then
    compose up --detach --no-deps --force-recreate "$service" ||
      { echo "The $service connector did not start; its hostnames are unreachable." >&2; exit 1; }
  elif [ -n "$pending" ] && [ -e "$pending" ]; then
    docker restart "$container" >/dev/null ||
      { echo "The $service connector did not restart with its new files." >&2; exit 1; }
  else
    return 0
  fi
  connector_ready "$container" ||
    { echo "The $service connector did not register with Cloudflare; check its logs. Its hostnames are unreachable." >&2; exit 1; }
  [ -z "$pending" ] || rm -f "$pending"
}

remove_enterprise_connector() {
  docker inspect "$project-cloudflared-enterprise-1" >/dev/null 2>&1 || return 0
  docker rm --force "$project-cloudflared-enterprise-1" >/dev/null ||
    { echo "Could not remove the enterprise connector of $project." >&2; exit 1; }
}

sync_tunnels() {
  if [ "$rendered" = false ]; then
    # Back on app.env after the config center: bind the old directory again, and drop the enterprise
    # connector the config center started (the standalone one, if any, is not this project's).
    source=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/cloudflared"}}{{.Source}}{{end}}{{end}}' "$project-cloudflared-1" 2>/dev/null) || source=
    case $source in
      "$ops_root/tunnels/$project/"* | "$ops_root/rendered/$project/"*)
        sync_tunnel cloudflared "$APP_CONFIG_DIR/cloudflared" '' ;;
    esac
    remove_enterprise_connector
    return 0
  fi
  sync_tunnel cloudflared "$TUNNELS_DIR/main" "$TUNNELS_DIR/.pending-main"
  if enterprise_tunnel_enabled; then
    sync_tunnel cloudflared-enterprise "$TUNNELS_DIR/enterprise" "$TUNNELS_DIR/.pending-enterprise"
  else
    remove_enterprise_connector
  fi
}

# Rolling back to an image means its catalog too: render with that image when it can render.
rerender_for_rollback() {
  [ "$rendered" = true ] || return 0
  deployment=$(app_env_value DEPLOYMENT)
  if "$repo_root/scripts/config-render.sh" "$deployment" "$project" "$rollback_image"; then
    load_switches
    return 0
  fi
  echo "Warning: $rollback_image could not render $deployment; the rollback keeps the configuration rendered by the newer release." >&2
}

activate_backend_then_ingress() {
  if [ "$rendered" = true ]; then
    # Rendered configuration points tunnels, Admin and the host collector at the release router,
    # which only exists after a release rollout. A first install still goes through app.env; a new
    # host under the config center is scripts/bootstrap-host.sh's job (ADR 0035 P6).
    echo "First install of $project under the config center is not supported yet; deploy it once with app.env (remove $RENDERED_DIR)." >&2
    exit 1
  fi
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
      stage_tunnels
      "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollout_image"
    else
      activate_backend_then_ingress
    fi
    sync_tunnels
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
    # rollout-runtime.sh run on its own may start a connector here; its files have to be in place.
    # Staged under the host lock (inherited from a deploying ancestor), checked file by file.
    if [ "$rendered" = true ] && ! tunnels_staged; then
      take_host_lock
      stage_tunnels
    fi
    compose "$@"
    # Release rollouts start runtime and ancillary containers through here; name them.
    case " $* " in *" up "*) write_container_names ;; esac
    ;;
  rollback)
    # Render first: the older image may restore files the current render lacks.
    take_host_lock
    rerender_for_rollback
    require_migrator_env
    require_tunnel_credentials
    APP_IMAGE=$rollback_image
    export APP_IMAGE
    start_log_collector
    stage_tunnels
    "$repo_root/scripts/rollout-runtime.sh" "$project" "$rollback_image"
    sync_tunnels
    ;;
  *)
    usage
    ;;
esac
