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
#   scripts/segmenter-deploy.sh detach <project>
#     Takes <project>_application off the shared container: the edition is not to use it.
#     Attached means enabled, which is what rollout-runtime.sh reads back on a rollback. Idempotent.
#   scripts/segmenter-deploy.sh rollback
#     By hand only: back to `image-playground-segmenter-prev`, which is started and checked before
#     it gets every app network; the two swap names, so running it again rolls forward.
#   scripts/segmenter-deploy.sh healthy
#     Succeeds when the shared container is running and serving: Docker reports it healthy, or it
#     answers /health (Docker still says `starting` for up to 30 s after `up` replaced it).
#   scripts/segmenter-deploy.sh current <version>
#     Succeeds when the shared container already runs <version> and is serving.
set -eu

container='image-playground-segmenter'
next="$container-next"
prev="$container-prev"
own_network='image-playground-segmenter'
version_label='online.muvloom.segmenter.version'
# Instances from a short-lived per-environment layout; they would answer to the same alias.
split_instances="$container-test $container-prod"

usage() {
  echo "Usage: scripts/segmenter-deploy.sh up <image> <version> | attach <project> | detach <project> | rollback | healthy | current <version>" >&2
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

running() {
  [ "$(docker inspect "$1" --format '{{.State.Running}}' 2>/dev/null || true)" = true ]
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

# Serving: Docker says healthy, or it runs and answers right now. Right after `up` replaced it,
# Docker still reports `starting` until the first 30 s health interval, although `up` only
# switched over once it answered; editions deployed in that window must still get it.
usable() {
  if healthy "$1"; then return 0; fi
  running "$1" && answers "$1"
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
  exists "$container" && usable "$container" &&
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
  # Normally the serving one is $container. After a hand rollback that started $prev instead
  # (the stopped $container is the version that was rolled back), $prev is serving: take its
  # networks and keep it as the rollback copy, and drop the stopped one.
  source=$container
  if exists "$prev" && running "$prev" && ! running "$container"; then source=$prev; fi
  networks=$(app_networks "$source")
  move_networks "$source" "$next" "$networks"
  if [ "$source" = "$prev" ]; then
    docker stop "$prev" >/dev/null
    if exists "$container"; then docker rm -f "$container" >/dev/null; fi
  elif exists "$container"; then
    docker stop "$container" >/dev/null
    # One rollback copy: the stopped version before this one.
    if exists "$prev"; then docker rm -f "$prev" >/dev/null; fi
    docker rename "$container" "$prev"
  fi
  docker rename "$next" "$container"
  echo "segmenter $version running; networks:$networks"
}

# The app networks of <container>, not its own internal one.
app_networks() {
  exists "$1" || return 0
  for network in $(attached "$1"); do
    [ "$network" = "$own_network" ] || printf ' %s' "$network"
  done
}

# move_networks <from> <to> <networks>: whatever goes wrong while moving, <from> gets every
# network back and the script exits nonzero.
move_networks() {
  move_from=$1
  move_to=$2
  moved=
  give_back() {
    for network in $moved; do
      connect "$network" "$move_from" || echo "Warning: could not give $network back to $move_from" >&2
      disconnect "$network" "$move_to" || true
    done
  }
  trap give_back EXIT
  for network in $3; do
    connect "$network" "$move_to"
    moved="$moved $network"
    disconnect "$network" "$move_from"
  done
  trap - EXIT
}

# Back to the stopped version before this one: started, checked, given every app network, and only
# then the current one stopped. The two swap names, so the serving one is always $container and
# `rollback` again rolls forward. A release with the rolled-back VERSION would start that version
# again: fix it and bump VERSION.
rollback() {
  exists "$prev" || { echo "no $prev to roll back to" >&2; return 1; }
  exists "$container" || { echo "no $container to roll back from" >&2; return 1; }
  docker start "$prev" >/dev/null
  waited=0
  until answers "$prev"; do
    if [ "$waited" -ge "${SEGMENTER_START_TIMEOUT:-180}" ] || ! running "$prev"; then
      docker logs --tail 40 "$prev" >&2 || true
      docker stop "$prev" >/dev/null || true
      echo "$prev did not get healthy; $container was left serving" >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  networks=$(app_networks "$container")
  move_networks "$container" "$prev" "$networks"
  docker stop "$container" >/dev/null
  docker rename "$container" "$container-swap"
  docker rename "$prev" "$container"
  docker rename "$container-swap" "$prev"
  echo "segmenter rolled back; networks:$networks"
}

attach() {
  network=$1_application
  connect "$network" "$container"
  for split in $split_instances; do
    if exists "$split"; then
      disconnect "$network" "$split"
      # Still serving another app network: leave it (and its network) for that edition's deploy.
      [ "$(attached "$split")" = "$split " ] || [ "$(attached "$split")" = "" ] || continue
      # Cleanup only: a failure here warns and never fails the attach that already happened.
      if docker rm -f "$split" >/dev/null; then echo "removed $split"; else
        echo "Warning: could not remove $split" >&2
        continue
      fi
    fi
    # Its own internal network, once nothing is left on it. Idempotent: gone means done.
    if docker network inspect "$split" >/dev/null 2>&1 &&
      [ "$(docker network inspect "$split" --format '{{len .Containers}}' 2>/dev/null || echo 1)" = 0 ]; then
      if docker network rm "$split" >/dev/null; then echo "removed network $split"; else
        echo "Warning: could not remove network $split" >&2
      fi
    fi
  done
  return 0
}

# The edition is not (or no longer) to use it. Attached means enabled: rollout-runtime.sh reads it
# back on a rollback. Idempotent; nothing to do when there is no shared container.
detach() {
  network=$1_application
  exists "$container" || return 0
  disconnect "$network" "$container"
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
  rollback)
    [ $# -eq 1 ] || usage
    rollback
    ;;
  healthy)
    [ $# -eq 1 ] || usage
    usable "$container"
    ;;
  detach)
    [ $# -eq 2 ] || usage
    detach "$2"
    ;;
  current)
    [ $# -eq 2 ] || usage
    current "$2"
    ;;
  *) usage ;;
esac
