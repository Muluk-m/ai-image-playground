#!/bin/sh
set -eu

# Runtime instances are immutable. Never compose-up an existing BFF/worker during a release.
#
# Finite drain (ADR 0009, superseded in part on 2026-09-18): an edition runs at most two
# generations, the one serving and the one being rolled out. After the cutover the previous
# generation drains for at most DEPLOY_DRAIN_DEADLINE_SECONDS and is then stopped (SIGTERM with
# DEPLOY_STOP_GRACE_SECONDS of grace) and removed. Work cut off by the stop is recovered by the
# execution leases, the upstream task-id recovery scan and the resume of an interrupted turn.
#
# DEPLOY_RETIRE_LEGACY=1 runs the one-time retirement of the pre-protocol Compose executor recorded
# in releases/legacy-origin: the new generation owns generation-0 conversations itself, and the
# legacy BFF/worker are stopped and removed after the cutover.
project=${1:?project required}
image=${2:?image required}
case "$project" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid project name' >&2; exit 2 ;; esac
deadline=${DEPLOY_DRAIN_DEADLINE_SECONDS:-300}
grace=${DEPLOY_STOP_GRACE_SECONDS:-75}
proxy_wait=${ADMIN_PROXY_WAIT_SECONDS:-30}
retire_legacy=${DEPLOY_RETIRE_LEGACY:-0}
case "$deadline$grace$proxy_wait" in
  *[!0-9]*) echo 'DEPLOY_DRAIN_DEADLINE_SECONDS, DEPLOY_STOP_GRACE_SECONDS and ADMIN_PROXY_WAIT_SECONDS take whole seconds' >&2; exit 2 ;;
esac
if [ "$proxy_wait" -lt 1 ]; then
  echo 'ADMIN_PROXY_WAIT_SECONDS must be at least 1' >&2
  exit 2
fi
if [ "$(docker image inspect --format '{{index .Config.Labels "app.execution-protocol"}}' "$image")" != 1 ]; then
  echo 'Image does not support executor-preserving deployment; refusing rollout/rollback' >&2
  exit 1
fi
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=${APP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps/$project}
state_dir=$config_dir/releases
mkdir -p "$state_dir/activated"

app_env=$config_dir/app.env
# Docker's daemon dials the same Unix socket configured by app-compose.sh.
log_forward_dir=${LOG_FORWARD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/log-forward/$project}
mkdir -p "$log_forward_dir"
if ! mkdir "$state_dir/lock" 2>/dev/null; then echo "Another rollout owns $state_dir/lock" >&2; exit 1; fi

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
network=${project}_application
infra=${INFRA_NETWORK_NAME:-image-playground-infra}
release=$project-r$(date -u +%Y%m%d%H%M%S)-$$
new_bff=$release-bff
new_worker=$release-worker
router=$project-release-router

# What this run changed before the cutover, so a failure can put it back.
created=
drained_workers=
reactivate=
legacy_gated=false
legacy_worker_stopped=false
router_swapped=false
switched=false

control() {
  docker exec "$1" bun -e '
    const [port, method, path, field] = Bun.argv.slice(-4);
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {method,
      headers: {authorization: `Bearer ${process.env.INTERNAL_API_TOKEN || ""}`},
      signal: AbortSignal.timeout(5000)});
    if (!r.ok) process.exit(r.status === 404 ? 44 : 1);
    const value = (await r.json())[field];
    if (value === undefined) process.exit(1);
    console.log(String(value));
  ' "$2" "$3" "$4" "$5"
}

restore() {
  echo "Rollout failed before cutover; restoring the previous generation." >&2
  if [ "$legacy_gated" = true ]; then
    control "$new_bff" 37377 POST /internal/deployment/legacy-resume ok >/dev/null ||
      echo "Warning: could not reopen legacy claims through $new_bff" >&2
  fi
  rm -f "$state_dir/activated/$new_worker"
  if [ -n "$created" ]; then
    docker stop -t "$grace" $created >/dev/null 2>&1
    docker rm -f $created >/dev/null 2>&1
    echo "Removed the instances this run created:$created" >&2
  fi
  if [ "$router_swapped" = true ]; then
    docker rm -f "$router" >/dev/null 2>&1
    docker rename "$router-retiring" "$router" && docker start "$router" >/dev/null
  fi
  if [ "$legacy_worker_stopped" = true ]; then docker start "$old_worker" >/dev/null; fi
  for worker in $reactivate; do touch "$state_dir/activated/$worker"; done
  for worker in $drained_workers; do
    control "$worker" 37379 POST /internal/deployment/resume ok >/dev/null ||
      echo "Warning: could not resume $worker" >&2
  done
}

