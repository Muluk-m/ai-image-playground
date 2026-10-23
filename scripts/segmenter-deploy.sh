#!/bin/sh
# The shared EdgeTAM segmenter: ONE container, `image-playground-segmenter`, for every edition. It
# is a separately versioned base component (deploy/segmenter/VERSION), not part of an app release:
#
#   scripts/segmenter-deploy.sh up <image> <version>
#     Only production releases (built from main) carry the image, and only they call this. When the
#     running container already has <version> and is healthy, nothing happens. Otherwise the new
#     version starts next to the old one as `image-playground-segmenter-next`; the old one keeps
#     serving until the new one answers its health check. Only then is every app network moved
#     over (alias `segmenter`), the old container stopped and kept as `image-playground-segmenter-
#     prev` for rollback, and the new one renamed. If the new one never gets healthy it is removed
#     and the old one is left exactly as it was; if the move fails halfway, every network is given
#     back to the old container before exiting.
#   scripts/segmenter-deploy.sh attach <project>
#     Attaches the shared container to <project>_application with the alias `segmenter`, and
#     removes a leftover per-environment instance (and then its network) that serves no app
#     network any more. Idempotent. Test releases only ever call this (and `healthy`): they never build, start,
#     restart or replace the segmenter.
#   scripts/segmenter-deploy.sh healthy
#     Succeeds when the shared container is running and healthy.
#   scripts/segmenter-deploy.sh current <version>
#     Succeeds when the shared container already runs <version> and is healthy.
set -eu

container='image-playground-segmenter'
next="$container-next"
prev="$container-prev"
own_network='image-playground-segmenter'
version_label='online.muvloom.segmenter.version'
# Instances from a short-lived per-environment layout; they would answer to the same alias.
split_instances="$container-test $container-prod"

usage() {
  echo "Usage: scripts/segmenter-deploy.sh up <image> <version> | attach <project> | healthy | current <version>" >&2
  exit 2
}

attached() {
  docker inspect "$1" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null || true
}

connect() {
  case " $(attached "$2") " in
    *" $1 "*) return 0 ;;
  esac
  docker network connect --alias segmenter "$1" "$2"
}

disconnect() {
  case " $(attached "$2") " in
    *" $1 "*) docker network disconnect "$1" "$2" ;;
  esac
}

exists() {
  docker inspect "$1" >/dev/null 2>&1
}

healthy() {
  [ "$(docker inspect "$1" --format '{{.State.Health.Status}}' 2>/dev/null || true)" = healthy ]
}

# Answers on /health from inside the container; polled so a new version does not wait for the
# first 30 s health interval.
answers() {
  docker exec "$1" node -e \
    "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
    >/dev/null 2>&1
}

start_next() {
  docker network inspect "$own_network" >/dev/null 2>&1 ||
    docker network create --internal "$own_network" >/dev/null
  # Stateless: no env file, no database, no credential, no published port, read-only root, and
  # only its own internal network until an app network is attached. One request at a time; the
  # model is unloaded after 10 idle minutes, but the process stays at about 450 MB RSS even then
  # (measured on the VPS), so plan for that, not for the bare Node runtime.
  docker run --detach --name "$next" --label "$version_label=$2" \
    --init --restart unless-stopped --read-only --tmpfs /tmp:size=16m \
    --memory 900m --memory-swap 900m --cpus 2 \
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
    --health-cmd "node -e \"fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))\"" \
    --health-interval 30s --health-timeout 5s --health-retries 3 --health-start-period 10s \
    --network "$own_network" "$1" >/dev/null
}

current() {
  exists "$container" && healthy "$container" &&
    [ "$(docker inspect "$container" --format "{{index .Config.Labels \"$version_label\"}}")" = "$1" ]
}

up() {
  image=$1
  version=$2
  if current "$version"; then
    echo "segmenter $version already running"
    return 0
  fi
  # A leftover candidate from an interrupted run is ours and never served traffic.
  if exists "$next"; then docker rm -f "$next" >/dev/null; fi
  start_next "$image" "$version"
  waited=0
  until answers "$next"; do
    if [ "$waited" -ge "${SEGMENTER_START_TIMEOUT:-180}" ] ||
      [ "$(docker inspect "$next" --format '{{.State.Running}}' 2>/dev/null || true)" != true ]; then
      docker logs --tail 40 "$next" >&2 || true
      docker rm -f "$next" >/dev/null
      echo "segmenter $version did not get healthy; the running one was left untouched" >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  networks=
  if exists "$container"; then
    for network in $(attached "$container"); do
      [ "$network" = "$own_network" ] || networks="$networks $network"
    done
  fi
  moved=
  # Whatever goes wrong while moving, the old container gets every network back.
  give_back() {
    for network in $moved; do
      connect "$network" "$container" || echo "Warning: could not give $network back to $container" >&2
      disconnect "$network" "$next" || true
    done
  }
  trap give_back EXIT
  for network in $networks; do
    connect "$network" "$next"
    moved="$moved $network"
    disconnect "$network" "$container"
  done
  trap - EXIT
  if exists "$container"; then
    docker stop "$container" >/dev/null
    # One rollback copy: the stopped version before this one.
    if exists "$prev"; then docker rm "$prev" >/dev/null; fi
    docker rename "$container" "$prev"
  fi
  docker rename "$next" "$container"
  echo "segmenter $version running; networks:$networks"
}

attach() {
  network=$1_application
  connect "$network" "$container"
  for split in $split_instances; do
    if exists "$split"; then
      disconnect "$network" "$split"
      # Still serving another app network: leave it (and its network) for that edition's deploy.
      [ "$(attached "$split")" = "$split " ] || [ "$(attached "$split")" = "" ] || continue
      docker rm -f "$split" >/dev/null && echo "removed $split"
    fi
    # Its own internal network, once nothing is left on it. Idempotent: gone means done.
    if docker network inspect "$split" >/dev/null 2>&1 &&
      [ "$(docker network inspect "$split" --format '{{len .Containers}}' 2>/dev/null || echo 1)" = 0 ]; then
      docker network rm "$split" >/dev/null && echo "removed network $split"
    fi
  done
}

command=${1:-}
case $command in
  up)
    [ $# -eq 3 ] || usage
    printf '%s\n' "$3" | grep -Eqx '[0-9]+' || usage
    up "$2" "$3"
    ;;
  attach)
    [ $# -eq 2 ] || usage
    attach "$2"
    ;;
  healthy)
    [ $# -eq 1 ] || usage
    healthy "$container"
    ;;
  current)
    [ $# -eq 2 ] || usage
    current "$2"
    ;;
  *) usage ;;
esac
