#!/bin/sh
set -eu

# Runtime instances are immutable. Never compose-up an existing BFF/worker during a release.
project=${1:?project required}
image=${2:?image required}
case "$project" in *[!a-zA-Z0-9_-]*|'') echo 'Invalid project name' >&2; exit 2 ;; esac
if [ "$(docker image inspect --format '{{index .Config.Labels "app.execution-protocol"}}' "$image")" != 1 ]; then
  echo 'Image does not support executor-preserving deployment; refusing rollout/rollback' >&2
  exit 1
fi
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_dir=${APP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/apps/$project}
state_dir=$config_dir/releases
mkdir -p "$state_dir/activated"
if ! mkdir "$state_dir/lock" 2>/dev/null; then echo "Another rollout owns $state_dir/lock" >&2; exit 1; fi
legacy_gated=false
switched=false
cleanup() {
  if [ "$switched" = false ] && [ "$legacy_gated" = true ]; then
    control "$release-bff" 37377 POST /internal/deployment/legacy-resume ok >/dev/null || true
  fi
  rmdir "$state_dir/lock"
}
trap cleanup EXIT
app_env=$config_dir/app.env
network=${project}_application
infra=${INFRA_NETWORK_NAME:-image-playground-infra}
release=$project-r$(date -u +%Y%m%d%H%M%S)-$$
old_bff=$project-bff-1
old_worker=$project-worker-1
legacy_origin=
if [ -f "$state_dir/current" ]; then
  read -r old_bff old_worker < "$state_dir/current"
fi
if [ -f "$state_dir/legacy-origin" ]; then legacy_origin=$(cat "$state_dir/legacy-origin"); fi

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

healthy() {
  remaining=90
  while [ "$remaining" -gt 0 ]; do
    if [ "$(control "$1" "$2" GET /health ok 2>/dev/null || true)" = true ]; then return 0; fi
    sleep 2
    remaining=$((remaining - 1))
  done
  echo "New instance $1 did not become healthy; existing instances retained" >&2
  return 1
}

