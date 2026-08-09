#!/bin/sh
set -eu

role="${APP_ROLE:-bff}"

case "$role" in
  web)
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
  migrate|bff|worker)
    : "${APP_DATABASE_URL:?APP_DATABASE_URL is required for ${role}}"
    DATABASE_URL="$APP_DATABASE_URL"
    export DATABASE_URL
    unset APP_DATABASE_URL ADMIN_DATABASE_URL
    ;;
  admin)
    : "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required for admin}"
    DATABASE_URL="$ADMIN_DATABASE_URL"
    export DATABASE_URL
    unset APP_DATABASE_URL ADMIN_DATABASE_URL
    ;;
  *)
    echo "[entrypoint] unknown APP_ROLE: $role" >&2
    exit 1
    ;;
esac

exec "$@"
