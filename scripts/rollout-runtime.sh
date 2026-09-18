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
retire_legacy=${DEPLOY_RETIRE_LEGACY:-0}
case "$deadline$grace" in *[!0-9]*) echo 'DEPLOY_DRAIN_DEADLINE_SECONDS and DEPLOY_STOP_GRACE_SECONDS take whole seconds' >&2; exit 2 ;; esac
if [ "$(docker image inspect --format '{{index .Config.Labels "app.execution-protocol"}}' "$image")" != 1 ]; then
  echo 'Image does not support executor-preserving deployment; refusing rollout/rollback' >&2
  exit 1
fi
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=${APP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps/$project}
state_dir=$config_dir/releases
mkdir -p "$state_dir/activated"
if ! mkdir "$state_dir/lock" 2>/dev/null; then echo "Another rollout owns $state_dir/lock" >&2; exit 1; fi

app_env=$config_dir/app.env
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
  docker create --name "$name" --init --restart unless-stopped \
    --label "app.runtime.project=$project" --label "app.runtime.role=$role" \
    --network "$network" --env-file "$app_env" \
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
  docker run -d --name "$router" --init --restart unless-stopped --network "$network" \
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
docker run --rm --network "$infra" --env-file "$app_env" \
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
APP_IMAGE=$image APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
  "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps \
  admin host-collector pg-backup
