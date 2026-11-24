#!/bin/sh
set -eu

# busybox cron jobs inherit no container environment, so snapshot it for the job to source.
export -p > /etc/backup-env.sh
chmod 600 /etc/backup-env.sh

# Never invent backup success when a container restarts. catch_up hydrates this from R2.
mkdir -p /var/lib/pg-backup

# Back up hourly. Sunday 19:00 UTC = Monday 03:00 Asia/Shanghai for the isolated drill.
cat > /etc/crontabs/root <<'EOF'
0 * * * * . /etc/backup-env.sh; /usr/local/bin/backup.sh >>/proc/1/fd/1 2>&1
0 19 * * 0 . /etc/backup-env.sh; /usr/local/bin/restore-drill.sh >>/proc/1/fd/1 2>&1
EOF

# crond does not run what it missed while the host was down; catch up in the background so the
# container can start meanwhile, without claiming a successful backup.
(
  # shellcheck source=lib.sh
  . /usr/local/lib/pg-backup/lib.sh
  catch_up
) >>/proc/1/fd/1 2>&1 &

# Level 8 still logs each job start (USER root pid N cmd ...); lower levels add a wakeup line every
# minute and the parsed schedule bitmaps, which buried everything else in the log store.
exec crond -f -l 8 -L /dev/stdout
