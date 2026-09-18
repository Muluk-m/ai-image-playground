#!/bin/sh
# Restore only into a new, isolated macmini2 container. Never points at an existing database.
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'Run this drill on macmini2' >&2; exit 1; }
root=${1:?Usage: restore-recovery-db.sh EXTRACTED_DIRECTORY NEW_CHECK_NAME}
name=${2:?Specify a new aip-recovery-check-* name}
case "$name" in aip-recovery-check-*) ;; *) echo 'Name must start with aip-recovery-check-' >&2; exit 1 ;; esac
case "$name" in *[!a-z0-9-]*) exit 1 ;; esac
root=$(CDPATH= cd -- "$root" && pwd)
[ -f "$root/database.dump" ] && [ -f "$root/.recovery-metadata.json" ]
# Only compatible PG 17 packages; never guess which server version should load a future dump.
bun -e '
 const m = await Bun.file(Bun.argv[1]).json();
 if (m.postgresMajor !== 17) process.exit(1);
 const entry = m.files.find(f => f.name === "database.dump");
 const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(Bun.argv[2]).arrayBuffer()).digest("hex");
 if (!entry || entry.sha256 !== hash) process.exit(1);
' "$root/.recovery-metadata.json" "$root/database.dump"
if docker container inspect "$name" >/dev/null 2>&1 || docker volume inspect "$name" >/dev/null 2>&1; then
  echo 'Restore target already exists; preserved unchanged' >&2
  exit 1
fi
# No ports, no external network and no BFF/worker: restored pending tasks cannot run or charge.
docker volume create "$name" >/dev/null
docker run -d --name "$name" --network none --memory 512m --cpus 1 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=recovery \
  --mount "type=volume,source=$name,target=/var/lib/postgresql/data" \
  --mount "type=bind,source=$root/database.dump,target=/restore/database.dump,readonly" \
  postgres:17.6-alpine3.22 >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
ready=false
for attempt in $(seq 1 30); do
  # The entrypoint's temporary initialization server listens only on the Unix socket.
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d recovery >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { echo 'Isolated PG did not start' >&2; exit 1; }
docker exec "$name" pg_restore -U postgres -d recovery --no-owner --no-privileges \
  --exit-on-error --single-transaction /restore/database.dump
docker exec "$name" psql -X -U postgres -d recovery -v ON_ERROR_STOP=1 -At -c "
select n.nspname || '.' || c.relname,
 (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
order by 1;" >"$root/restore-counts.txt"
chmod 600 "$root/restore-counts.txt"
echo "Restore verified; stopped container and volume retained: $name"
echo 'This is a database drill, not an activated fallback service.'
