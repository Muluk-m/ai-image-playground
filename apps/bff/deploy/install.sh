#!/usr/bin/env bash
# 安装 @image-playground/bff 为 mac LaunchAgent。
#
# 用法：
#   cd apps/bff
#   ./deploy/install.sh
#
# 行为：
#   1. 找 bun 二进制路径（优先 ~/.bun/bin/bun，其次 $(which bun)）
#   2. 把 deploy/launchd.plist.tpl 占位符替换后写到 ~/Library/LaunchAgents/
#   3. 准备日志目录 ~/Library/Logs/
#   4. bootstrap 到当前 GUI session（替代被弃用的 load）
#   5. 打印状态 + 日志路径
set -euo pipefail

LABEL="qlj.image-playground.bff"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TPL="${SCRIPT_DIR}/launchd.plist.tpl"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

if [[ ! -f "${TPL}" ]]; then
  echo "✗ 模板不存在：${TPL}" >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "✗ ${APP_DIR}/.env 不存在；请先 cp .env.example .env 并填值再安装" >&2
  exit 1
fi

BUN_PATH=""
for candidate in "${HOME}/.bun/bin/bun" "$(command -v bun || true)"; do
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    BUN_PATH="${candidate}"
    break
  fi
done
if [[ -z "${BUN_PATH}" ]]; then
  echo "✗ 找不到 bun。先安装：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

mkdir -p "${LOG_DIR}" "$(dirname "${PLIST_DEST}")"

PATH_VALUE="$(dirname "${BUN_PATH}"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

sed \
  -e "s|@@WORKING_DIR@@|${APP_DIR}|g" \
  -e "s|@@BUN_PATH@@|${BUN_PATH}|g" \
  -e "s|@@PATH@@|${PATH_VALUE}|g" \
  -e "s|@@LOG_DIR@@|${LOG_DIR}|g" \
  "${TPL}" > "${PLIST_DEST}"

UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"

# bootout 旧实例（如果存在）后再 bootstrap，确保 plist 更新被识别
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
fi
launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "✓ LaunchAgent 已安装：${PLIST_DEST}"
echo "  工作目录：${APP_DIR}"
echo "  bun:    ${BUN_PATH}"
echo
echo "查看状态：launchctl print ${DOMAIN}/${LABEL} | head -20"
echo "实时日志：tail -f ${LOG_DIR}/qlj-bff.log"
echo "错误日志：tail -f ${LOG_DIR}/qlj-bff.err.log"
echo "重启：    launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "卸载：    ${SCRIPT_DIR}/uninstall.sh"
