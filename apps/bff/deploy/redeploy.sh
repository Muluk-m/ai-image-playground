#!/usr/bin/env bash
# mac mini 一键重新部署：
#   1. stash 本地未提交改动（.env / .gitignore 等 deploy 侧 tweak）
#   2. git pull --rebase origin main
#   3. 恢复 stash
#   4. apps/web build 出新 dist/（BFF serve）
#   5. launchctl kickstart -k 重启 BFF 进程（加载新代码 + env）
#
# 用法（在 mac mini 上）：
#   bash apps/bff/deploy/redeploy.sh
#
# 也可远程：
#   ssh macmini "bash /Users/qiqian/workspace/repos/qlj-image-playground/apps/bff/deploy/redeploy.sh"
set -euo pipefail

LABEL="qlj.image-playground.bff"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# 加常用 PATH，让 ssh 非 login shell 也能找到 pnpm / bun / git
export PATH="${HOME}/.bun/bin:${HOME}/Library/pnpm:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH}"

cd "${REPO_ROOT}"

echo "▶ 仓库：${REPO_ROOT}"
echo "▶ 当前 commit：$(git rev-parse --short HEAD)"

# 1. stash 本地未提交（如 .env / 部署侧 .gitignore tweak）
STASH_REF=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  STASH_REF=$(git stash create "redeploy-$(date +%Y%m%d-%H%M%S)") || true
  if [[ -n "${STASH_REF}" ]]; then
    git stash store -m "auto-redeploy" "${STASH_REF}" >/dev/null
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

# 4. rebuild web
echo "▶ apps/web pnpm build"
(cd apps/web && pnpm install --frozen-lockfile 2>&1 | tail -5 && pnpm build 2>&1 | tail -8)

# 5. 重启 BFF
DOMAIN="gui/$(id -u)"

# 5a. 先 kill 任何残留 BFF bun 进程（孤儿进程，launchctl kickstart -k 不会清理）。
#     若历史上用 `pnpm start` 手动起过、随后 install.sh 又 load 了一份，会出现
#     双实例。`pgrep -f` 模糊匹配防止漏网。kill 当前自身 / 父 shell 误伤的概率
#     极低（关键词独特），但保留 || true 容错。
echo "▶ 清理残留 bun BFF 进程"
PIDS=$(pgrep -f 'bun run.*apps/bff/src/index\.ts' || true)
if [[ -n "${PIDS}" ]]; then
  echo "  发现：${PIDS}"
  echo "${PIDS}" | xargs kill 2>/dev/null || true
  sleep 1
  STILL=$(pgrep -f 'bun run.*apps/bff/src/index\.ts' || true)
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
    echo "✓ BFF 已重启"
  else
    echo "⚠ BFF 未正常运行，检查日志：tail ~/Library/Logs/qlj-bff.err.log"
    exit 1
  fi
else
  echo "⚠ ${DOMAIN}/${LABEL} 未加载；先跑 apps/bff/deploy/install.sh"
  exit 1
fi

# 5b. 校验只有一个 BFF 在跑
RUNNING=$(pgrep -f 'bun run.*apps/bff/src/index\.ts' | wc -l | tr -d ' ')
if [[ "${RUNNING}" != "1" ]]; then
  echo "⚠ 检测到 ${RUNNING} 个 BFF 进程在跑（应为 1）"
  pgrep -fl 'bun run.*apps/bff/src/index\.ts' || true
  exit 1
fi

echo
echo "✓ redeploy 完成"
echo "  实时日志：tail -f ~/Library/Logs/qlj-bff.log"
