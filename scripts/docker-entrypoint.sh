#!/bin/sh
set -eu

role="${APP_ROLE:-bff}"

case "$role" in
  web)
    ingress_mode="${APP_INGRESS_MODE:-full}"
    case "$ingress_mode" in
      full) ingress_conf=/app/deploy/nginx.conf ;;
      api-only) ingress_conf=/app/deploy/nginx.api-only.conf ;;
      *)
        echo "[entrypoint] APP_INGRESS_MODE must be full or api-only" >&2
        exit 1
        ;;
    esac
    cp "$ingress_conf" /etc/nginx/conf.d/default.conf
    echo "[entrypoint] installed nginx ingress (mode=$ingress_mode)"

    # api-only serves no document root, so there is no runtime config to write.
    if [ "$ingress_mode" = api-only ]; then
      exec "$@"
    fi

    config_file="${RUNTIME_CONFIG_FILE:-/usr/share/nginx/html/runtime-config.json}"
    export RUNTIME_CONFIG_FILE="$config_file"
    mkdir -p "$(dirname "$config_file")"
    bun -e '
      const parseBoolean = (name, fallback) => {
        const raw = process.env[name]
        if (raw === undefined || raw === "") return fallback
        if (raw === "true") return true
        if (raw === "false") return false
        throw new Error(`${name} must be true or false`)
      }

      const config = {
        bff: {
          enabled: parseBoolean("BFF_ENABLED", true),
          baseUrl: process.env.BFF_BASE_URL ?? "",
        },
      }

      await Bun.write(
        process.env.RUNTIME_CONFIG_FILE,
        `${JSON.stringify(config, null, 2)}\n`,
      )
      console.log(
        `[entrypoint] wrote runtime config (bff.enabled=${config.bff.enabled}, bff.baseUrl=${JSON.stringify(config.bff.baseUrl)})`,
      )
    '
    ;;
  dependency-check)
    ;;
  migrate)
    : "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is required for migrate}"
    DATABASE_URL="$MIGRATOR_DATABASE_URL"
    export DATABASE_URL
    unset MIGRATOR_DATABASE_URL APP_DATABASE_URL ADMIN_DATABASE_URL
    ;;
  bff|worker)
    : "${APP_DATABASE_URL:?APP_DATABASE_URL is required for ${role}}"
    DATABASE_URL="$APP_DATABASE_URL"
    export DATABASE_URL
    unset MIGRATOR_DATABASE_URL APP_DATABASE_URL ADMIN_DATABASE_URL
    ;;
  admin)
    : "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required for admin}"
    DATABASE_URL="$ADMIN_DATABASE_URL"
    export DATABASE_URL
    unset MIGRATOR_DATABASE_URL APP_DATABASE_URL ADMIN_DATABASE_URL
    ;;
  *)
    echo "[entrypoint] unknown APP_ROLE: $role" >&2
    exit 1
    ;;
esac

exec "$@"
