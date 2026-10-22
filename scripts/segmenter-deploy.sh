#!/bin/sh
# The EdgeTAM segmenter (deploy/compose.segmenter.yaml). There are two instances, never shared
# across the test/production line:
#   test  image-playground-segmenter-test   started and updated only by test releases;
#   prod  image-playground-segmenter-prod   started and updated only by production releases
#         (built from main); internal and paid share it.
# A test release can therefore never rebuild or restart what production calls.
#
#   scripts/segmenter-deploy.sh up <instance> <image>
#     Starts the instance, or recreates it on a new image, and waits until it is healthy. A
#     recreated container loses the app networks it was attached to, so they are noted first and
#     attached again afterwards, also when the start fails (the old container is gone by then, so
#     a failed start leaves the editions on the agent's box until the next deploy).
#   scripts/segmenter-deploy.sh attach <instance> <project>
#     Attaches it to <project>_application with the alias `segmenter`. Idempotent.
#   scripts/segmenter-deploy.sh healthy <instance>
#     Succeeds when it is already running and healthy (a release without the image reuses it).
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file=$repo_root/deploy/compose.segmenter.yaml
# The single instance every edition shared before the split. Only test ever used it.
legacy_container='image-playground-segmenter'

usage() {
  echo "Usage: scripts/segmenter-deploy.sh up <test|prod> <image> | attach <test|prod> <project> | healthy <test|prod>" >&2
  exit 2
}

command=${1:-}
instance=${2:-}
case $instance in test|prod) ;; *) usage ;; esac
container=image-playground-segmenter-$instance
own_network=$container

attached() {
  docker inspect "$1" \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null || true
}

attach() {
  case " $(attached "$container") " in
    *" $1 "*) return 0 ;;
  esac
  docker network connect --alias segmenter "$1" "$container"
}

# Production networks may only ever reach the production instance, and test networks only the
# test one; refuse anything else instead of silently crossing the line.
network_allowed() {
  case "$instance:$1" in
    test:image-playground-test_application) return 0 ;;
    test:*) return 1 ;;
    prod:image-playground-test_application) return 1 ;;
    prod:*) return 0 ;;
  esac
}

case $command in
  up)
    [ $# -eq 3 ] || usage
    image=$3
    before=$(attached "$container")
    reattach() {
      for network in $before; do
        [ "$network" = "$own_network" ] || attach "$network" ||
          echo "Warning: could not reattach $container to $network" >&2
      done
    }
    # Whatever happens to the start, the networks it had are attached again before exiting.
    trap reattach EXIT
    if [ "$instance" = test ]; then
      # The first test rollout ran it inside the test app project (service `segmenter`). That
      # copy would answer to the same alias and hold another 900m, so it is retired here.
      for legacy in $(docker ps -aq --filter label=com.docker.compose.service=segmenter); do
        [ "$(docker inspect "$legacy" --format '{{index .Config.Labels "com.docker.compose.project"}}')" = image-playground-test ] &&
          docker rm -f "$legacy" >/dev/null && echo "retired the test project's own segmenter"
      done
      # The formerly shared instance would answer to the same alias on the test network: take it
      # off that network. It is not removed; see deploy/segmenter/README.md.
      case " $(attached "$legacy_container") " in
        *" image-playground-test_application "*)
          docker network disconnect image-playground-test_application "$legacy_container" &&
            echo "detached the formerly shared segmenter from the test network" ;;
      esac
    fi
    SEGMENTER_INSTANCE=$instance SEGMENTER_IMAGE=$image docker compose --project-name "$container" \
      --file "$compose_file" up --detach --wait
    ;;
  attach)
    [ $# -eq 3 ] || usage
    network=$3_application
    network_allowed "$network" || {
      echo "Refusing to attach the $instance segmenter to $network" >&2
      exit 1
    }
    attach "$network"
    ;;
  healthy)
    [ $# -eq 2 ] || usage
    [ "$(docker inspect "$container" --format '{{.State.Health.Status}}' 2>/dev/null || true)" = healthy ]
    ;;
  *) usage ;;
esac
