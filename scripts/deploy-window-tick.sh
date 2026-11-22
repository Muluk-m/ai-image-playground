#!/bin/sh
set -eu
# 按点触发生产发布窗口：Deploy production 的 workflow_dispatch，带 window=true（增量、要求 main 上的
# Web checks 已成功；各侧已是 main tip 时空跑，与 GitHub schedule 兜底重复触发无害）。
# 由 macmini2 的 launchd 在北京时间 12:30、18:30、23:30 调用，安装见 scripts/install-deploy-window-timer.sh。
#
# token：只对本仓库有 Actions 读写权限的 fine-grained PAT，放在 DEPLOY_DISPATCH_TOKEN_FILE
# （默认 ~/.config/ai-image-playground/deploy-dispatch.token，权限 600）。

repo=${DEPLOY_REPO:-Muluk-m/ai-image-playground}
token_file=${DEPLOY_DISPATCH_TOKEN_FILE:-$HOME/.config/ai-image-playground/deploy-dispatch.token}
api=${GITHUB_API_URL:-https://api.github.com}

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

[ -r "$token_file" ] || { log "token file $token_file missing; window not triggered"; exit 1; }
token=$(tr -d '[:space:]' <"$token_file")
[ -n "$token" ] || { log "token file $token_file is empty; window not triggered"; exit 1; }

attempt=1
while :; do
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$api/repos/$repo/actions/workflows/deploy.yml/dispatches" \
    -d '{"ref":"main","inputs":{"window":true}}') || status=000
  if [ "$status" = 204 ]; then
    log "window dispatched (attempt $attempt)"
    exit 0
  fi
  log "dispatch failed with HTTP $status (attempt $attempt)"
  # 401/403/404/422 是凭据或参数问题，重试无用。
  case $status in 401 | 403 | 404 | 422) exit 1 ;; esac
  [ "$attempt" -lt 4 ] || exit 1
  sleep $((attempt * 60))
  attempt=$((attempt + 1))
done
