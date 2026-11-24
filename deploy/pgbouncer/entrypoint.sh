#!/bin/sh
set -eu

if [ -z "${PGBOUNCER_AUTH_PASSWORD:-}" ]; then
  echo "Set PGBOUNCER_AUTH_PASSWORD in infra.env before starting pgbouncer" >&2
  exit 1
fi

mkdir -p /tmp/pgbouncer
chmod 700 /tmp/pgbouncer
escaped=$(printf '%s' "$PGBOUNCER_AUTH_PASSWORD" | sed 's/"/""/g')
printf '"pgbouncer_auth" "%s"\n' "$escaped" > /tmp/pgbouncer/userlist.txt
chmod 600 /tmp/pgbouncer/userlist.txt
exec /usr/bin/pgbouncer /etc/pgbouncer/pgbouncer.ini
