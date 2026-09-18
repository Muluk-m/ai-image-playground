#!/bin/sh
set -eu

# busybox cron jobs inherit no container environment, so snapshot it for the job to source.
export -p > /etc/backup-env.sh
chmod 600 /etc/backup-env.sh

# Seed the healthcheck marker so a fresh container is healthy until the first run is overdue.
mkdir -p /var/lib/pg-backup
touch /var/lib/pg-backup/last-success

# 18:00 UTC = 02:00 Asia/Shanghai. The drill restores that night's dump an hour later, Sunday
# 19:00 UTC = Monday 03:00 Asia/Shanghai.
cat > /etc/crontabs/root <<'EOF'
0 18 * * * . /etc/backup-env.sh; /usr/local/bin/backup.sh >>/proc/1/fd/1 2>&1
0 19 * * 0 . /etc/backup-env.sh; /usr/local/bin/restore-drill.sh >>/proc/1/fd/1 2>&1
EOF

# crond does not run what it missed while the host was down; catch up in the background so the
# container is up (and healthy) meanwhile.
(
  # shellcheck source=lib.sh
  . /usr/local/lib/pg-backup/lib.sh
  catch_up
) >>/proc/1/fd/1 2>&1 &

exec crond -f -l 2 -L /dev/stdout
