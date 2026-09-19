#!/bin/sh
set -eu

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

# shellcheck source=lib.sh
. /usr/local/lib/pg-backup/lib.sh
pg_backup_env

umask 077
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(cat /proc/sys/kernel/random/uuid)
work=$(mktemp -d /tmp/pg-backup.XXXXXX)
dump=$work/$stamp.dump
target="s3://$S3_BUCKET/${prefix}pg/$stamp.dump"
trap 'rm -rf "$work"' EXIT

# Retention is an R2 lifecycle rule on that prefix, not a delete from here.
pg_dump --format=custom --file="$dump" "$ADMIN_DATABASE_URL"
pg_restore --list "$dump" >/dev/null
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$dump" "$target"
# Publish the checksum last: it is the completion marker for new immutable dumps.
sha256sum "$dump" | awk '{ print $1 }' >"$dump.sha256"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$dump.sha256" "$target.sha256"

# The container healthcheck reads this actual successful upload timestamp.
mkdir -p /var/lib/pg-backup
date -u +%s >/var/lib/pg-backup/last-success
echo "pg-backup: uploaded $target"
