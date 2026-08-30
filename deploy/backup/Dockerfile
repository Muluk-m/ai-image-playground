FROM postgres:17.6-alpine3.22

RUN apk add --no-cache aws-cli

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# 18:00 UTC = 02:00 Asia/Shanghai. busybox cron jobs inherit no container environment,
# so the entrypoint snapshots it into a file the job sources.
CMD ["/bin/sh", "-c", "export -p > /etc/backup-env.sh && printf '%s\\n' '0 18 * * * . /etc/backup-env.sh; /usr/local/bin/backup.sh >>/proc/1/fd/1 2>&1' > /etc/crontabs/root && exec crond -f -l 2 -L /dev/stdout"]
