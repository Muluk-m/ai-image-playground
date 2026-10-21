#!/bin/sh
# The shared EdgeTAM segmenter (deploy/compose.segmenter.yaml): one container for every edition.
#
#   scripts/segmenter-deploy.sh up <image>
#     Starts it, or recreates it on a new image, and waits until it is healthy. A recreated
#     container loses the app networks it was attached to, so they are noted first and attached
#     again afterwards: updating it from one edition's deploy keeps serving the others.
#   scripts/segmenter-deploy.sh attach <project>
#     Attaches it to <project>_application with the alias `segmenter`. Idempotent.
#   scripts/segmenter-deploy.sh healthy -
#     Succeeds when it is already running and healthy (a release without the image reuses it).
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file=$repo_root/deploy/compose.segmenter.yaml
container='image-playground-segmenter'
own_network='image-playground-segmenter'

usage() {
  echo "Usage: scripts/segmenter-deploy.sh up <image> | attach <project> | healthy -" >&2
  exit 2
}

attached() {
  docker inspect "$container" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null || true
}

attach() {
  case " $(attached) " in
    *" $1 "*) return 0 ;;
  esac
  docker network connect --alias segmenter "$1" "$container"
}

command=${1:-}
[ $# -eq 2 ] || usage
case $command in
  up)
    image=$2
    before=$(attached)
    # The first test rollout ran it inside the test app project (service `segmenter`). That copy
    # would answer to the same alias and hold another 900m, so it is retired here.
    for legacy in $(docker ps -aq --filter label=com.docker.compose.service=segmenter); do
      [ "$(docker inspect "$legacy" --format '{{index .Config.Labels "com.docker.compose.project"}}')" = image-playground-test ] &&
        docker rm -f "$legacy" >/dev/null && echo "retired the test project's own segmenter"
    done
    SEGMENTER_IMAGE=$image docker compose --project-name image-playground-segmenter \
      --file "$compose_file" up --detach --wait
    for network in $before; do
      [ "$network" = "$own_network" ] || attach "$network"
    done
    ;;
  attach)
    attach "$2_application"
    ;;
  healthy)
    [ "$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || true)" = healthy ]
    ;;
  *) usage ;;
esac
