FROM postgres:17.6-alpine3.22

RUN apk add --no-cache aws-cli

COPY lib.sh /usr/local/lib/pg-backup/lib.sh
COPY backup.sh /usr/local/bin/backup.sh
COPY restore-drill.sh /usr/local/bin/restore-drill.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore-drill.sh /usr/local/bin/entrypoint.sh

ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION

CMD ["/usr/local/bin/entrypoint.sh"]
