#!/bin/sh
set -eu
# Release-boundary guard: test can never inherit the muvloom target or production credentials.
reject() { echo "Test isolation check failed: $1" >&2; exit 1; }
mode=${1:?pages or runtime required}
input=${2:?configuration path required}
case "$mode" in
  pages)
    # shellcheck source=/dev/null
    . "$input"
    [ "${TEST_PAGES_PROJECT:-}" = muvloom-test ] || reject 'unexpected Pages project'
    [ "${TEST_PUBLIC_ORIGIN:-}" = https://test.muvloom.online ] || reject 'unexpected frontend origin'
    [ "${TEST_BFF_BASE_URL:-}" = https://test-api.muvloom.online ] || reject 'dedicated test API required'
    [ -z "${TEST_BFF_BASE_URLS_BY_ORIGIN:-}" ] || reject 'origin overrides are not allowed for test'
    ;;
  runtime)
    [ "$(basename "$input")" = image-playground-test ] || reject 'unexpected application project'
    if [ -f "$input/deploy.env" ]; then
      [ -r "$input/env/bff.env" ] && [ -r "$input/env/migrate.env" ] && [ -r "$input/operator-config.json" ] || reject 'application, migrator and operator configuration required'
    else
      [ -r "$input/app.env" ] && [ -r "$input/migrate.env" ] && [ -r "$input/operator-config.json" ] || reject 'application, migrator and operator configuration required'
    fi
    # Match docker run/create --env-file (docker/cli pkg/kvfile): data, not shell.
    # Line endings (\n or \r\n) and a first-line UTF-8 BOM are dropped, leading whitespace is
    # trimmed, blank lines and # comments are skipped. Values are literal: quotes are kept,
    # variables are not expanded, trailing whitespace stays. The last assignment wins.
    # Lines Docker rejects (empty key, key with whitespace) or resolves from the host
    # environment (KEY without =) are refused here instead of being read as unset.
    # https://docs.docker.com/reference/cli/docker/container/run/#env
    # https://github.com/docker/cli/blob/master/pkg/kvfile/kvfile.go
    env_lines='
      {
        line = $0
        sub(/\r$/, "", line)
        if (NR == 1) sub(/^\357\273\277/, "", line)
        sub(/^[ \t\r\f\v]+/, "", line)
        if (line == "" || substr(line, 1, 1) == "#") next
        separator = index(line, "=")
      }'
    validate() {
      [ -r "$1" ] || reject "$2 is not readable"
      problem=$(awk "$env_lines"'
        separator == 0 { print "line " NR " has no = (Docker would inherit it from the host)"; exit }
        separator == 1 { print "line " NR " has no variable name"; exit }
        substr(line, 1, separator - 1) ~ /[ \t]/ { print "line " NR " has whitespace in its variable name"; exit }
      ' "$1") || reject "$2 could not be parsed"
      [ -z "$problem" ] || reject "$2 is not a valid Docker env file: $problem"
    }
    value() {
      awk -v key="$2" "$env_lines"'
        substr(line, 1, separator - 1) == key { result = substr(line, separator + 1) }
        END { print result }
      ' "$1"
    }
    # Config center (ADR 0035): <input> may be rendered/image-playground-test instead of the legacy
    # project directory. There each service has only its own keys (ADMIN_DATABASE_URL in admin.env,
    # BFF_BASE_URL in web.env), so the checks read the application services' files together, after
    # making sure no checked key differs between them: a merged view must not hide one service's value.
    # Production is read where production keeps it, whichever layout the test deployment uses.
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    config_root=$(dirname "$(dirname "$input")")
    # The keys checked below. APP_ROLE, PORT, DATABASE_POOL_MAX and the like differ between
    # services on purpose; these must not.
    checked='APP_DATABASE_URL APP_DIRECT_DATABASE_URL DIRECT_DATABASE_URL ADMIN_DATABASE_URL OPERATOR_CONFIG_FILE S3_BUCKET BFF_BASE_URL AUTH_PUBLIC_ORIGIN AUTH_FRONTEND_ORIGIN CORS_ALLOWED_ORIGINS OPS_ALERT_WEBHOOK_URL S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY INTERNAL_API_TOKEN ADMIN_COOKIE_SECRET EMAIL_CODE_SECRET'
    # Each file's effective KEY=value lines for those keys (last assignment wins), in Docker's reading.
    effective() {
      awk -v checked=" $checked " "$env_lines"'
        { key = substr(line, 1, separator - 1); if (index(checked, " " key " ")) values[key] = substr(line, separator + 1) }
        END { for (key in values) print key "=" values[key] }
      ' "$1"
    }
    merge_rendered() {
      : > "$2"
      for service in bff worker admin web pg-backup dependency-check host-collector; do
        [ -f "$1/env/$service.env" ] || continue
        validate "$1/env/$service.env" "$service.env"
        effective "$1/env/$service.env" >> "$2"
      done
      differing=$(LC_ALL=C sort -u "$2" | awk '{ key = substr($0, 1, index($0, "=") - 1) } key == last { print key; exit } { last = key }')
      [ -z "$differing" ] || reject "$differing differs between services in $1"
    }
    if [ -f "$input/deploy.env" ]; then
      [ -r "$input/env/bff.env" ] && [ -r "$input/env/migrate.env" ] || reject 'application and migrator configuration required'
      merge_rendered "$input" "$work/test.env"
      app_env=$work/test.env
      migrate_env=$input/env/migrate.env
    else
      app_env=$input/app.env
      migrate_env=$input/migrate.env
    fi
    # Production may be mid-switch: rendered while its containers still run on app.env, or the other
    # way round after a rollback. Test must share a credential with neither.
    if [ -f "$input/deploy.env" ]; then production_legacy=$config_root/apps/image-playground-paid/app.env
    else production_legacy=$(dirname "$input")/image-playground-paid/app.env; fi
    production_rendered=
    if [ -f "$config_root/rendered/image-playground-paid/deploy.env" ]; then
      # Fail closed: a rendered production missing its files or credentials proves nothing.
      for service in bff admin; do
        [ -r "$config_root/rendered/image-playground-paid/env/$service.env" ] ||
          reject "production rendered configuration lacks $service.env"
      done
      merge_rendered "$config_root/rendered/image-playground-paid" "$work/production.env"
      production_rendered=$work/production.env
    fi
    if [ -e "$production_legacy" ] || [ -z "$production_rendered" ]; then
      validate "$production_legacy" 'production app.env'
    else
      production_legacy=
    fi
    # Compared one file at a time, each path quoted; a read failure rejects instead of comparing
    # against an empty value.
    reuses_production() {
      for production_env in "$production_rendered" "$production_legacy"; do
        [ -n "$production_env" ] || continue
        production_value=$(value "$production_env" "$1") || reject "could not read $1 from production configuration"
        if [ "$production_env" = "$production_rendered" ] && [ -z "$production_value" ]; then
          reject "$1 is missing from the production rendered configuration"
        fi
        [ "$2" != "$production_value" ] || return 0
      done
      return 1
    }
    validate "$app_env" app.env
    validate "$migrate_env" migrate.env
    for name in APP_DATABASE_URL ADMIN_DATABASE_URL; do
      setting=$(value "$app_env" "$name")
      case "$name:$setting" in
        APP_DATABASE_URL:postgresql://aip_test_app:*@postgres:5432/aip_test|APP_DATABASE_URL:postgresql://aip_test_app:*@pgbouncer:6432/aip_test|ADMIN_DATABASE_URL:postgresql://aip_test_admin:*@postgres:5432/aip_test) ;;
        *) reject "$name must name dedicated test role/database" ;;
      esac
    done
    direct_setting=$(value "$app_env" APP_DIRECT_DATABASE_URL)
    if [ -n "$direct_setting" ]; then
      case "$direct_setting" in
        postgresql://aip_test_app:*@postgres:5432/aip_test) ;;
        *) reject 'APP_DIRECT_DATABASE_URL must name dedicated test role/database on direct postgres' ;;
      esac
    fi
    [ -z "$(value "$app_env" DIRECT_DATABASE_URL)" ] || reject 'DIRECT_DATABASE_URL must not be set directly in app.env; use APP_DIRECT_DATABASE_URL'
    setting=$(value "$migrate_env" MIGRATOR_DATABASE_URL)
    case "$setting" in postgresql://aip_test_migrator:*@postgres:5432/aip_test) ;; *) reject 'dedicated test migrator required' ;; esac
    [ "$(value "$app_env" OPERATOR_CONFIG_FILE)" = /run/operator/operator-config.json ] || reject 'dedicated mounted operator configuration required'
    [ "$(value "$app_env" S3_BUCKET)" = muvloom-test ] || reject 'dedicated test bucket required'
    [ "$(value "$app_env" BFF_BASE_URL)" = https://test-api.muvloom.online ] || reject 'unexpected API origin'
    [ "$(value "$app_env" AUTH_PUBLIC_ORIGIN)" = https://test-api.muvloom.online ] || reject 'unexpected authentication origin'
    [ "$(value "$app_env" AUTH_FRONTEND_ORIGIN)" = https://test.muvloom.online ] || reject 'unexpected login return origin'
    [ "$(value "$app_env" CORS_ALLOWED_ORIGINS)" = https://test.muvloom.online,https://muvloom-test.pages.dev ] || reject 'unexpected CORS origins'
    [ -z "$(value "$app_env" OPS_ALERT_WEBHOOK_URL)" ] || reject 'test must not notify production alert channels'
    for name in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY INTERNAL_API_TOKEN ADMIN_COOKIE_SECRET EMAIL_CODE_SECRET; do
      setting=$(value "$app_env" "$name")
      [ -n "$setting" ] || reject "$name is missing"
      case "$setting" in *replace-* ) reject "$name is a placeholder" ;; esac
      ! reuses_production "$name" "$setting" || reject "$name reuses a production credential"
    done
    ;;
  *) reject 'unknown check mode' ;;
esac
printf 'Test %s isolation checks passed.\n' "$mode"
