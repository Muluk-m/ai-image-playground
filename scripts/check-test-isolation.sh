#!/bin/sh
set -eu
# Release-boundary guard: test can never inherit the paid target or production credentials.
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
    [ -r "$input/app.env" ] && [ -r "$input/migrate.env" ] && [ -r "$input/operator-config.json" ] || reject 'application, migrator and operator configuration required'
    # Docker env files are data, not shell: production EMAIL_FROM may contain spaces and < >.
    value() {
      awk -v key="$2=" 'index($0, key) == 1 {
        v = substr($0, length(key) + 1)
        q = substr(v, 1, 1)
        if ((q == "\"" || q == sprintf("%c", 39)) && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
        result = v
      } END { print result }' "$1"
    }
    for name in APP_DATABASE_URL ADMIN_DATABASE_URL; do
      setting=$(value "$input/app.env" "$name")
      case "$name:$setting" in
        APP_DATABASE_URL:postgresql://aip_test_app:*@postgres:5432/aip_test|ADMIN_DATABASE_URL:postgresql://aip_test_admin:*@postgres:5432/aip_test) ;;
        *) reject "$name must name dedicated test role/database" ;;
      esac
    done
    setting=$(value "$input/migrate.env" MIGRATOR_DATABASE_URL)
    case "$setting" in postgresql://aip_test_migrator:*@postgres:5432/aip_test) ;; *) reject 'dedicated test migrator required' ;; esac
    [ "$(value "$input/app.env" OPERATOR_CONFIG_FILE)" = /run/operator/operator-config.json ] || reject 'dedicated mounted operator configuration required'
    [ "$(value "$input/app.env" S3_BUCKET)" = muvloom-test ] || reject 'dedicated test bucket required'
    [ "$(value "$input/app.env" BFF_BASE_URL)" = https://test-api.muvloom.online ] || reject 'unexpected API origin'
    [ "$(value "$input/app.env" AUTH_PUBLIC_ORIGIN)" = https://test-api.muvloom.online ] || reject 'unexpected authentication origin'
    [ "$(value "$input/app.env" AUTH_FRONTEND_ORIGIN)" = https://test.muvloom.online ] || reject 'unexpected login return origin'
    [ "$(value "$input/app.env" CORS_ALLOWED_ORIGINS)" = https://test.muvloom.online,https://muvloom-test.pages.dev ] || reject 'unexpected CORS origins'
    [ -z "$(value "$input/app.env" OPS_ALERT_WEBHOOK_URL)" ] || reject 'test must not notify production alert channels'
    for name in S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY INTERNAL_API_TOKEN ADMIN_COOKIE_SECRET EMAIL_CODE_SECRET; do
      setting=$(value "$input/app.env" "$name")
      [ -n "$setting" ] || reject "$name is missing"
      case "$setting" in *replace-* ) reject "$name is a placeholder" ;; esac
      for production in image-playground-paid image-playground-internal; do
        source_file=$(dirname "$input")/$production/app.env
        [ -r "$source_file" ] || reject 'production configuration must be readable for isolation comparison'
        [ "$setting" != "$(value "$source_file" "$name")" ] || reject "$name reuses a production credential"
      done
    done
    ;;
  *) reject 'unknown check mode' ;;
esac
printf 'Test %s isolation checks passed.\n' "$mode"
