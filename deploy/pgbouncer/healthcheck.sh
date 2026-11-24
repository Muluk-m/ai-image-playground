#!/bin/sh
set -eu

if [ -z "${PGBOUNCER_AUTH_PASSWORD:-}" ]; then
  echo "PGBOUNCER_AUTH_PASSWORD is required" >&2
  exit 1
fi
export PGPASSWORD="$PGBOUNCER_AUTH_PASSWORD"
exec psql --host=127.0.0.1 --port=6432 --username=pgbouncer_auth --dbname=postgres \
  --tuples-only --command='SELECT 1' >/dev/null
