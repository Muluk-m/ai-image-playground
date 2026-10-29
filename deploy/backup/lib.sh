# shellcheck shell=sh
# Shared by entrypoint.sh, backup.sh and restore-drill.sh. Sourced, never executed.

# Maps the S3_* settings onto aws-cli and sets $prefix. Callers check the variables first.
pg_backup_env() {
  AWS_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
  # R2 accepts no other region name.
  AWS_DEFAULT_REGION=auto
  # aws-cli v2 attaches a checksum to every upload by default; S3-compatible stores reject some.
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION
  export AWS_REQUEST_CHECKSUM_CALCULATION

  # Same confinement as the application objects: nothing we write may escape S3_KEY_PREFIX.
  prefix=$(printf '%s' "${S3_KEY_PREFIX:-}" | sed 's#^/*##; s#/*$##')
  [ -z "$prefix" ] || prefix="$prefix/"
}

# "2026-09-17T18:00:05+00:00" (or ...05.000Z) to epoch seconds. busybox date takes -d; BSD date
# (a developer's Mac running the tests) needs -j -f.
s3_time_to_epoch() {
  stamp=$(printf '%s' "$1" | cut -c1-19 | tr T ' ')
  date -u -d "$stamp" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$stamp" +%s
}

# Prints "<key> <epoch>" for the newest object under $1 whose key ends with $2, nothing when there
# is none. Fails when the listing itself fails, so a network error never reads as "no backup".
# aws-cli paginates (1000 keys per page) and applies --query to each page separately, so a
# sort_by(...)[-1] query yields one line per page. Print every match as "<LastModified> <Key>" and
# pick the newest across all pages here. S3/R2 timestamps share one ISO-8601 format, so they sort
# as text. Pages without a match print "None".
newest_object() {
  listed=$(aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
    --bucket "$S3_BUCKET" --prefix "$1" --output text \
    --query "Contents[?ends_with(Key, '$2')].[LastModified, Key]") ||
    return 1
  newest=$(printf '%s\n' "$listed" | awk 'NF == 2 && $1 != "None" && $2 != "None"' | sort | tail -n 1)
  [ -n "$newest" ] || return 0
  # shellcheck disable=SC2086 # timestamp and key are tab separated and contain no blanks
  set -- $newest
  epoch=$(s3_time_to_epoch "$1") || return 1
  printf '%s %s\n' "$2" "$epoch"
}

# Runs $5 when the newest object under $2 ending in $3 is missing or older than $4 seconds.
run_if_stale() {
  if ! found=$(newest_object "$2" "$3"); then
    echo "pg-backup: catch-up: could not list $2; leaving the $1 to cron"
    return 0
  fi
  if [ -n "$found" ]; then
    age=$(($(date -u +%s) - ${found#* }))
    if [ "$age" -ge 0 ] && [ "$age" -le "$4" ]; then
      echo "pg-backup: catch-up: latest $1 is ${age}s old, nothing to do"
      return 0
    fi
  fi
  echo "pg-backup: catch-up: $1 is missing or overdue, running $5"
  "$5" || echo "pg-backup: catch-up: $5 failed"
}

# Container start. crond does not run jobs it missed while the host was down, and redeploys restart
# this container often, so only an overdue job is run. Backup first: the drill restores the newest dump.
catch_up() {
  pg_backup_env
  # Rehydrate the real upload time. A failed listing leaves health unknown, never "just succeeded".
  marker=${BACKUP_HEALTH_FILE:-/var/lib/pg-backup/last-success}
  if latest=$(newest_object "${prefix}pg/" .dump.sha256) && [ -n "$latest" ]; then
    mkdir -p "$(dirname "$marker")"
    printf '%s\n' "${latest#* }" >"$marker"
  fi
  # Hourly cloud backups; no periodic replication or restore to the standby database.
  run_if_stale backup "${prefix}pg/" .dump.sha256 3600 backup.sh
  # The drill is due weekly; eight days leaves room for a Sunday run that is still in flight.
  run_if_stale drill "${prefix}pg/drill/" latest.json 691200 restore-drill.sh
}
