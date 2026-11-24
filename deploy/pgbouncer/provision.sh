#!/bin/sh
set -eu

if [ -z "${POSTGRES_USER:-}" ] || [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "Set POSTGRES_USER and POSTGRES_PASSWORD in the external environment file" >&2
  exit 1
fi
if [ -z "${PGBOUNCER_AUTH_PASSWORD:-}" ]; then
  echo "Set PGBOUNCER_AUTH_PASSWORD in infra.env for pooler provisioning" >&2
  exit 1
fi

export PGPASSWORD="$POSTGRES_PASSWORD"
psql --host=postgres --username="$POSTGRES_USER" --dbname=postgres \
  --set=ON_ERROR_STOP=1 \
  --set=auth_password="$PGBOUNCER_AUTH_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE pgbouncer_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'auth_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pgbouncer_auth') \gexec
SELECT format('ALTER ROLE pgbouncer_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'auth_password') \gexec
GRANT CONNECT ON DATABASE postgres TO pgbouncer_auth;
CREATE SCHEMA IF NOT EXISTS pgbouncer;
CREATE OR REPLACE FUNCTION pgbouncer.get_auth(p_usename TEXT)
RETURNS TABLE(usename TEXT, passwd TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT rolname::text, rolpassword::text
  FROM pg_catalog.pg_authid
  WHERE rolname = p_usename
    AND rolcanlogin
    AND NOT rolsuper
    AND (rolvaliduntil IS NULL OR rolvaliduntil > now());
$$;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(TEXT) TO pgbouncer_auth;
SQL