cleanup() {
  status=$?
  set +e
  if [ "$status" -ne 0 ] && [ "$switched" = false ]; then restore; fi
  rmdir "$state_dir/lock"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

healthy() {
  remaining=90
  while [ "$remaining" -gt 0 ]; do
    if [ "$(control "$1" "$2" GET /health ok 2>/dev/null || true)" = true ]; then return 0; fi
    sleep 2
    remaining=$((remaining - 1))
  done
  echo "New instance $1 did not become healthy" >&2
  return 1
}

# $3 is the role's DATABASE_POOL_MAX; keep it equal to deploy/compose.app.yaml.
runtime() {
  role=$1
  name=$release-$role
  created="$created $name"
  logged_docker create --name "$name" --init --restart unless-stopped \
    --label "app.runtime.project=$project" --label "app.runtime.role=$role" \
    --network "$network" --network-alias "$role-logs" --env-file "$app_env" \
    -e APP_ROLE="$role" -e DATABASE_POOL_MAX="$3" -e PORT=37377 -e STATIC_DIR= -e CLIENT_IP_SOURCE=cf-connecting-ip \
    -e WORKER_HEALTH_PORT=37379 -e WORKER_START_PAUSED=true \
    -e WORKER_ACTIVATION_FILE="/run/operator/releases/activated/$release-worker" \
    -e EXECUTOR_ORIGIN="http://$release-bff:37377" \
    -e LEGACY_EXECUTOR_ORIGIN="$runtime_legacy_origin" \
    --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
    "$image" bun run "/app/apps/bff/src/$2" >/dev/null
  docker network connect "$infra" "$name"
  docker start "$name" >/dev/null
}

start_router() {
  logged_docker run -d --name "$router" --init --restart unless-stopped --network "$network" \
    --network-alias release-router --entrypoint bun \
    --mount "type=bind,source=$state_dir,target=/run/release,readonly" \
    "$image" run /app/scripts/release-router.ts >/dev/null
}

# --- Preflight: only the generation named in `current` may survive into this rollout. ---------
old_bff=
old_worker=
if [ -f "$state_dir/current" ]; then read -r old_bff old_worker < "$state_dir/current"; fi
legacy_origin=
if [ -f "$state_dir/legacy-origin" ]; then legacy_origin=$(cat "$state_dir/legacy-origin"); fi

# An interrupted router replacement leaves the serving router under its temporary name.
if docker inspect "$router-retiring" >/dev/null 2>&1; then
  if docker inspect "$router" >/dev/null 2>&1; then
    docker stop -t 30 "$router-retiring" >/dev/null 2>&1 || true
    docker rm -f "$router-retiring" >/dev/null 2>&1 || true
  else
    docker rename "$router-retiring" "$router"
    docker start "$router" >/dev/null
  fi
fi

leftovers=
for name in $(docker ps -a --filter "label=app.runtime.project=$project" --format '{{.Names}}'); do
  if [ "$name" != "$old_bff" ] && [ "$name" != "$old_worker" ]; then leftovers="$leftovers $name"; fi
done
if [ -n "$leftovers" ]; then
  # Earlier rollouts already gave these their drain; they are not probed, so a dead one cannot
  # block this rollout.
  echo "Removing executors left by earlier rollouts:$leftovers"
  docker stop -t "$grace" $leftovers >/dev/null 2>&1 || true
  docker rm -f $leftovers >/dev/null 2>&1 || echo "Warning: could not remove every leftover executor" >&2
fi
for marker in "$state_dir"/activated/*; do
  [ -e "$marker" ] || continue
  [ "$(basename -- "$marker")" = "$old_worker" ] || rm -f "$marker"
done
rm -f "$state_dir/retained"

# --- Previous generation and the legacy executor -----------------------------------------------
legacy_first=false
compose_generation=false
if [ -z "$old_bff" ]; then
  # Never released through this script: the previous executors are the Compose containers.
  old_bff=$project-bff-1
  old_worker=$project-worker-1
  # A missing drain endpoint is an explicit legacy case; authentication/network failures are not.
  if control "$old_bff" 37377 GET /internal/deployment/drain draining >/dev/null; then
    compose_generation=true
  else
    result=$?
    if [ "$result" -ne 44 ]; then echo 'Cannot establish old BFF state; rollout stopped' >&2; exit 1; fi
    legacy_first=true
    legacy_origin=http://$old_bff:37377
  fi
fi
legacy_bff=
legacy_worker=
if [ -n "$legacy_origin" ]; then
  legacy_bff=${legacy_origin#http://}
  legacy_bff=${legacy_bff%:37377}
  legacy_worker=$project-worker-1
fi
runtime_legacy_origin=$legacy_origin
if [ "$retire_legacy" = 1 ]; then
  if [ -z "$legacy_origin" ]; then
    echo "No legacy executor recorded for $project; nothing to retire."
    retire_legacy=0
  else
    echo "Retiring legacy executor $legacy_bff: the new generation takes over generation-0 conversations."
    runtime_legacy_origin=
  fi
fi

# --- New generation ---------------------------------------------------------------------------
# Additive migrations are applied without touching any live application container.
logged_docker run --rm --name "$release-migrate" --network "$infra" --env-file "$app_env" \
  --env-file "$config_dir/migrate.env" -e APP_ROLE=migrate \
  --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
  "$image" bun run /app/apps/bff/src/db/migrate.ts
runtime bff index.ts 6
healthy "$new_bff" 37377
runtime worker worker-index.ts 4
healthy "$new_worker" 37379

# --- Stable ingress, prepared while it still routes to the previous generation ----------------
if ! docker inspect "$router" >/dev/null 2>&1; then
  printf '{"origin":"http://%s:37377"}\n' "$old_bff" > "$state_dir/route.json"
  start_router
elif [ "$(docker inspect --format '{{.Config.Image}}' "$router")" != "$image" ]; then
  # The router re-reads route.json per request, so a replacement changes nothing but its code.
  # Both share the alias while the new one starts; requests still in flight through the old one
  # are cut when it stops, and clients reconnect.
  docker rename "$router" "$router-retiring"
  router_swapped=true
  start_router
fi
healthy "$router" 37377
if [ "$router_swapped" = true ]; then
  docker stop -t 30 "$router-retiring" >/dev/null 2>&1 || true
  docker rm -f "$router-retiring" >/dev/null 2>&1 || true
  router_swapped=false
  echo "Release router now runs $image."
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

# --- Hand claiming over to the new worker -----------------------------------------------------
if [ "$legacy_first" = true ]; then
  legacy_gated=true
  control "$new_bff" 37377 POST /internal/deployment/legacy-drain ok >/dev/null
  # The legacy worker has no fencing; the new worker stays paused until its tasks finish.
  waited=0
  until [ "$(control "$new_bff" 37377 GET /internal/deployment/legacy-drain safeToStop 2>/dev/null || true)" = true ]; do
    if [ "$waited" -ge "$deadline" ]; then
      echo "Legacy worker $old_worker still has in-flight tasks after ${deadline}s" >&2
      exit 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  docker stop -t "$grace" "$old_worker" >/dev/null
  legacy_worker_stopped=true
else
  old_workers=$(docker ps --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=worker --format '{{.Names}}')
  if [ "$compose_generation" = true ]; then old_workers="$old_workers $old_worker"; fi
  for worker in $old_workers; do
    [ "$worker" = "$new_worker" ] && continue
    if [ -f "$state_dir/activated/$worker" ]; then
      unlink "$state_dir/activated/$worker"
      reactivate="$reactivate $worker"
    fi
    drained_workers="$drained_workers $worker"
    control "$worker" 37379 POST /internal/deployment/drain draining >/dev/null 2>&1 ||
      echo "Warning: $worker did not acknowledge the drain; it is stopped after the cutover" >&2
  done
fi
touch "$state_dir/activated/$new_worker"
control "$new_worker" 37379 POST /internal/deployment/resume ok >/dev/null

# --- Cutover ----------------------------------------------------------------------------------
printf '{"origin":"http://%s:37377"}\n' "$new_bff" > "$state_dir/route.json.next"
mv "$state_dir/route.json.next" "$state_dir/route.json"
printf '%s %s\n' "$new_bff" "$new_worker" > "$state_dir/current.next"
mv "$state_dir/current.next" "$state_dir/current"
switched=true
if [ "$legacy_first" = true ] && [ "$retire_legacy" != 1 ]; then
  printf '%s\n' "$legacy_origin" > "$state_dir/legacy-origin"
  echo "Legacy BFF $legacy_bff kept for generation-0 conversations; retire it with DEPLOY_RETIRE_LEGACY=1."
fi

# --- Retire the previous generation: finite drain, then forced stop ---------------------------
# Nothing below may abort the rollout: the new generation is already serving.
retiring=
for name in $(docker ps -a --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=worker --format '{{.Names}}'); do
  [ "$name" = "$new_worker" ] || retiring="$retiring $name:37379"
done
for name in $(docker ps -a --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=bff --format '{{.Names}}'); do
  [ "$name" = "$new_bff" ] || retiring="$retiring $name:37377"
done
# A protocol-aware Compose generation predating the release labels drains the same way.
if [ "$compose_generation" = true ]; then retiring="$retiring $old_worker:37379 $old_bff:37377"; fi

for entry in $retiring; do
  control "${entry%:*}" "${entry##*:}" POST /internal/deployment/drain draining >/dev/null 2>&1 || true
done
pending=$retiring
clean=0
down=0
waited=0
while [ -n "$pending" ]; do
  still=
  for entry in $pending; do
    name=${entry%:*}
    if [ "$(control "$name" "${entry##*:}" GET /internal/deployment/drain safeToStop 2>/dev/null || true)" = true ]; then
      clean=$((clean + 1))
    elif [ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null || true)" != true ]; then
      down=$((down + 1))
    else
      still="$still $entry"
    fi
  done
  pending=$still
  if [ -z "$pending" ] || [ "$waited" -ge "$deadline" ]; then break; fi
  sleep 5
  waited=$((waited + 5))
done
forced=0
if [ -n "$pending" ]; then
  names=
  for entry in $pending; do names="$names ${entry%:*}"; forced=$((forced + 1)); done
  echo "Drain deadline (${deadline}s) reached; stopping$names. Interrupted work is recovered by lease expiry and resume." >&2
fi
stop_names=
for entry in $retiring; do
  name=${entry%:*}
  stop_names="$stop_names $name"
  if [ "${entry##*:}" = 37377 ] &&
    [ "$(control "$name" 37377 GET /internal/deployment/drain failed 2>/dev/null || true)" = true ]; then
    echo "Warning: $name recorded a failed durable settlement; the recovery scan seals its turns. Check its logs now." >&2
  fi
done
if [ -n "$stop_names" ]; then
  docker stop -t "$grace" $stop_names >/dev/null 2>&1 || true
  docker rm -f $stop_names >/dev/null 2>&1 || echo "Warning: could not remove every previous executor; the next rollout removes them" >&2
fi
for marker in "$state_dir"/activated/*; do
  [ -e "$marker" ] || continue
  [ "$(basename -- "$marker")" = "$new_worker" ] || rm -f "$marker"
done
echo "Active: $release. Previous executors: $clean drained cleanly, $forced stopped after the ${deadline}s drain deadline, $down already down."

if [ "$retire_legacy" = 1 ]; then
  # No drain introspection exists in the legacy binary. It has received no generation-0 work since
  # the previous generation stopped forwarding to it; SIGTERM gives it the grace to finish.
  docker stop -t "$grace" "$legacy_bff" "$legacy_worker" >/dev/null 2>&1 || true
  docker rm -f "$legacy_bff" "$legacy_worker" >/dev/null 2>&1 || true
  rm -f "$state_dir/legacy-origin"
  echo "Legacy executor $legacy_bff retired; generation-0 conversations now run on $release."
fi

# Ancillary services have no generation execution state. Their writes use the stable ingress.
# cloudflared calls http://admin:37378. That name stays on a proxy. A new Admin is started
# without the name, on the database network, and is published to the proxy only after it
# answers /health. nginx reload keeps the proxy's old workers on the previous backend until
# their requests finish; the previous container is then stopped, not killed.
admin_running() {
  [ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" = true ]
}

write_admin_proxy_conf() {
  upstream=$1
  dest=$2
  mkdir -p "$state_dir/admin-proxy"
  cat > "$dest" <<EOF
worker_processes 1;
error_log /dev/stderr warn;
pid /tmp/admin-proxy.pid;
events { worker_connections 128; }
http {
  access_log off;
  server {
    listen 37378;
    resolver 127.0.0.11 valid=1s ipv6=off;
    set \$upstream ${upstream};
    location / {
      proxy_pass http://\$upstream:37378;
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_read_timeout 90s;
    }
  }
}
EOF
}

start_admin_instance() {
  deployments_log=${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/deployments.log
  [ -f "$deployments_log" ] || deployments_log=/dev/null
  # Database network only at create. The application network is attached before
  # start, still without the admin alias: Admin asks release-router for
  # /api/capabilities before it listens, and cloudflared must not see this
  # process until the proxy is reloaded onto it.
  # The health command is the same one Compose runs: after repeated failures it
  # kills the application process so restart policy can bring it back.
  logged_docker create --name "$1" --init --restart unless-stopped \
    --network "$infra" \
    --health-cmd "bun run /app/apps/bff/src/container-healthcheck.ts http://127.0.0.1:37378/health /tmp/admin-health.json 12 3 60000" \
    --health-interval 10s --health-timeout 5s --health-retries 12 --health-start-period 15s \
    --env-file "$app_env" \
    -e APP_ROLE=admin -e PORT=37378 -e DATABASE_POOL_MAX=3 \
    -e OPS_DEPLOYMENTS_LOG=/host/deployments.log \
    -e BFF_INTERNAL_URL=http://release-router:37377 \
    --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
    --mount "type=bind,source=$deployments_log,target=/host/deployments.log,readonly" \
    "$image" bun run /app/apps/admin/server/index.ts >/dev/null || return 1
  if ! docker network connect "$network" "$1"; then
    docker rm -f "$1" >/dev/null 2>&1 || true
    return 1
  fi
  docker start "$1" >/dev/null || {
    docker rm -f "$1" >/dev/null 2>&1 || true
    return 1
  }
}

# An earlier build of this proxy bind-mounted one file at /etc/admin-proxy.conf.
# Reload now uses the directory mount; a running container from that build does
# not have the new path, and retrying the same container cannot create it.
proxy_layout_current() {
  docker exec "$1" test -d /etc/admin-proxy >/dev/null 2>&1
}

# 0: the container now has this name. 2: it is still answering under the old one.
rename_admin_proxy() {
  source=$1
  target=$2
  attempts=0
  while [ "$attempts" -lt 5 ]; do
    docker rename "$source" "$target" && return 0
    attempts=$((attempts + 1))
    sleep 1
  done
  return 2
}

# A stand-in left behind by a failed rename. Adopting it is the only way back
# to the stable name; removing it would drop the admin alias.
adopt_admin_proxy() {
  proxy=$project-admin-proxy
  next=$project-admin-proxy-next
  if admin_running "$proxy" || ! admin_running "$next"; then return 0; fi
  # A stopped container still owns the stable name, so rename would fail and
  # the running stand-in would be left as the only ingress.
  if docker inspect "$proxy" >/dev/null 2>&1; then
    docker rm "$proxy" >/dev/null 2>&1 || return 2
  fi
  rename_admin_proxy "$next" "$proxy" || return 2
}

# The previous-name container is an already replaced proxy. Retire it only
# once the stable name is actually answering, not merely running.
retire_replaced_proxy() {
  proxy=$project-admin-proxy
  previous_proxy=$project-admin-proxy-previous
  if ! admin_running "$proxy"; then return 0; fi
  if ! docker inspect "$previous_proxy" >/dev/null 2>&1; then return 0; fi
  if ! wait_proxy_answers "$proxy"; then
    # Stable is up but not listening. previous may be the only ingress.
    if ! admin_running "$previous_proxy" || ! wait_proxy_answers "$previous_proxy"; then
      return 2
    fi
    dead=$project-admin-proxy-dead
    docker rm -f "$dead" >/dev/null 2>&1 || true
    if ! docker rename "$proxy" "$dead"; then return 2; fi
    if ! rename_admin_proxy "$previous_proxy" "$proxy"; then
      docker rename "$dead" "$proxy" >/dev/null 2>&1 || return 2
      return 2
    fi
    docker stop -t 30 "$dead" >/dev/null 2>&1 || true
    docker rm "$dead" >/dev/null 2>&1 || true
    if docker inspect "$dead" >/dev/null 2>&1; then return 2; fi
    return 0
  fi
  if admin_running "$previous_proxy"; then
    docker stop -t 30 "$previous_proxy" >/dev/null 2>&1 || true
  fi
  docker rm "$previous_proxy" >/dev/null 2>&1 || true
  if docker inspect "$previous_proxy" >/dev/null 2>&1; then return 2; fi
}

ensure_admin_proxy() {
  proxy=$project-admin-proxy
  adopt_admin_proxy || return 2
  retire_replaced_proxy || return $?
  if admin_running "$proxy"; then
    proxy_layout_current "$proxy" && return 0
    replace_admin_proxy "$1" || return $?
    return 0
  fi
  docker rm -f "$proxy" >/dev/null 2>&1 || true
  write_admin_proxy_conf "$1" "$state_dir/admin-proxy/nginx.conf" || return 1
  # No ingress alias yet. cloudflared must not be able to reach this process
  # until it is actually listening.
  logged_docker run -d --name "$proxy" --init --restart unless-stopped \
    --network "$network" \
    --entrypoint nginx \
    --mount "type=bind,source=$state_dir/admin-proxy,target=/etc/admin-proxy,readonly" \
    "$image" -g 'daemon off;' -c /etc/admin-proxy/nginx.conf >/dev/null || return 1
  publish_listening_proxy "$proxy" || return 1
}

# 1: the previous proxy is still the one answering under the stable name.
# 2: the replacement is already answering as admin, but it could not be given
# the stable name. The caller must not delete the upstream that config names.
replace_admin_proxy() {
  proxy=$project-admin-proxy
  next=$project-admin-proxy-next
  previous_proxy=$project-admin-proxy-previous
  if admin_running "$next"; then
    docker stop -t 30 "$next" >/dev/null 2>&1 || true
  fi
  docker rm -f "$next" >/dev/null 2>&1 || true
  write_admin_proxy_conf "$1" "$state_dir/admin-proxy/nginx.conf" || return 1
  logged_docker run -d --name "$next" --init --restart unless-stopped \
    --network "$network" \
    --entrypoint nginx \
    --mount "type=bind,source=$state_dir/admin-proxy,target=/etc/admin-proxy,readonly" \
    "$image" -g 'daemon off;' -c /etc/admin-proxy/nginx.conf >/dev/null || return 1
  # The alias is attached only after nginx answers, and only while the old
  # proxy still has it too. A not-yet-listening process never owns the name.
  publish_listening_proxy "$next" || return 1
  # Free the stable name without stopping the process that is still answering.
  if ! docker rename "$proxy" "$previous_proxy"; then
    docker rm -f "$next" >/dev/null 2>&1 || true
    return 1
  fi
  if ! rename_admin_proxy "$next" "$proxy"; then
    if rename_admin_proxy "$previous_proxy" "$proxy"; then
      docker rm -f "$next" >/dev/null 2>&1 || true
      return 1
    fi
    return 2
  fi
  docker stop -t 30 "$previous_proxy" >/dev/null 2>&1 || true
  docker rm "$previous_proxy" >/dev/null 2>&1 || true
  # The old process still owns the admin alias until it is gone. Reporting
  # success here would let the rollout continue with two answers for the name.
  if docker inspect "$previous_proxy" >/dev/null 2>&1; then return 2; fi
}

# Attach the ingress alias without a long overlap. The container is already on
# the network so it can resolve its upstream; reconnect is only to add the alias
# and drops no client traffic, because this container was not the ingress yet.
publish_admin_alias() {
  docker network disconnect "$network" "$1" >/dev/null 2>&1 || return 1
  docker network connect --alias admin "$network" "$1" || return 1
}

# The container is already on the network so it can resolve its upstream, but it
# does not own the admin alias until nginx answers. Reconnect replaces the
# interface, so the alias stays only if the listener still answers afterwards.
publish_listening_proxy() {
  name=$1
  deadline=$(( $(date +%s) + proxy_wait ))
  if ! wait_proxy_answers "$name" "$deadline"; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi
  publish_admin_alias "$name" || {
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
  }
  if ! wait_proxy_answers "$name" "$deadline"; then
    docker rm -f "$name" >/dev/null 2>&1 || true
    return 1
  fi
}

proxy_answers() {
  probe=${PROXY_PROBE_SECONDS:-1}
  docker exec -e "PROXY_PROBE_SECONDS=$probe" "$1" bun -e '
    const seconds = Number(process.env.PROXY_PROBE_SECONDS || "1")
    const response = await fetch("http://127.0.0.1:37378/health", {
      signal: AbortSignal.timeout(Math.max(1, seconds) * 1000),
    })
    if (!response.ok) process.exit(1)
  ' >/dev/null 2>&1
}

# ADMIN_PROXY_WAIT_SECONDS is a deadline, not a retry count. One hung probe
# must not multiply it by the fetch timeout.
wait_proxy_answers() {
  name=$1
  if [ -n "${2:-}" ]; then
    deadline=$2
  else
    deadline=$(( $(date +%s) + proxy_wait ))
  fi
  while :; do
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || return 1
    left=$((deadline - now))
    if [ "$left" -gt 4 ]; then left=4; fi
    PROXY_PROBE_SECONDS=$left
    export PROXY_PROBE_SECONDS
    proxy_answers "$name" && return 0
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || return 1
    sleep 1
  done
}

reload_admin_proxy() {
  # Called from an OR list, which disables set -e for the whole function.
  # 1: the live file was not replaced. 2: it was replaced, but the reload
  # signal may or may not have landed.
  write_admin_proxy_conf "$1" "$state_dir/admin-proxy/nginx.conf.next" || return 1
  docker exec "$project-admin-proxy" nginx -t -c /etc/admin-proxy/nginx.conf.next >/dev/null || return 1
  mv "$state_dir/admin-proxy/nginx.conf.next" "$state_dir/admin-proxy/nginx.conf" || return 1
  # -c selects this proxy's config, whose pid path is /tmp/admin-proxy.pid.
  # Without it, nginx signals the default master and this process never reloads.
  docker exec "$project-admin-proxy" nginx -s reload -c /etc/admin-proxy/nginx.conf >/dev/null || return 2
}

# Prints how many worker processes the nginx master still has.
# The container uses --init, so pid 1 is docker-init and its only child is the
# master. Workers are children of the pid recorded in the proxy config.
proxy_switched() {
  probe=${PROXY_PROBE_SECONDS:-1}
  docker exec -e "PROXY_PROBE_SECONDS=$probe" "$project-admin-proxy" bun -e '
    const seconds = Number(process.env.PROXY_PROBE_SECONDS || "1")
    const response = await fetch("http://127.0.0.1:37378/health", {
      signal: AbortSignal.timeout(Math.max(1, seconds) * 1000),
    })
    if (!response.ok) process.exit(1)
    const pid = (await Bun.file("/tmp/admin-proxy.pid").text()).trim()
    if (!/^\d+$/.test(pid)) process.exit(1)
    const children = (await Bun.file(`/proc/${pid}/task/${pid}/children`).text()).trim().split(/\s+/).filter(Boolean)
    console.log(String(children.length))
  ' 2>/dev/null || return 1
}

wait_proxy_switched() {
  deadline=$(( $(date +%s) + proxy_wait ))
  while :; do
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || break
    left=$((deadline - now))
    if [ "$left" -gt 4 ]; then left=4; fi
    PROXY_PROBE_SECONDS=$left
    export PROXY_PROBE_SECONDS
    workers=$(proxy_switched || true)
    case "$workers" in
      '') ;;
      *[!0-9]*) return 0 ;;
      *) [ "$workers" -le 1 ] && return 0 ;;
    esac
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || break
    sleep 1
  done
  echo "Admin proxy did not finish switching" >&2
  return 1
}

proxy_config_names() {
  [ -f "$state_dir/admin-proxy/nginx.conf" ] &&
    grep -q "set \$upstream ${1};" "$state_dir/admin-proxy/nginx.conf"
}

# Stop with the same grace Compose gives Admin, then remove it. Do not disconnect
# the network first: that deletes the interface in-flight requests are still using.
stop_admin() {
  name=$1
  if ! docker inspect "$name" >/dev/null 2>&1; then return 0; fi
  if admin_running "$name"; then docker stop -t 30 "$name" >/dev/null 2>&1 || true; fi
  docker rm "$name" >/dev/null 2>&1 || true
}

replace_admin() {
  current=$project-admin-1
  proxy=$project-admin-proxy
  new=$release-admin
  upstream_file=$state_dir/admin-upstream
  # A failed rename leaves the live proxy under the temporary name. Adopt it
  # before deciding that nothing is answering, or this branch would start a
  # second ingress and abandon the one cloudflared is already using.
  adopt_admin_proxy || return 2
  if ! admin_running "$current" && ! admin_running "$proxy"; then
    # Nothing is answering yet. Compose may publish the name before listen;
    # there is no traffic to miss.
    APP_IMAGE=$image APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
      "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps --wait admin
    printf '%s\n' "$current" > "$upstream_file"
    return 0
  fi
  # A leftover overlap container still owns the ingress name. Retire it only
  # once the Compose instance is up, so a retry cannot skip it forever.
  if admin_running "$current" && docker inspect "$project-admin-next" >/dev/null 2>&1; then
    stop_admin "$project-admin-next"
  fi
  # An earlier attempt may have exited after creating the new process and before
  # recording it as the upstream. If the proxy config already names it, that
  # switch landed; adopt it. Otherwise it is an extra process and comes down.
  pending_file=$state_dir/admin-pending
  if [ -f "$pending_file" ]; then
    pending=$(cat "$pending_file")
    live=
    [ -f "$upstream_file" ] && live=$(cat "$upstream_file")
    if [ "$pending" != "$live" ]; then
      if proxy_config_names "$pending"; then
        # The proxy already follows pending. Remember the previous upstream:
        # overwriting the record without that would leave the old process running
        # and unnamed.
        if [ -n "$live" ] && [ "$live" != "$pending" ]; then
          printf '%s\n' "$live" >> "$state_dir/admin-retire"
        fi
        printf '%s\n' "$pending" > "$upstream_file"
      else
        stop_admin "$pending"
      fi
    fi
    rm -f "$pending_file"
  fi
  # Always start a new process. app.env (CORS, auth, frontend origin) changes
  # without an image change, and Compose's config hash is what used to notice.
  printf '%s\n' "$new" > "$pending_file"
  start_admin_instance "$new" || {
    rm -f "$pending_file"
    return 1
  }
  if ! healthy "$new" 37378; then
    stop_admin "$new"
    rm -f "$pending_file"
    return 1
  fi
  previous=$current
  if [ -f "$upstream_file" ]; then previous=$(cat "$upstream_file"); fi
  if ! admin_running "$previous"; then previous=$new; fi
  # Also when a proxy is already up: an older build mounted a single file and
  # cannot see the directory this reload uses. ensure replaces that container
  # only after the new one answers.
  ensure_status=0
  ensure_admin_proxy "$previous" || ensure_status=$?
  if [ "$ensure_status" != 0 ]; then
    # 1: the previous proxy is still answering. 2: a replacement proxy is
    # already answering, but not under the stable name. In both cases the
    # on-disk config may already name this process; deleting it leaves the
    # proxy aimed at a container that is gone.
    if ! proxy_config_names "$new"; then
      stop_admin "$new"
      rm -f "$pending_file"
    fi
    return 1
  fi
  reload_status=0
  reload_admin_proxy "$new" || reload_status=$?
  if [ "$reload_status" = 1 ]; then
    # nginx -t failed before the live file changed. This process is not in use.
    stop_admin "$new"
    rm -f "$pending_file"
    return 1
  fi
  if [ "$reload_status" != 0 ]; then
    # The live file already names this process. Removing it would leave the
    # proxy, including after its next start, aimed at a container that is gone.
    return 1
  fi
  if ! wait_proxy_switched; then
    # The reload was accepted, so the proxy may already be sending new requests
    # here. Deleting this container would point the proxy at nothing. Leave the
    # pending record; the next rollout adopts it and retires whatever is older.
    return 1
  fi
  if [ -f "$upstream_file" ]; then previous=$(cat "$upstream_file"); else previous=$current; fi
  if [ -n "$previous" ] && [ "$previous" != "$new" ]; then
    printf '%s\n' "$previous" >> "$state_dir/admin-retire"
  fi
  if [ -f "$state_dir/admin-retire" ]; then
    while read -r retiring || [ -n "$retiring" ]; do
      [ -n "$retiring" ] && [ "$retiring" != "$new" ] && stop_admin "$retiring"
    done < "$state_dir/admin-retire"
    rm -f "$state_dir/admin-retire"
  fi
  printf '%s\n' "$new" > "$upstream_file"
  rm -f "$pending_file"
}
replace_admin
APP_IMAGE=$image APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
  "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps \
  host-collector pg-backup
# Recreating a running connector closes its edge connections ("connection with edge closed",
# "client disconnected"). The image is pinned and the logging driver is already attached;
# a stopped connector is the only reason to start it again. Bumping the image tag requires
# removing this container so the next rollout creates it.
if [ "$(docker inspect --format '{{.State.Running}}' "$project-cloudflared-1" 2>/dev/null || true)" != true ]; then
  APP_IMAGE=$image APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
    "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps cloudflared
fi
