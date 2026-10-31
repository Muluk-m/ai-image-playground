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

# Cron and start-up catch-up may overlap. With destructive retention they must not run unlocked.
exec 9>/tmp/pg-backup.lock
lock_status=0
flock -n 9 || lock_status=$?
case $lock_status in
  0) ;;
  1)
    echo "pg-backup: another backup is already running, skipping this one"
    exit 0
    ;;
  *)
    echo "pg-backup: could not take the backup lock (status $lock_status)" >&2
    exit "$lock_status"
    ;;
esac

umask 077
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)-$(cat /proc/sys/kernel/random/uuid)
work=$(mktemp -d /tmp/pg-backup.XXXXXX)
dump=$work/$stamp.dump
target_key=${prefix}pg/$stamp.dump
target="s3://$S3_BUCKET/$target_key"
trap 'rm -rf "$work"' EXIT

pg_dump --format=custom --file="$dump" "$ADMIN_DATABASE_URL"
pg_restore --list "$dump" >/dev/null
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$dump" "$target"
# Publish the checksum last: it is the completion marker for new immutable dumps.
sha256sum "$dump" | awk '{ print $1 }' >"$dump.sha256"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$dump.sha256" "$target.sha256"

# Keep one complete backup. Delete only dump objects: pg/drill/latest.json must survive retention.
listed=$(aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
  --bucket "$S3_BUCKET" --prefix "${prefix}pg/" --output text \
  --query "Contents[?ends_with(Key, '.dump') || ends_with(Key, '.dump.sha256')].[Key]")
printf '%s\n' "$listed" | while IFS= read -r key; do
  case $key in
    ''|None|"$target_key"|"$target_key.sha256") ;;
    *.dump|*.dump.sha256)
      aws --endpoint-url "$S3_ENDPOINT" s3 rm "s3://$S3_BUCKET/$key" --only-show-errors
      ;;
  esac
done

# The container healthcheck reads this actual successful upload timestamp.
mkdir -p /var/lib/pg-backup
date -u +%s >/var/lib/pg-backup/last-success
echo "pg-backup: uploaded $target"
