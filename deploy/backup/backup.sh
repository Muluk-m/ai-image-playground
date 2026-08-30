#!/bin/sh
set -eu

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
# R2 accepts no other region name.
AWS_DEFAULT_REGION=auto
# aws-cli v2 attaches a checksum to every upload by default; S3-compatible stores reject some.
AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
export AWS_REQUEST_CHECKSUM_CALCULATION

# Same confinement as the application objects: the dump must not escape S3_KEY_PREFIX.
prefix=$(printf '%s' "${S3_KEY_PREFIX:-}" | sed 's#^/*##; s#/*$##')
[ -z "$prefix" ] || prefix="$prefix/"

stamp=$(date -u +%Y-%m-%d)
dump=/tmp/pg-$stamp.dump
target="s3://$S3_BUCKET/${prefix}pg/$stamp.dump"
trap 'rm -f "$dump"' EXIT

# Retention is an R2 lifecycle rule on that prefix, not a delete from here.
pg_dump --format=custom --file="$dump" "$ADMIN_DATABASE_URL"
aws --endpoint-url "$S3_ENDPOINT" s3 cp "$dump" "$target"

# The container healthcheck reads this mtime; without it a failing backup is silent.
mkdir -p /var/lib/pg-backup
touch /var/lib/pg-backup/last-success
echo "pg-backup: uploaded $target"
