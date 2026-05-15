#!/usr/bin/env bash
# mac mini 一键重新部署 admin server：
#   1. stash 本地未提交改动（.env / 部署侧 tweak）
#   2. git pull --rebase origin main
#   3. 恢复 stash
#   4. launchctl kickstart -k 重启 admin 进程（加载新代码 + env）
#
# 不 build web，不 build admin frontend（前端 SPA 由根 deploy:local 一并负责）。
# admin server 只读 sqlite + 反代 BFF binary，无静态产物之间的依赖。
#
# 用法（在 mac mini 上）：
#   bash apps/admin/deploy/redeploy.sh
#
# 也可远程：
#   ssh macmini "bash /Users/qiqian/workspace/repos/qlj-image-playground/apps/admin/deploy/redeploy.sh"
set -euo pipefail

LABEL="qlj.image-playground.admin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# 加常用 PATH，让 ssh 非 login shell 也能找到 pnpm / bun / git
export PATH="${HOME}/.bun/bin:${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

cd "${REPO_ROOT}"

echo "▶ 仓库：${REPO_ROOT}"
echo "▶ 当前 commit：$(git rev-parse --short HEAD)"

# 1. stash 本地未提交
STASH_REF=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  STASH_REF=$(git stash create "redeploy-$(date +%Y%m%d-%H%M%S)") || true
  if [[ -n "${STASH_REF}" ]]; then
    git stash store -m "auto-redeploy-admin" "${STASH_REF}" >/dev/null
    git reset --hard HEAD >/dev/null
    echo "✓ 已 stash 本地改动（${STASH_REF:0:8}）"
  fi
fi

# 2. pull 最新 main
echo "▶ git pull --rebase origin main"
git pull --rebase origin main

# 3. 恢复 stash
if [[ -n "${STASH_REF}" ]]; then
  if git stash pop >/dev/null 2>&1; then
    echo "✓ 已恢复 stash"
  else
    echo "⚠ stash pop 失败，stash 仍在；git stash list 查看"
  fi
fi

echo "▶ 拉取后 commit：$(git rev-parse --short HEAD)"

# 4. 重启 admin
DOMAIN="gui/$(id -u)"

# 4a. 清理残留 bun admin 进程（孤儿，launchctl kickstart -k 不会清理）
echo "▶ 清理残留 bun admin 进程"
PIDS=$(pgrep -f 'bun run.*apps/admin/server/index\.ts' || true)
if [[ -n "${PIDS}" ]]; then
  echo "  发现：${PIDS}"
  echo "${PIDS}" | xargs kill 2>/dev/null || true
  sleep 1
  STILL=$(pgrep -f 'bun run.*apps/admin/server/index\.ts' || true)
  if [[ -n "${STILL}" ]]; then
    echo "  TERM 后仍存活：${STILL}，发送 KILL"
    echo "${STILL}" | xargs kill -9 2>/dev/null || true
  fi
fi

echo "▶ launchctl kickstart -k ${DOMAIN}/${LABEL}"
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl kickstart -k "${DOMAIN}/${LABEL}"
  sleep 2
  if launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null | grep -q 'state = running'; then
    echo "✓ admin 已重启"
  else
    echo "⚠ admin 未正常运行，检查日志：tail ~/Library/Logs/qlj-admin.err.log"
    exit 1
  fi
else
  echo "⚠ ${DOMAIN}/${LABEL} 未加载；先跑 apps/admin/deploy/install.sh"
  exit 1
fi

# 4b. 校验只有一个 admin 在跑
RUNNING=$(pgrep -f 'bun run.*apps/admin/server/index\.ts' | wc -l | tr -d ' ')
if [[ "${RUNNING}" != "1" ]]; then
  echo "⚠ 检测到 ${RUNNING} 个 admin 进程在跑（应为 1）"
  pgrep -fl 'bun run.*apps/admin/server/index\.ts' || true
  exit 1
fi

echo
echo "✓ admin redeploy 完成"
echo "  实时日志：tail -f ~/Library/Logs/qlj-admin.log"
