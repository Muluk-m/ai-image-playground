#!/bin/sh
set -e

# 把 env 模板化为前端运行时配置文件。前端在 boot 时 fetch ./runtime-config.json
# 决定是否启用 BFF queue 路径与「内置」channel 显示。schema 见
# packages/shared/src/runtime-config.ts。
#
# 任何变更需要重启容器才生效（dist/runtime-config.json 只在启动时写一次）。

DIST_DIR="/app/apps/web/dist"
CONFIG_FILE="${DIST_DIR}/runtime-config.json"

BFF_ENABLED_VALUE="${BFF_ENABLED:-true}"
AUTH_ENABLED_VALUE="${AUTH_ENABLED:-false}"

case "${BFF_ENABLED_VALUE}" in
  true|false) ;;
  *)
    echo "[entrypoint] BFF_ENABLED must be true or false" >&2
    exit 1
    ;;
esac

case "${AUTH_ENABLED_VALUE}" in
  true|false) ;;
  *)
    echo "[entrypoint] AUTH_ENABLED must be true or false" >&2
    exit 1
    ;;
esac

cat > "${CONFIG_FILE}" <<EOF
{
  "bff": {
    "enabled": ${BFF_ENABLED_VALUE},
    "baseUrl": "${BFF_BASE_URL:-}"
  },
  "auth": {
    "enabled": ${AUTH_ENABLED_VALUE}
  },
  "defaults": {
    "openaiBaseUrl":          "${DEFAULT_OPENAI_BASE_URL:-https://api.openai.com/v1}",
    "geminiBaseUrl":          "${DEFAULT_GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta}",
    "inspirationManifestUrl": "${INSPIRATION_MANIFEST_URL:-./inspiration-manifest.json}"
  }
}
EOF

echo "[entrypoint] wrote runtime-config.json (bff.enabled=${BFF_ENABLED_VALUE}, auth.enabled=${AUTH_ENABLED_VALUE}, bff.baseUrl='${BFF_BASE_URL:-}')"

exec "$@"
