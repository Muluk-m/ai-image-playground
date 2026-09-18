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
newest_object() {
  listed=$(aws --endpoint-url "$S3_ENDPOINT" s3api list-objects-v2 \
    --bucket "$S3_BUCKET" --prefix "$1" --output text \
    --query "sort_by(Contents[?ends_with(Key, '$2')] || \`[]\`, &LastModified)[-1].[Key, LastModified]") ||
    return 1
  [ -n "$listed" ] && [ "$listed" != None ] || return 0
  # shellcheck disable=SC2086 # key and timestamp are tab separated and contain no blanks
  set -- $listed
  printf '%s %s\n' "$1" "$(s3_time_to_epoch "$2")"
}

# Runs $5 when the newest object under $2 ending in $3 is missing or older than $4 seconds.
run_if_stale() {
  if ! found=$(newest_object "$2" "$3"); then
    echo "pg-backup: catch-up: could not list $2; leaving the $1 to cron"
    return 0
  fi
  if [ -n "$found" ]; then
    age=$(($(date -u +%s) - ${found#* }))
    if [ "$age" -le "$4" ]; then
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
  # A dump is due daily.
  run_if_stale backup "${prefix}pg/" .dump 86400 backup.sh
  # The drill is due weekly; eight days leaves room for a Sunday run that is still in flight.
  run_if_stale drill "${prefix}pg/drill/" latest.json 691200 restore-drill.sh
}