wait_idle() {
  waited=0
  limit=${DEPLOY_DRAIN_WAIT_SECONDS:-1800}
  while [ "$(control "$1" "$2" GET "$3" safeToStop)" != true ]; do
    if [ "$waited" -ge "$limit" ]; then
      echo "Drain remains active: $1. Retained without cancellation; rerun cleanup after completion." >&2
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

runtime() {
  role=$1
  name=$release-$role
  docker create --name "$name" --init --restart unless-stopped \
    --label "app.runtime.project=$project" --label "app.runtime.role=$role" \
    --network "$network" --env-file "$app_env" \
    -e APP_ROLE="$role" -e PORT=37377 -e STATIC_DIR= -e CLIENT_IP_SOURCE=cf-connecting-ip \
    -e WORKER_HEALTH_PORT=37379 -e WORKER_START_PAUSED=true \
    -e WORKER_ACTIVATION_FILE="/run/operator/releases/activated/$release-worker" \
    -e EXECUTOR_ORIGIN="http://$release-bff:37377" \
    -e LEGACY_EXECUTOR_ORIGIN="$legacy_origin" \
    --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
    "$image" bun run "/app/apps/bff/src/$2" >/dev/null
  docker network connect "$infra" "$name"
  docker start "$name" >/dev/null
}

# A missing drain endpoint is an explicit legacy case; authentication/network failures are not.
legacy=false
if control "$old_bff" 37377 GET /internal/deployment/drain draining >/dev/null; then :
else
  result=$?
  if [ "$result" -ne 44 ]; then echo 'Cannot establish old BFF state; rollout stopped' >&2; exit 1; fi
  legacy=true
  legacy_origin=http://$old_bff:37377
  printf '%s\n' "$legacy_origin" > "$state_dir/legacy-origin"
fi

# Additive migrations are applied without touching any live application container.
docker run --rm --network "$infra" --env-file "$app_env" \
  --env-file "$config_dir/migrate.env" -e APP_ROLE=migrate \
  --mount "type=bind,source=$config_dir,target=/run/operator,readonly" \
  "$image" bun run /app/apps/bff/src/db/migrate.ts
runtime bff index.ts
healthy "$release-bff" 37377
runtime worker worker-index.ts
healthy "$release-worker" 37379

if [ "$legacy" = true ]; then
  control "$release-bff" 37377 POST /internal/deployment/legacy-drain ok >/dev/null
  legacy_gated=true
  # New worker remains paused until the non-fenced legacy executor has finished.
  wait_idle "$release-bff" 37377 /internal/deployment/legacy-drain
  docker stop "$old_worker" >/dev/null
  legacy_gated=false
else
  # Stop every supported old worker from claiming before the new worker is activated. Their
  # in-flight promises keep running; the cleanup phase below waits for safeToStop before stopping.
  for previous in $(docker ps --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=worker --format '{{.Names}}'); do
    [ "$previous" = "$release-worker" ] && continue
    if [ -f "$state_dir/activated/$previous" ]; then unlink "$state_dir/activated/$previous"; fi
    control "$previous" 37379 POST /internal/deployment/drain draining >/dev/null
  done
  if [ "$old_bff" = "$project-bff-1" ]; then
    control "$old_worker" 37379 POST /internal/deployment/drain draining >/dev/null
  fi
fi

touch "$state_dir/activated/$release-worker"
control "$release-worker" 37379 POST /internal/deployment/resume ok >/dev/null

router=$project-release-router
if ! docker inspect "$router" >/dev/null 2>&1; then
  printf '{"origin":"http://%s:37377"}\n' "$old_bff" > "$state_dir/route.json"
  docker run -d --name "$router" --init --restart unless-stopped --network "$network" \
    --network-alias release-router --entrypoint bun \
    --mount "type=bind,source=$state_dir,target=/run/release,readonly" \
    "$image" run /app/scripts/release-router.ts >/dev/null
fi
healthy "$router" 37377
if [ ! -f "$state_dir/ingress-ready" ]; then
  if ! grep -q 'http://release-router:37377' "$config_dir/cloudflared/config.yml"; then
    if ! grep -q 'http://bff:37377' "$config_dir/cloudflared/config.yml"; then
      echo 'Unknown tunnel origin; executors retained, ingress not changed' >&2
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

printf '{"origin":"http://%s:37377"}\n' "$release-bff" > "$state_dir/route.json.next"
mv "$state_dir/route.json.next" "$state_dir/route.json"
printf '%s %s\n' "$release-bff" "$release-worker" > "$state_dir/current.next"
mv "$state_dir/current.next" "$state_dir/current"
switched=true
printf '%s %s\n' "$old_bff" "$old_worker" >> "$state_dir/retained"

if [ "$legacy" = true ]; then
  echo "Legacy BFF $old_bff retained for pre-migration conversations."
fi
# Include instances retained by an interrupted earlier rollout, not just the previous current.
for previous in $(docker ps --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=worker --format '{{.Names}}'); do
  [ "$previous" = "$release-worker" ] && continue
  if [ -f "$state_dir/activated/$previous" ]; then unlink "$state_dir/activated/$previous"; fi
  control "$previous" 37379 POST /internal/deployment/drain draining >/dev/null
  wait_idle "$previous" 37379 /internal/deployment/drain
  docker stop "$previous" >/dev/null
 done
for previous in $(docker ps --filter "label=app.runtime.project=$project" --filter label=app.runtime.role=bff --format '{{.Names}}'); do
  [ "$previous" = "$release-bff" ] && continue
  control "$previous" 37377 POST /internal/deployment/drain draining >/dev/null
  wait_idle "$previous" 37377 /internal/deployment/drain
  docker stop "$previous" >/dev/null
 done
# A protocol-aware Compose instance predating the release labels also needs draining.
if [ "$legacy" = false ] && [ "$old_bff" = "$project-bff-1" ]; then
  control "$old_worker" 37379 POST /internal/deployment/drain draining >/dev/null
  control "$old_bff" 37377 POST /internal/deployment/drain draining >/dev/null
  wait_idle "$old_worker" 37379 /internal/deployment/drain
  wait_idle "$old_bff" 37377 /internal/deployment/drain
  docker stop "$old_worker" "$old_bff" >/dev/null
fi
echo "Active: $release. All observable previous executors drained."

# Ancillary services have no generation execution state. Their writes use the stable ingress.
APP_IMAGE=$image APP_ENV_FILE=$app_env BFF_INTERNAL_URL=http://release-router:37377 \
  "$repo_root/scripts/app-compose.sh" compose "$project" up --detach --no-deps \
  admin host-collector pg-backup
