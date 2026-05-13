#!/usr/bin/env bash
# 卸载 @image-playground/bff 的 LaunchAgent。
#
# 不删除日志文件 / SQLite 数据库 / .env。
set -euo pipefail

LABEL="qlj.image-playground.bff"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
UID_VALUE="$(id -u)"
DOMAIN="gui/${UID_VALUE}"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}"
  echo "✓ 已 bootout ${DOMAIN}/${LABEL}"
else
  echo "ℹ️  ${DOMAIN}/${LABEL} 未加载，跳过 bootout"
fi

if [[ -f "${PLIST_DEST}" ]]; then
  rm -f "${PLIST_DEST}"
  echo "✓ 已删除 ${PLIST_DEST}"
fi

echo
echo "日志 / SQLite / .env 未触碰，可手动清理："
echo "  rm -f ~/Library/Logs/qlj-bff.log ~/Library/Logs/qlj-bff.err.log"
