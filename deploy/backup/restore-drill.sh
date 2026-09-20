#!/bin/sh
# Proves the newest dump restores: loads it into a throwaway Postgres inside this container, checks
# every dumped table came back with rows in total, and writes the verdict to pg/drill/latest.json,
# which the worker's alert loop reads. The result is uploaded on failure too.
set -u

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

# shellcheck source=lib.sh
. /usr/local/lib/pg-backup/lib.sh
pg_backup_env

work=$(mktemp -d /tmp/pg-drill.XXXXXX)
data=$work/data
dump=$work/latest.dump
dump_key=
tables=0
rows=0
error=

cleanup() {
  [ ! -f "$data/postmaster.pid" ] ||
    gosu postgres pg_ctl -D "$data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

psql_drill() {
  psql -X -q -v ON_ERROR_STOP=1 -At -h "$work" -U postgres -d drill "$@"
}

drill() {
  found=$(newest_object "${prefix}pg/" .dump.sha256) || { error='could not list completed dumps'; return 1; }
  [ -n "$found" ] || { error='no completed dump under pg/'; return 1; }
  checksum_key=${found%% *}
  key=${checksum_key%.sha256}
  dump_key=${key#"$prefix"}
  aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$key" "$dump" ||
    { error="could not download $dump_key"; return 1; }
  aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors "s3://$S3_BUCKET/$checksum_key" "$work/checksum" ||
    { error='could not download completion checksum'; return 1; }
  expected=$(cat "$work/checksum")
  actual=$(sha256sum "$dump" | awk '{ print $1 }')
  [ "$expected" = "$actual" ] || { error='dump checksum mismatch'; return 1; }

  pg_restore --list "$dump" >"$work/toc" 2>"$work/err" ||
    { error="unreadable dump: $(tail -n 1 "$work/err")"; return 1; }
  # "<id>; <oid> <oid> TABLE DATA <schema> <table> <owner>"
  awk '$4 == "TABLE" && $5 == "DATA" { print $6 "." $7 }' "$work/toc" | LC_ALL=C sort -u >"$work/expected"

  # The host has 3.6 GB; the cluster only has to hold one restore, with nothing durable about it.
  chown postgres "$work"
  gosu postgres initdb -D "$data" -U postgres -A trust --no-sync >/dev/null 2>"$work/err" ||
    { error="initdb failed: $(tail -n 1 "$work/err")"; return 1; }
  cat >>"$data/postgresql.conf" <<EOF
listen_addresses = ''
unix_socket_directories = '$work'
max_connections = 5
shared_buffers = 16MB
maintenance_work_mem = 32MB
fsync = off
synchronous_commit = off
full_page_writes = off
EOF
  gosu postgres pg_ctl -D "$data" -l "$work/server.log" -w start >/dev/null ||
    { error="throwaway postgres did not start: $(tail -n 1 "$work/server.log")"; return 1; }
  createdb -h "$work" -U postgres drill || { error='createdb failed'; return 1; }

  pg_restore --no-owner --no-privileges --exit-on-error -h "$work" -U postgres -d drill \
    "$dump" 2>"$work/err" || { error=$(tail -n 1 "$work/err"); error=${error:-pg_restore failed}; return 1; }

  # Exact counts in one query; partitioned parents are skipped so their rows are not counted twice.
  psql_drill -F ' ' >"$work/counts" 2>"$work/err" <<'SQL' ||
select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                           false, true, '')))[1]::text::bigint
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
order by 1;
SQL
    { error="counting rows failed: $(tail -n 1 "$work/err")"; return 1; }

  echo "pg-drill: row counts: $(awk '{ printf "%s=%s ", $1, $2 }' "$work/counts")"
  missing=$(cut -d ' ' -f 1 "$work/counts" | LC_ALL=C sort -u | LC_ALL=C comm -23 "$work/expected" -)
  [ -z "$missing" ] ||
    { error="tables missing after restore: $(printf '%s' "$missing" | tr '\n' ' ')"; return 1; }
  tables=$(wc -l <"$work/expected" | tr -d ' ')
  rows=$(awk '{ total += $2 } END { print total + 0 }' "$work/counts")
  [ "$rows" -gt 0 ] || { error='restored database holds no rows'; return 1; }
}

if drill; then ok=true; else ok=false; fi

# One short line, safe to drop between JSON quotes.
error=$(printf '%s' "$error" | tr '\n\t' '  ' | tr -d '"\\' | cut -c 1-200)
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$ok" = true ]; then
  printf '{"ok":true,"finished_at":"%s","dump_key":"%s","tables":%s,"rows":%s}\n' \
    "$finished_at" "$dump_key" "$tables" "$rows" >"$work/latest.json"
else
  printf '{"ok":false,"finished_at":"%s","dump_key":"%s","tables":%s,"rows":%s,"error":"%s"}\n' \
    "$finished_at" "$dump_key" "$tables" "$rows" "$error" >"$work/latest.json"
fi
cat "$work/latest.json"

target="s3://$S3_BUCKET/${prefix}pg/drill/latest.json"
aws --endpoint-url "$S3_ENDPOINT" s3 cp --only-show-errors --content-type application/json \
  "$work/latest.json" "$target" || { echo "pg-drill: could not upload $target"; exit 1; }

if [ "$ok" = true ]; then
  echo "pg-drill: restored $dump_key: $tables tables, $rows rows"
else
  echo "pg-drill: FAILED on ${dump_key:-no dump}: $error"
  exit 1
fi
