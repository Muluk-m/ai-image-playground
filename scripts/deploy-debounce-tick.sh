#!/bin/sh
set -eu
# 静默合批自动发布触发器（macmini2 launchd 每 2 分钟执行一次）：
# 当 main 有未上线提交且 `Web checks` 已绿，等待连续 DEPLOY_DEBOUNCE_MINUTES（默认 10）分钟无新合并
# 后自动触发一次 Deploy production（mode=incremental）；若持续合并超过 DEPLOY_MAX_WAIT_MINUTES
# （默认 45）分钟也会强制发一单防饿死。已有发布在跑或排队、线上已最新、或已对当前 HEAD 触发过时直接跳过。
#
# 控制与安全：
# - 暂停自动发布：touch ~/.config/ai-image-playground/deploy-auto.pause（删掉即恢复）
# - token：只对本仓库有 Actions 读写 + Contents 只读权限的 fine-grained PAT，放在
#   DEPLOY_DISPATCH_TOKEN_FILE（默认 ~/.config/ai-image-playground/deploy-dispatch.token，权限 600）
#   token 经 curl --config - 标准输入传递，不出现在进程参数里。

repo=${DEPLOY_REPO:-Muluk-m/ai-image-playground}
api=${GITHUB_API_URL:-https://api.github.com}
token_file=${DEPLOY_DISPATCH_TOKEN_FILE:-$HOME/.config/ai-image-playground/deploy-dispatch.token}
pause_file=${DEPLOY_PAUSE_FILE:-$HOME/.config/ai-image-playground/deploy-auto.pause}
state_file=${DEPLOY_STATE_FILE:-$HOME/.cache/ai-image-playground/deploy-debounce-state.json}
debounce_min=${DEPLOY_DEBOUNCE_MINUTES:-10}
max_wait_min=${DEPLOY_MAX_WAIT_MINUTES:-45}

env_file=${PAGES_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground/pages.env}
if [ -f "$env_file" ]; then
  # shellcheck source=/dev/null
  . "$env_file"
fi
prod_api=${DEPLOY_API_URL:-${PAID_BFF_BASE_URL:-https://api.muvloom.online}}
prod_web=${DEPLOY_WEB_URL:-${PAID_PUBLIC_ORIGIN:-https://muvloom.online}}
prod_admin=${DEPLOY_ADMIN_URL:-${ADMIN_PUBLIC_ORIGIN:-https://admin.muvloom.online}}

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

if [ -e "$pause_file" ]; then
  log "auto-release paused ($pause_file)"
  exit 0
fi

[ -r "$token_file" ] || { log "token file $token_file missing; auto-release skipped"; exit 1; }
mode=$(stat -c %a "$token_file" 2>/dev/null || stat -f %Lp "$token_file" 2>/dev/null || echo unknown)
[ "$mode" = 600 ] || log "warning: $token_file has mode $mode, expected 600"
token=$(tr -d '[:space:]' <"$token_file")
[ -n "$token" ] || { log "token file $token_file is empty; auto-release skipped"; exit 1; }

gh_get() {
  printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -fsS --max-time 20 --config - \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$api/$1"
}

read_state() {
  first_unshipped_at=0
  last_dispatched_sha=
  if [ -r "$state_file" ]; then
    first_unshipped_at=$(jq -r '.first_unshipped_at // 0' "$state_file" 2>/dev/null || echo 0)
    last_dispatched_sha=$(jq -r '.last_dispatched_sha // ""' "$state_file" 2>/dev/null || echo '')
  fi
  case $first_unshipped_at in
    '' | *[!0-9]*) first_unshipped_at=0 ;;
  esac
}

write_state() {
  mkdir -p "$(dirname "$state_file")"
  tmp=$(mktemp "$(dirname "$state_file")/.deploy-debounce-state.XXXXXX")
  jq -n --argjson first "$1" --arg sha "$2" \
    '{first_unshipped_at: $first, last_dispatched_sha: $sha}' >"$tmp"
  mv "$tmp" "$state_file"
}

read_state

# 1. Never stack runs while a production deploy is already active (queued, waiting, in_progress, etc.).
deploy_runs=$(gh_get "repos/$repo/actions/workflows/deploy.yml/runs?branch=main&per_page=10")
active_info=$(printf '%s' "$deploy_runs" | jq -r '
  [.workflow_runs[]? | select(.status != "completed")] | first |
  if . then "\(.id) \(.status)" else "" end
')
if [ -n "$active_info" ]; then
  log "deploy already active ($active_info); waiting"
  exit 0
fi

# 2. Fetch current main HEAD commit and merge/commit timestamp.
head_json=$(gh_get "repos/$repo/commits/main")
head_sha=$(printf '%s' "$head_json" | jq -r '.sha // ""')
commit_ts=$(printf '%s' "$head_json" | jq -r '(.commit.committer.date // .commit.author.date // "") | if . == "" then 0 else fromdateiso8601 end')
[ -n "$head_sha" ] || { log "could not read main HEAD sha"; exit 1; }
case $commit_ts in
  '' | 0 | *[!0-9]*) log "could not parse commit timestamp for $head_sha"; exit 1 ;;
esac

# 3. Skip if we already dispatched for this exact HEAD, or if a deploy run already succeeded for it.
if [ "$last_dispatched_sha" = "$head_sha" ]; then
  if [ "$first_unshipped_at" != 0 ]; then write_state 0 "$last_dispatched_sha"; fi
  log "already dispatched $head_sha; idle"
  exit 0
fi

already_ran=$(printf '%s' "$deploy_runs" | jq -r --arg sha "$head_sha" '
  any(.workflow_runs[]?; .head_sha == $sha and .status == "completed" and .conclusion == "success")
')
if [ "$already_ran" = true ]; then
  write_state 0 "$head_sha"
  log "deploy already completed for $head_sha; idle"
  exit 0
fi

# Also catch auto-advanced runs: GitHub records the dispatch-time head_sha on the workflow run,
# while deploy.yml's release job tags vX.Y.Z on the actual shipped commit.
latest_completed_conclusion=$(printf '%s' "$deploy_runs" | jq -r '
  [.workflow_runs[]? | select(.status == "completed" and .conclusion != "cancelled")] | first | .conclusion // ""
')
if [ "$latest_completed_conclusion" = success ]; then
  tags_json=$(gh_get "repos/$repo/tags?per_page=10" 2>/dev/null) || tags_json='[]'
  already_tagged=$(printf '%s' "$tags_json" | jq -r --arg sha "$head_sha" '
    any(.[]; (.name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and .commit.sha == $sha)
  ')
  if [ "$already_tagged" = true ]; then
    write_state 0 "$head_sha"
    log "release tag already exists for $head_sha; idle"
    exit 0
  fi
fi

# 4. Check live production endpoints; if all 3 already serve head_sha, nothing to ship.
side_matches_head() {
  if [ "$1" = api ]; then endpoint=${2%/}/health; else endpoint=${2%/}/version.json; fi
  body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null) || return 1
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ "$1" = api ]; then
    served=$(printf '%s\n' "${version%%+*}" | sed -n 's/^\([0-9a-f]\{40\}\)$/\1/p')
  else
    served=$(printf '%s\n' "$version" | sed -n 's/^\([0-9a-f]\{7,40\}\)[+-].*/\1/p')
  fi
  [ -n "$served" ] || return 1
  case $head_sha in
    "$served"*) return 0 ;;
    *) return 1 ;;
  esac
}

if side_matches_head api "$prod_api" &&
   side_matches_head site "$prod_web" &&
   side_matches_head site "$prod_admin"; then
  if [ "$first_unshipped_at" != 0 ] || [ "$last_dispatched_sha" != "$head_sha" ]; then
    write_state 0 "$head_sha"
  fi
  log "all production sides already serve $head_sha; idle"
  exit 0
fi

# 5. Require main Web checks to succeed before auto-releasing.
checks_json=$(gh_get "repos/$repo/actions/workflows/web.yml/runs?head_sha=$head_sha&event=push&branch=main&per_page=20")
check_state=$(printf '%s' "$checks_json" | jq -r '
  if any(.workflow_runs[]?; .status == "completed" and .conclusion == "success") then "success"
  elif any(.workflow_runs[]?; .status != "completed") then "running"
  elif (.workflow_runs | length) == 0 then "none"
  else "failure" end
')
if [ "$check_state" != success ]; then
  log "Web checks for $head_sha on main is '$check_state'; not dispatching"
  exit 0
fi

# 6. Quiet-period debounce with anti-starvation max-wait ceiling.
now=${DEPLOY_NOW_EPOCH:-$(date +%s)}
quiet_sec=$((now - commit_ts))
[ "$quiet_sec" -ge 0 ] || quiet_sec=0
debounce_sec=$((debounce_min * 60))
max_wait_sec=$((max_wait_min * 60))

if [ "$first_unshipped_at" = 0 ]; then
  first_unshipped_at=$now
  write_state "$first_unshipped_at" "$last_dispatched_sha"
fi
waited_sec=$((now - first_unshipped_at))
[ "$waited_sec" -ge 0 ] || waited_sec=0

if [ "$quiet_sec" -lt "$debounce_sec" ]; then
  if [ "$max_wait_sec" -eq 0 ] || [ "$waited_sec" -lt "$max_wait_sec" ]; then
    log "holding $head_sha (quiet ${quiet_sec}s/${debounce_sec}s, batch wait ${waited_sec}s/${max_wait_sec}s)"
    exit 0
  fi
  reason="auto-batch (max wait ${max_wait_min}m)"
else
  reason="auto-batch (quiet ${debounce_min}m)"
fi

# 7. Dispatch ONE incremental Deploy production run (token via stdin).
payload=$(jq -n --arg reason "$reason" '{ref: "main", inputs: {mode: "incremental", reason: $reason}}')
status=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 30 -X POST --config - \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$api/repos/$repo/actions/workflows/deploy.yml/dispatches" \
  -d "$payload") || status=000

case $status in
  2??)
    write_state 0 "$head_sha"
    log "dispatched $reason for $head_sha (HTTP $status)"
    exit 0
    ;;
  *)
    log "dispatch failed for $head_sha (HTTP $status)"
    exit 1
    ;;
esac
