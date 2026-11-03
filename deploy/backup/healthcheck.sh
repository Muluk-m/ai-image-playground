#!/bin/sh
set -eu
last=$(cat "${BACKUP_HEALTH_FILE:-/var/lib/pg-backup/last-success}" 2>/dev/null) || exit 1
case "$last" in ''|*[!0-9]*) exit 1 ;; esac
age=$(($(date -u +%s) - last))
# Match BACKUP_MAX_AGE_MS: half an hour of headroom beyond two hourly intervals, not a guarantee
# against delayed or missed backups. Never accept a future timestamp as a success.
[ "$age" -ge 0 ] && [ "$age" -le 9000 ]
