#!/bin/sh
set -eu

# busybox cron jobs inherit no container environment, so snapshot it for the job to source.
export -p > /etc/backup-env.sh
chmod 600 /etc/backup-env.sh

# Seed the healthcheck marker so a fresh container is healthy until the first run is overdue.
mkdir -p /var/lib/pg-backup
touch /var/lib/pg-backup/last-success

# 18:00 UTC = 02:00 Asia/Shanghai.
echo '0 18 * * * . /etc/backup-env.sh; /usr/local/bin/backup.sh >>/proc/1/fd/1 2>&1' \
  > /etc/crontabs/root

exec crond -f -l 2 -L /dev/stdout
