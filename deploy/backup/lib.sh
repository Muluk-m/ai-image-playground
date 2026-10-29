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

# Exits 0 when the drill verdict at $1 is a failure: "ok":false, or anything that is not a pass,
# the same way the worker's alert reads it. Returns 2 when the download fails or the object is not
# a small verdict, so "unknown" never triggers a drill. restore-drill.sh writes one short JSON line
# with "ok" as the first field; only that leading field counts, whatever the rest of the line says.
# The read is capped with a range request, so an oversized object never fills memory or disk.
drill_failed() {
  verdict_file=$(mktemp) || return 2
  if ! aws --endpoint-url "$S3_ENDPOINT" s3api get-object --bucket "$S3_BUCKET" --key "$1" \
    --range bytes=0-4095 "$verdict_file" >/dev/null; then
    rm -f "$verdict_file"
    return 2
  fi
  size=$(wc -c <"$verdict_file" | tr -d ' ')
  if [ "$size" -ge 4096 ]; then
    echo "pg-backup: catch-up: drill verdict is at least ${size} bytes, not a verdict"
    rm -f "$verdict_file"
    return 2
  fi
  # A pass returns 1, anything else 0. Tested inside if, so set -e in the caller never trips.
  if head -n 1 "$verdict_file" |
    grep -Eq '^[[:space:]]*\{[[:space:]]*"ok"[[:space:]]*:[[:space:]]*true[[:space:]]*[,}]'; then
    verdict_rc=1
  else
    verdict_rc=0
  fi
  rm -f "$verdict_file"
  return "$verdict_rc"
}

# Runs the drill when its verdict is missing, older than $1 seconds, or a failure at least
# $2 seconds old. A failed verdict otherwise stays until next Sunday and keeps the alert firing
# after the cause is fixed. The cooldown keeps a drill that still fails from running on every
# redeploy: its fresh verdict is younger than the cooldown, so each one retries at most once.
catch_up_drill() {
  dir="${prefix}pg/drill/"
  if ! found=$(newest_object "$dir" latest.json); then
    echo "pg-backup: catch-up: could not list $dir; leaving the drill to cron"
    return 0
  fi
  if [ -n "$found" ]; then
    age=$(($(date -u +%s) - ${found#* }))
    if [ "$age" -ge 0 ] && [ "$age" -le "$1" ]; then
      # entrypoint.sh runs catch_up under set -e, so the status is caught instead of tested bare.
      verdict_status=0
      drill_failed "${found%% *}" || verdict_status=$?
      case $verdict_status in
        1)
          echo "pg-backup: catch-up: latest drill is ${age}s old, nothing to do"
          return 0
          ;;
        2)
          echo "pg-backup: catch-up: could not read the latest drill verdict; leaving the drill to cron"
          return 0
          ;;
      esac
      if [ "$age" -lt "$2" ]; then
        echo "pg-backup: catch-up: latest drill failed ${age}s ago; retrying after ${2}s"
        return 0
      fi
      echo "pg-backup: catch-up: latest drill failed ${age}s ago, running restore-drill.sh"
      restore-drill.sh || echo "pg-backup: catch-up: restore-drill.sh failed"
      return 0
    fi
  fi
  echo "pg-backup: catch-up: drill is missing or overdue, running restore-drill.sh"
  restore-drill.sh || echo "pg-backup: catch-up: restore-drill.sh failed"
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
  # A failed one is retried once it is PG_DRILL_RETRY_AFTER_SECONDS old (default 6 hours).
  retry_after=${PG_DRILL_RETRY_AFTER_SECONDS:-21600}
  case "$retry_after" in '' | *[!0-9]*) retry_after=21600 ;; esac
  catch_up_drill 691200 "$retry_after"
}
