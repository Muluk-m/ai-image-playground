#!/bin/sh
set -eu
last=$(cat "${BACKUP_HEALTH_FILE:-/var/lib/pg-backup/last-success}" 2>/dev/null) || exit 1
case "$last" in ''|*[!0-9]*) exit 1 ;; esac
age=$(($(date -u +%s) - last))
# Allow one lost run plus the run itself (same number as BACKUP_MAX_AGE_MS), but never accept a
# future timestamp as a success.
[ "$age" -ge 0 ] && [ "$age" -le 9000 ]
