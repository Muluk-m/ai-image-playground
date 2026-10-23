#!/bin/sh
set -eu

# Current ingress and one retained generation are the entire executor budget. A deadline
# ends the deployment's wait, never an executor's work (ADR 0009).
project=${1:?project required}
image=${2:?image required}
case "$project" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid project name' >&2; exit 2 ;; esac
deadline=${DEPLOY_DRAIN_DEADLINE_SECONDS:-300}
grace=${DEPLOY_STOP_GRACE_SECONDS:-75}
proxy_wait=${ADMIN_PROXY_WAIT_SECONDS:-30}
case "$deadline$grace$proxy_wait" in
  *[!0-9]*) echo 'Deployment timeouts take whole seconds' >&2; exit 2 ;;
esac
if [ "$proxy_wait" -lt 1 ]; then echo 'ADMIN_PROXY_WAIT_SECONDS must be at least 1' >&2; exit 2; fi
command -v timeout >/dev/null 2>&1 || { echo 'The VPS requires coreutils timeout for Docker probes' >&2; exit 1; }

# A failed or timed-out Docker query is unknown, never evidence that a container stopped.
docker_probe() { timeout 10 docker "$@"; }
# The shared segmenter (scripts/segmenter-deploy.sh). vps-deploy.sh decides it per release and
# exports AGENT_SEGMENTER_URL (empty when off). Any other path into this script (app-compose.sh
# rollback, a manual run) reads the same decision back from where the deploy left it: the edition
# uses the segmenter exactly when the shared container is attached to its app network, so a
# rollback keeps it on, and keeps it off.
if [ -z "${AGENT_SEGMENTER_URL+set}" ]; then
  AGENT_SEGMENTER_URL=
  case " $(docker_probe inspect \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' \
    image-playground-segmenter 2>/dev/null || true) " in
    *" ${project}_application "*) AGENT_SEGMENTER_URL=http://segmenter:8080 ;;
  esac
fi
image_snapshot=$(docker_probe image inspect --format '{{.Id}} {{index .Config.Labels "app.execution-protocol"}}' "$image")
image_id=${image_snapshot% *}
if [ "${image_snapshot##* }" != 1 ] || [ -z "$image_id" ]; then
  echo 'Image does not support executor-preserving deployment; refusing rollout/rollback' >&2
  exit 1
fi
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=${APP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps/$project}
state_dir=$config_dir/releases
mkdir -p "$state_dir/activated"
app_env=$config_dir/app.env
log_forward_dir=${LOG_FORWARD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/log-forward/$project}
mkdir -p "$log_forward_dir"
. "$repo_root/scripts/lib/deploy-common.sh"
runtime_lock=$state_dir/lock
acquire_deploy_lock "$runtime_lock" "runtime $project $image" || exit 1

network=${project}_application
infra=${INFRA_NETWORK_NAME:-image-playground-infra}
release=$project-r$(date -u +%Y%m%d%H%M%S)-$$
new_bff=$release-bff
new_worker=$release-worker
router=$project-release-router
created=
old_bff=
old_worker=
serving_bff=
serving_worker=
state_known=false
old_worker_drained=false
old_worker_restart=unless-stopped
router_swapped=false

logged_docker() {
  operation=$1
  shift
  docker "$operation" --log-driver fluentd \
    --log-opt "fluentd-address=unix://$log_forward_dir/forward.sock" \
    --log-opt fluentd-async=true --log-opt fluentd-sub-second-precision=true \
    --log-opt fluentd-buffer-limit=4096 --log-opt fluentd-write-timeout=1s \
    --log-opt mode=non-blocking --log-opt max-buffer-size=1m \
    --log-opt cache-disabled=false --log-opt cache-max-size=10m --log-opt cache-max-file=3 "$@"
}

