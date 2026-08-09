#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
config_home=${XDG_CONFIG_HOME:-${HOME:?HOME must be set}/.config}
env_file=${INFRA_ENV_FILE:-${config_home}/ai-image-playground/infra.env}
project_name=${INFRA_COMPOSE_PROJECT_NAME:-image-playground-infra}
compose_file=${repo_root}/deploy/compose.infra.yaml

if [ ! -f "$env_file" ]; then
  echo "Infrastructure environment file not found: $env_file" >&2
  echo "Copy deploy/infra.env.example outside the repository, replace its placeholders, and set INFRA_ENV_FILE if using another path." >&2
  exit 1
fi

compose() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$env_file" \
    --file "$compose_file" \
    "$@"
}

command=${1:-up}
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  up)
    if [ "$#" -ne 0 ]; then
      echo "Usage: $0 up" >&2
      exit 2
    fi
    compose up --detach --wait postgres minio
    compose run --rm --no-deps minio-bootstrap
    ;;
  provision)
    if [ "$#" -ne 0 ]; then
      echo "Usage: $0 provision" >&2
      exit 2
    fi
    compose --profile provision run --rm postgres-provision
    ;;
  down)
    compose down "$@"
    ;;
  status)
    compose ps "$@"
    ;;
  logs)
    compose logs "$@"
    ;;
  compose)
    compose "$@"
    ;;
  *)
    echo "Usage: $0 {up|provision|down|status|logs|compose}" >&2
    exit 2
    ;;
esac
