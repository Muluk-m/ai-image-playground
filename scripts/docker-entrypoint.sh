#!/bin/sh
set -e

# 把 env 模板化为前端运行时配置文件。前端在 boot 时 fetch ./runtime-config.json
# 决定是否启用 BFF queue 路径与「内置」channel 显示。schema 见
# packages/shared/src/runtime-config.ts。
#
# 任何变更需要重启容器才生效（dist/runtime-config.json 只在启动时写一次）。

DIST_DIR="/app/apps/web/dist"
CONFIG_FILE="${DIST_DIR}/runtime-config.json"

if [ -d "${DIST_DIR}" ]; then
  cat > "${CONFIG_FILE}" <<EOF
{
  "bff": {
    "enabled": ${BFF_ENABLED:-true},
    "baseUrl": "${BFF_BASE_URL:-}"
  },
  "defaults": {
    "openaiBaseUrl":          "${DEFAULT_OPENAI_BASE_URL:-https://api.openai.com/v1}",
    "geminiBaseUrl":          "${DEFAULT_GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta}",
    "inspirationManifestUrl": "${INSPIRATION_MANIFEST_URL:-./inspiration-manifest.json}"
  }
}
EOF
  echo "[entrypoint] wrote runtime-config.json (bff.enabled=${BFF_ENABLED:-true}, bff.baseUrl='${BFF_BASE_URL:-}')"
else
  echo "[entrypoint] no ${DIST_DIR}; skip runtime-config (public web is not in this image)"
fi

if [ "$#" -eq 0 ]; then
  case "${APP_ROLE:-bff}" in
    bff) set -- bun run /app/apps/bff/src/index.ts ;;
    worker) set -- bun run /app/apps/bff/src/worker-index.ts ;;
    admin) set -- bun run /app/apps/admin/server/index.ts ;;
    *)
      echo "[entrypoint] unknown APP_ROLE=${APP_ROLE}" >&2
      exit 1
      ;;
  esac
fi

exec "$@"
