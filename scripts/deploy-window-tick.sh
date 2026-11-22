#!/bin/sh
set -eu
# 按点触发生产发布窗口：Deploy production 的 workflow_dispatch，带 window=true（增量、要求 main 上的
# Web checks 已成功；各侧已是 main tip 时空跑）。GitHub schedule 只兜底：本窗口已有手动触发它就跳过。
# 由 macmini2 的 launchd 在北京时间 12:30、18:30、23:30 调用；launchd 跑的是安装时复制到
# ~/.local/bin 的副本，改本脚本后重跑 scripts/install-deploy-window-timer.sh。
#
# token：只对本仓库有 Actions 读写权限的 fine-grained PAT，放在 DEPLOY_DISPATCH_TOKEN_FILE
# （默认 ~/.config/ai-image-playground/deploy-dispatch.token，权限 600）。

repo=${DEPLOY_REPO:-Muluk-m/ai-image-playground}
token_file=${DEPLOY_DISPATCH_TOKEN_FILE:-$HOME/.config/ai-image-playground/deploy-dispatch.token}
api=${GITHUB_API_URL:-https://api.github.com}
# 离窗口时点超过这么多分钟就不触发：机器睡过窗口、唤醒后 launchd 补跑时，不在窗口外发布。
max_late=${DEPLOY_WINDOW_MAX_LATE_MINUTES:-20}

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

now=$(date +%H:%M)
# 去掉前导 0，免得 08、09 被当成八进制。
hour=$(date +%H | sed 's/^0//')
minute=$(date +%M | sed 's/^0//')
now_min=$((${hour:-0} * 60 + ${minute:-0}))
late=
for slot in 750 1110 1410; do # 12:30、18:30、23:30（本地时间，分钟）
  diff=$((now_min - slot))
  if [ "$diff" -ge 0 ] && [ "$diff" -le "$max_late" ]; then late=$diff; fi
done
if [ -z "$late" ] && [ "${DEPLOY_WINDOW_FORCE:-}" != 1 ]; then
  log "not within $max_late minutes after a window (local $now); not triggered"
  exit 0
fi

[ -r "$token_file" ] || { log "token file $token_file missing; window not triggered"; exit 1; }
mode=$(stat -f %Lp "$token_file" 2>/dev/null || stat -c %a "$token_file")
[ "$mode" = 600 ] || log "warning: $token_file has mode $mode, expected 600"
token=$(tr -d '[:space:]' <"$token_file")
[ -n "$token" ] || { log "token file $token_file is empty; window not triggered"; exit 1; }

attempt=1
while :; do
  # token 经 stdin 交给 curl，不出现在进程参数里。
  status=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 30 -X POST --config - \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$api/repos/$repo/actions/workflows/deploy.yml/dispatches" \
    -d '{"ref":"main","inputs":{"window":true}}') || status=000
  case $status in
    2??)
      log "window dispatched (HTTP $status, attempt $attempt)"
      exit 0
      ;;
    4??)
      # 凭据、权限或参数问题，重试无用。
      log "dispatch rejected with HTTP $status; window not triggered"
      exit 1
      ;;
  esac
  log "dispatch failed with HTTP $status (attempt $attempt)"
  [ "$attempt" -lt 4 ] || exit 1
  sleep $((attempt * 60))
  attempt=$((attempt + 1))
done