control() {
  docker_probe exec "$1" bun -e '
    const [port, method, path, field] = Bun.argv.slice(-4);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {method,
      headers: {authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || ""}`},
      signal: AbortSignal.timeout(5000)});
    if (!r.ok) process.exit(r.status === 404 ? 44 : 1);
    const value = await r.json();
    if (!value || typeof value !== "object") process.exit(1);
    if (field === "retirement") {
      if (typeof value.draining !== "boolean" || typeof value.safeToStop !== "boolean" ||
          !Number.isSafeInteger(value.active) || value.active < 0 ||
          (port === "37377" && typeof value.failed !== "boolean")) process.exit(1);
      console.log(value.failed === true ? "failed_finalization" :
        value.draining === true && value.active === 0 && value.safeToStop === true ? "idle" : "busy");
    } else {
      if (typeof value[field] !== "boolean") process.exit(1);
      console.log(String(value[field]));
    }
  ' "$2" "$3" "$4" "$5"
}

# The validated snapshot is ID, Docker state, Running, StartedAt, restart policy and image ID.
executor_snapshot() (
  executor=$1
  executor_role=$2
  case "$executor" in *[!a-zA-Z0-9_-]*|'') exit 1 ;; esac
  snapshot=$(docker_probe inspect --format '{{.Id}} {{.State.Status}} {{.State.Running}} {{.State.StartedAt}} {{.HostConfig.RestartPolicy.Name}} {{.Image}} {{.Name}} {{if index .Config.Labels "app.runtime.project"}}{{index .Config.Labels "app.runtime.project"}}{{else}}-{{end}} {{if index .Config.Labels "app.runtime.role"}}{{index .Config.Labels "app.runtime.role"}}{{else}}-{{end}} {{if index .Config.Labels "com.docker.compose.project"}}{{index .Config.Labels "com.docker.compose.project"}}{{else}}-{{end}} {{if index .Config.Labels "com.docker.compose.service"}}{{index .Config.Labels "com.docker.compose.service"}}{{else}}-{{end}} {{if index .Config.Labels "app.runtime.generation"}}{{index .Config.Labels "app.runtime.generation"}}{{else}}-{{end}}' "$executor") || exit 1
  set -f
  set -- $snapshot
  [ "$#" -eq 12 ] && [ "$7" = "/$executor" ] || exit 1
  if [ "$8" = "$project" ] && [ "$9" = "$executor_role" ]; then
    case "$executor" in "$project"-r[0-9]*-"$executor_role") ;; *) exit 1 ;; esac
    [ "${12}" = - ] || [ "${12}" = "${executor%-$executor_role}" ] || exit 1
  elif [ "${10}" != "$project" ] || [ "${11}" != "$executor_role" ] ||
    [ "$executor" != "$project-$executor_role-1" ]; then
    exit 1
  fi
  case "$1" in ''|*[!0-9a-f]*) exit 1 ;; esac
  case "$3" in true|false) ;; *) exit 1 ;; esac
  printf '%s %s %s %s %s %s\n' "$1" "$2" "$3" "$4" "$5" "$6"
)

load_route() {
  [ -f "$state_dir/route.json" ] || return 1
  route=$(cat "$state_dir/route.json") || return 1
  # Accept the two formats emitted by this script. Anything else needs operator inspection.
  route_bff=$(printf '%s\n' "$route" | sed -nE 's/^\{"origin":"http:\/\/([a-zA-Z0-9_-]+):37377"(,"worker":"[a-zA-Z0-9_-]+")?\}$/\1/p')
  [ -n "$route_bff" ] || return 1
  case "$route_bff" in
    "$project-bff-1") route_worker=$project-worker-1 ;;
    "$project"-r[0-9]*-bff) route_worker=${route_bff%-bff}-worker ;;
    *) return 1 ;;
  esac
  case "$route" in
    "{\"origin\":\"http://$route_bff:37377\"}"|"{\"origin\":\"http://$route_bff:37377\",\"worker\":\"$route_worker\"}") ;;
    *) return 1 ;;
  esac
  executor_snapshot "$route_bff" bff >/dev/null || return 1
  executor_snapshot "$route_worker" worker >/dev/null || return 1
  serving_bff=$route_bff
  serving_worker=$route_worker
}

write_current() {
  printf '%s %s\n' "$serving_bff" "$serving_worker" > "$state_dir/current.next" &&
    mv "$state_dir/current.next" "$state_dir/current"
}

executor_inventory() (
  for inventory_role in bff worker; do
    names=$(docker_probe ps -a --filter "label=app.runtime.project=$project" \
      --filter "label=app.runtime.role=$inventory_role" --format '{{.Names}}') || exit 1
    compose_names=$(docker_probe ps -a --filter "name=^/$project-$inventory_role-1$" --format '{{.Names}}') || exit 1
    for inventory_name in $names $compose_names; do printf '%s:%s\n' "$inventory_name" "$inventory_role"; done
  done
)

# This is the only stop/remove path for BFF and worker containers, including failed candidates.
retire_executor_if_safe() (
  executor=$1
  executor_role=$2
  load_route || { echo "Retained $executor: unknown route"; exit 1; }
  if [ "$executor" = "$serving_bff" ] || [ "$executor" = "$serving_worker" ]; then
    echo "Retained $executor: serving"
    exit 1
  fi
  if ! before=$(executor_snapshot "$executor" "$executor_role"); then
    present=$(docker_probe ps -a --filter "name=^/$executor$" --format '{{.Names}}') || {
      echo "Retained $executor: unknown inspect"
      exit 1
    }
    if [ -z "$present" ]; then echo "Retired $executor: already absent"; exit 0; fi
    echo "Retained $executor: unknown inspect"
    exit 1
  fi
  set -- $before
  executor_id=$1
  executor_state=$2
  executor_running=$3
  executor_started=$4
  docker_probe update --restart=no "$executor_id" >/dev/null || { echo "Retained $executor: unknown restart policy"; exit 1; }
  if [ "$executor_role" = worker ]; then
    rm -f "$state_dir/activated/$executor" || { echo "Retained $executor: activation marker could not be removed"; exit 1; }
  fi
  case "$executor_state:$executor_running" in
    created:false|exited:false|dead:false)
      docker_probe rm "$executor_id" >/dev/null || { echo "Retained $executor: removal failed"; exit 1; }
      echo "Retired $executor: already stopped"
      exit 0 ;;
    running:true) ;;
    *) echo "Retained $executor: unknown Docker state $executor_state"; exit 1 ;;
  esac
  executor_port=37377
  [ "$executor_role" != worker ] || executor_port=37379
  if [ "$(control "$executor" "$executor_port" POST /internal/deployment/drain draining 2>/dev/null || true)" != true ]; then
    echo "Retained $executor: unknown drain acknowledgement"
    exit 1
  fi
  retirement=$(control "$executor" "$executor_port" GET /internal/deployment/drain retirement 2>/dev/null) || retirement=unknown
  if [ "$retirement" != idle ]; then echo "Retained $executor: $retirement"; exit 1; fi
  after=$(executor_snapshot "$executor" "$executor_role") || { echo "Retained $executor: unknown identity recheck"; exit 1; }
  set -- $after
  if [ "$1" != "$executor_id" ] || [ "$2:$3" != running:true ] ||
    [ "$4" != "$executor_started" ] || [ "$5" != no ]; then
    echo "Retained $executor: process changed after drain"
    exit 1
  fi
  load_route || { echo "Retained $executor: unknown route recheck"; exit 1; }
  if [ "$executor" = "$serving_bff" ] || [ "$executor" = "$serving_worker" ]; then
    echo "Retained $executor: now serving"
    exit 1
  fi
  timeout "$((grace + 10))" docker stop -t "$grace" "$executor_id" >/dev/null || { echo "Retained $executor: stop failed"; exit 1; }
  stopped=$(executor_snapshot "$executor" "$executor_role") || { echo "Retained $executor: unknown stop result"; exit 1; }
  set -- $stopped
  [ "$1" = "$executor_id" ] || { echo "Retained $executor: identity changed after stop"; exit 1; }
  case "$2:$3" in
    exited:false|dead:false) ;;
    *) echo "Retained $executor: stop not confirmed"; exit 1 ;;
  esac
  docker_probe rm "$executor_id" >/dev/null || { echo "Retained $executor: removal failed"; exit 1; }
  echo "Retired $executor: drained"
)

collect_noncurrent() {
  inventory=$(executor_inventory) || { echo 'Cannot establish executor inventory; preserving every instance' >&2; return 1; }
  pending=
  for entry in $inventory; do
    name=${entry%:*}
    [ "$name" != "$serving_bff" ] && [ "$name" != "$serving_worker" ] || continue
    pending="$pending $entry"
  done
}

retire_pending() {
  retire_until=$(($(date +%s) + $1))
  while [ -n "$pending" ]; do
    still=
    for entry in $pending; do
      if result=$(retire_executor_if_safe "${entry%:*}" "${entry##*:}"); then
        echo "$result"
      else
        echo "$result" >&2
        still="$still $entry"
      fi
    done
    pending=$still
    now=$(date +%s)
    [ -n "$pending" ] && [ "$now" -lt "$retire_until" ] || break
    delay=$((retire_until - now))
    [ "$delay" -le 5 ] || delay=5
    sleep "$delay"
  done
}

restore() {
  echo 'Rollout failed before cutover; restoring previous admission.' >&2
  if [ "$old_worker_drained" = true ]; then
    touch "$state_dir/activated/$old_worker"
    docker_probe update --restart="$old_worker_restart" "$old_worker" >/dev/null || true
    control "$old_worker" 37379 POST /internal/deployment/resume ok >/dev/null ||
      echo "Warning: could not resume $old_worker" >&2
  fi
  for entry in $created; do
    retire_executor_if_safe "${entry%:*}" "${entry##*:}" || true
  done
  if [ "$router_swapped" = true ]; then
    docker rm -f "$router" >/dev/null 2>&1
    docker rename "$router-retiring" "$router" && docker start "$router" >/dev/null
  fi
}

cleanup() {
  status=$?
  set +e
  if [ "$status" -ne 0 ] && [ "$state_known" = true ]; then
    if load_route; then
      write_current || echo 'Could not repair current; route.json remains authoritative' >&2
      if [ "$serving_bff" = "$old_bff" ] && [ "$serving_worker" = "$old_worker" ]; then
        if [ -n "$created" ] || [ "$old_worker_drained" = true ] || [ "$router_swapped" = true ]; then restore; fi
      else
        echo "Cutover committed to $serving_bff; preserving its executors" >&2
      fi
    else
      echo 'Cannot establish committed route; preserving all executors for re-entry' >&2
    fi
  fi
  release_deploy_lock "$runtime_lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

healthy() {
  health_until=$(($(date +%s) + 180))
  while [ "$(date +%s)" -lt "$health_until" ]; do
    if [ "$(control "$1" "$2" GET /health ok 2>/dev/null || true)" = true ]; then return 0; fi
    sleep 2
  done
  echo "New instance $1 did not become healthy" >&2
  return 1
}

runtime() {
  role=$1
  name=$release-$role
  created="$created $name:$role"
  logged_docker create --name "$name" --init --restart unless-stopped \
    --label "app.runtime.project=$project" --label "app.runtime.role=$role" \
    --label "app.runtime.generation=$release" \
    --network "$network" --network-alias "$role-logs" --env-file "$app_env" \
    -e APP_ROLE="$role" -e DATABASE_POOL_MAX="$3" -e PORT=37377 -e STATIC_DIR= -e CLIENT_IP_SOURCE=cf-connecting-ip \
    -e WORKER_HEALTH_PORT=37379 -e WORKER_START_PAUSED=true \
    -e WORKER_ACTIVATION_FILE="/run/operator/releases/activated/$release-worker" \
    -e EXECUTOR_ORIGIN="http://$release-bff:37377" -e LEGACY_EXECUTOR_ORIGIN= \
    ${AGENT_SEGMENTER_URL:+-e "AGENT_SEGMENTER_URL=$AGENT_SEGMENTER_URL"} \
    ${AGENT_SEGMENTER_URL:+-e "AGENT_SEGMENTER_NAMESPACE=$project"} \
    --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
    "$image_id" bun run "/app/apps/bff/src/$2" >/dev/null
  docker network connect "$infra" "$name"
  docker start "$name" >/dev/null
}

start_router() {
  logged_docker run -d --name "$router" --init --restart unless-stopped --network "$network" \
    --network-alias release-router --entrypoint bun \
    --mount "type=bind,source=$state_dir,target=/run/release,readonly" \
    "$image_id" run /app/scripts/release-router.ts >/dev/null
}

if [ -e "$state_dir/route.json" ]; then
  load_route || { echo 'Cannot establish route.json ownership; rollout stopped' >&2; exit 1; }
else
  [ ! -e "$state_dir/current" ] || { echo 'current exists without route.json; rollout stopped' >&2; exit 1; }
  untracked=$(docker_probe ps -a --filter "label=app.runtime.project=$project" --format '{{.Names}}')
  [ -z "$untracked" ] || { echo 'Runtime executors exist without route.json; preserving all instances' >&2; exit 1; }
  serving_bff=$project-bff-1
  serving_worker=$project-worker-1
  executor_snapshot "$serving_bff" bff >/dev/null
  executor_snapshot "$serving_worker" worker >/dev/null
  printf '{"origin":"http://%s:37377","worker":"%s"}\n' "$serving_bff" "$serving_worker" > "$state_dir/route.json.next"
  mv "$state_dir/route.json.next" "$state_dir/route.json"
fi
old_bff=$serving_bff
old_worker=$serving_worker
state_known=true
write_current
# Re-entry after an interrupted handover restores the generation the router actually serves.
control "$old_bff" 37377 GET /internal/deployment/drain retirement >/dev/null || {
  echo 'Cannot establish current BFF drain protocol; legacy flags cannot bypass this check' >&2; exit 1;
}
control "$old_worker" 37379 GET /internal/deployment/drain retirement >/dev/null || {
  echo 'Cannot establish current worker drain protocol; rollout stopped' >&2; exit 1;
}
docker_probe update --restart=unless-stopped "$old_bff" "$old_worker" >/dev/null
touch "$state_dir/activated/$old_worker"
[ "$(control "$old_worker" 37379 POST /internal/deployment/resume ok)" = true ] || exit 1

if [ -f "$state_dir/legacy-origin" ]; then
  [ "$(cat "$state_dir/legacy-origin")" = "http://$project-bff-1:37377" ] || { echo 'Unknown legacy origin; rollout stopped' >&2; exit 1; }
fi
collect_noncurrent
retire_pending 0
if [ -f "$state_dir/legacy-origin" ]; then
  case "$pending" in
    *" $project-bff-1:bff"*|*" $project-worker-1:worker"*) ;;
    *) rm -f "$state_dir/legacy-origin" ;;
  esac
fi
old_image=$(docker_probe inspect --format '{{.Image}}' "$old_bff")
old_worker_image=$(docker_probe inspect --format '{{.Image}}' "$old_worker")
if [ "$old_image" = "$image_id" ] && [ "$old_worker_image" = "$image_id" ]; then
  healthy "$old_bff" 37377
  healthy "$old_worker" 37379
  new_bff=$old_bff
  new_worker=$old_worker
  release=${old_bff%-bff}
  echo "Already serving $image_id; reconciling retained executors and ancillary services."
  retire_pending "$deadline"
else
  if [ -n "$pending" ]; then
    echo "deployment_capacity_blocked: retained executors prevent a third generation:$pending" >&2
    exit 1
  fi
  logged_docker run --rm --name "$release-migrate" --network "$infra" --env-file "$app_env" \
    --env-file "$config_dir/migrate.env" -e APP_ROLE=migrate \
    --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
    "$image_id" bun run /app/apps/bff/src/db/migrate.ts
  runtime bff index.ts 6
  healthy "$new_bff" 37377
  runtime worker worker-index.ts 4
  healthy "$new_worker" 37379
fi

# Router replacement changes client connections, never execution ownership.
if docker inspect "$router-retiring" >/dev/null 2>&1; then
  if docker inspect "$router" >/dev/null 2>&1; then
    docker stop -t 30 "$router-retiring" >/dev/null 2>&1 || true
    docker rm -f "$router-retiring" >/dev/null 2>&1 || true
  else
    docker rename "$router-retiring" "$router"
    docker start "$router" >/dev/null
  fi
fi
if ! docker inspect "$router" >/dev/null 2>&1; then
  start_router
elif [ "$(docker inspect --format '{{.Image}}' "$router")" != "$image_id" ]; then
  docker rename "$router" "$router-retiring"
  router_swapped=true
  start_router
fi
healthy "$router" 37377
if [ "$router_swapped" = true ]; then
  docker stop -t 30 "$router-retiring" >/dev/null 2>&1 || true
  docker rm -f "$router-retiring" >/dev/null 2>&1 || true
  router_swapped=false
fi
if [ ! -f "$state_dir/ingress-ready" ]; then
  if ! grep -q 'http://release-router:37377' "$config_dir/cloudflared/config.yml"; then
    if ! grep -q 'http://bff:37377' "$config_dir/cloudflared/config.yml"; then
      echo 'Unknown tunnel origin; ingress not changed' >&2
      exit 1
    fi
    cp "$config_dir/cloudflared/config.yml" "$state_dir/cloudflared-before-router.yml"
    sed 's#http://bff:37377#http://release-router:37377#g' \
      "$state_dir/cloudflared-before-router.yml" > "$config_dir/cloudflared/config.yml"
  fi
  docker restart "$project-cloudflared-1" >/dev/null
  touch "$state_dir/ingress-ready"
fi
if ! grep -q 'http://release-router:37377' "$config_dir/cloudflared/config.yml"; then
  echo 'Tunnel no longer targets the stable router; refusing cutover' >&2
  exit 1
fi

if [ "$new_bff" != "$old_bff" ]; then
  worker_before=$(executor_snapshot "$old_worker" worker)
  old_worker_restart=$(printf '%s\n' "$worker_before" | awk '{print $5}')
  old_worker_drained=true
  docker_probe update --restart=no "$old_worker" >/dev/null
  rm -f "$state_dir/activated/$old_worker"
  if [ "$(control "$old_worker" 37379 POST /internal/deployment/drain draining)" != true ]; then
    echo "$old_worker did not acknowledge drain; refusing cutover" >&2
    exit 1
  fi
  touch "$state_dir/activated/$new_worker"
  [ "$(control "$new_worker" 37379 POST /internal/deployment/resume ok)" = true ] || exit 1
  printf '{"origin":"http://%s:37377","worker":"%s"}\n' "$new_bff" "$new_worker" > "$state_dir/route.json.next"
  mv "$state_dir/route.json.next" "$state_dir/route.json"
  serving_bff=$new_bff
  serving_worker=$new_worker
  write_current
  collect_noncurrent
  retire_pending "$deadline"
fi
echo "Active: $release. Retained executors:$pending"

# Ancillary services have no generation execution state. Their writes use the stable ingress.
# Compose admin owns the tunnel name `admin` again. --wait returns only after its healthcheck
# passes, so the name is already answering before the leftover proxy is stopped.
APP_IMAGE=$image_id APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
  "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps --wait admin
APP_IMAGE=$image_id APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
  "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps \
  host-collector pg-backup
# A previous rollout may have left a proxy holding `admin`, and release-qualified admin
# processes from that rollout. Those names are `$project-r<time>-<pid>-admin`; the Compose
# service is `$project-admin-1` and does not match. Removal has to stick: a proxy that is
# still there keeps the tunnel name alongside the Compose service.
remove_stale_admin() {
  if ! docker inspect "$1" >/dev/null 2>&1; then return 0; fi
  docker stop -t 30 "$1" >/dev/null 2>&1 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
  if docker inspect "$1" >/dev/null 2>&1; then
    echo "Could not remove stale admin container $1" >&2
    return 1
  fi
}
for extra in \
  "$project-admin-proxy" \
  "$project-admin-proxy-next" \
  "$project-admin-proxy-previous" \
  "$project-admin-proxy-dead"
do
  remove_stale_admin "$extra" || exit 1
done
for name in $(docker ps -a --format '{{.Names}}'); do
  case "$name" in
    "$project"-r[0-9]*-admin) remove_stale_admin "$name" || exit 1 ;;
  esac
done
rm -rf "$state_dir/admin-proxy"
rm -f "$state_dir/admin-pending" "$state_dir/admin-upstream" "$state_dir/admin-retire"
# Recreating a running connector closes its edge connections ("connection with edge closed",
# "client disconnected"). The image is pinned and the logging driver is already attached;
# a stopped connector is the only reason to start it again. Bumping the image tag requires
# removing this container so the next rollout creates it.
if [ "$(docker inspect --format '{{.State.Running}}' "$project-cloudflared-1" 2>/dev/null || true)" != true ]; then
  APP_IMAGE=$image_id APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
    "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps cloudflared
fi
