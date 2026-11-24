#!/bin/sh
set -eu
# 静默合批自动发布触发器（macmini2 launchd 每 2 分钟执行一次）：
# 当 main 有未上线提交且 `Web checks` 已绿，等待连续 DEPLOY_DEBOUNCE_MINUTES（默认 10）分钟
# main 无新变化后自动触发一次 Deploy production（mode=incremental）；若持续合并超过
# DEPLOY_MAX_WAIT_MINUTES（默认 45）分钟也会强制发一单防饿死。
#
# 控制与安全：
# - 暂停自动发布：touch ~/.config/ai-image-playground/deploy-auto.pause（删掉即恢复）
# - token：只对本仓库有 Actions 读写 + Contents 只读权限的 fine-grained PAT，放在
#   DEPLOY_DISPATCH_TOKEN_FILE（默认 ~/.config/ai-image-playground/deploy-dispatch.token，权限 600）
#   token 经 curl --config - 标准输入传递，不出现在进程参数里。

here=$(cd "$(dirname "$0")" && pwd)
if [ -r "$here/lib/release-paths.sh" ]; then
  # shellcheck source=scripts/lib/release-paths.sh
  . "$here/lib/release-paths.sh"
elif [ -r "$here/muvloom-release-paths.sh" ]; then
  # shellcheck source=/dev/null
  . "$here/muvloom-release-paths.sh"
else
  RELEASE_WEB_PATHS='^(apps/web/|apps/website/|cli-go/|scripts/build-cli-web-bins\.sh$|packages/shared/|pnpm-workspace\.yaml$)'
  RELEASE_ADMIN_PATHS='^(apps/admin/|packages/read-models/|packages/shared/|pnpm-workspace\.yaml$)'
  RELEASE_API_PATHS='^(apps/bff/|apps/admin/|packages/|Dockerfile$|deploy/|pnpm-workspace\.yaml$|scripts/build-vps-release\.sh$|scripts/docker-entrypoint\.sh$|scripts/vps-deploy\.sh$|scripts/app-compose\.sh$|scripts/rollout-runtime\.sh$|scripts/check-test-isolation\.sh$|scripts/segmenter-deploy\.sh$|scripts/lib/deploy-common\.sh$)'
fi

repo=${DEPLOY_REPO:-Muluk-m/ai-image-playground}
api=${GITHUB_API_URL:-https://api.github.com}
token_file=${DEPLOY_DISPATCH_TOKEN_FILE:-$HOME/.config/ai-image-playground/deploy-dispatch.token}
pause_file=${DEPLOY_PAUSE_FILE:-$HOME/.config/ai-image-playground/deploy-auto.pause}
state_file=${DEPLOY_STATE_FILE:-$HOME/.cache/ai-image-playground/deploy-debounce-state.json}
debounce_min=${DEPLOY_DEBOUNCE_MINUTES:-10}
max_wait_min=${DEPLOY_MAX_WAIT_MINUTES:-45}
max_retries=${DEPLOY_MAX_RETRIES:-2}
retry_cooldown_min=${DEPLOY_RETRY_COOLDOWN_MINUTES:-15}

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

as_uint() {
  case $1 in
    '' | *[!0-9]*) echo 0 ;;
    *) echo "$1" ;;
  esac
}

read_state() {
  observed_head_sha=
  observed_head_at=0
  first_unshipped_at=0
  shipped_sha=
  last_dispatch_sha=
  last_dispatch_id=
  last_dispatch_at=0
  dispatch_attempts=0
  if [ -r "$state_file" ]; then
    observed_head_sha=$(jq -r '.observed_head_sha // ""' "$state_file" 2>/dev/null || echo '')
    observed_head_at=$(as_uint "$(jq -r '.observed_head_at // 0' "$state_file" 2>/dev/null || echo 0)")
    first_unshipped_at=$(as_uint "$(jq -r '.first_unshipped_at // 0' "$state_file" 2>/dev/null || echo 0)")
    shipped_sha=$(jq -r '.shipped_sha // ""' "$state_file" 2>/dev/null || echo '')
    last_dispatch_sha=$(jq -r '.last_dispatch_sha // ""' "$state_file" 2>/dev/null || echo '')
    last_dispatch_id=$(jq -r '.last_dispatch_id // ""' "$state_file" 2>/dev/null || echo '')
    last_dispatch_at=$(as_uint "$(jq -r '.last_dispatch_at // 0' "$state_file" 2>/dev/null || echo 0)")
    dispatch_attempts=$(as_uint "$(jq -r '.dispatch_attempts // 0' "$state_file" 2>/dev/null || echo 0)")
  fi
}

write_state() {
  mkdir -p "$(dirname "$state_file")"
  tmp=$(mktemp "$(dirname "$state_file")/.deploy-debounce-state.XXXXXX")
  jq -nc \
    --arg observed_head_sha "$observed_head_sha" \
    --argjson observed_head_at "$observed_head_at" \
    --argjson first_unshipped_at "$first_unshipped_at" \
    --arg shipped_sha "$shipped_sha" \
    --arg last_dispatch_sha "$last_dispatch_sha" \
    --arg last_dispatch_id "$last_dispatch_id" \
    --argjson last_dispatch_at "$last_dispatch_at" \
    --argjson dispatch_attempts "$dispatch_attempts" \
    '{
      observed_head_sha: $observed_head_sha,
      observed_head_at: $observed_head_at,
      first_unshipped_at: $first_unshipped_at,
      shipped_sha: $shipped_sha,
      last_dispatch_sha: $last_dispatch_sha,
      last_dispatch_id: $last_dispatch_id,
      last_dispatch_at: $last_dispatch_at,
      dispatch_attempts: $dispatch_attempts
    }' >"$tmp"
  mv "$tmp" "$state_file"
}

now=${DEPLOY_NOW_EPOCH:-$(date +%s)}
read_state

# 1. Never stack runs while a production deploy is active. Query by active status directly so
# bursts of cancelled/completed runs cannot push a long-running deploy off page 1.
for st in in_progress queued waiting pending requested; do
  st_json=$(gh_get "repos/$repo/actions/workflows/deploy.yml/runs?branch=main&status=$st&per_page=5")
  active_id=$(printf '%s' "$st_json" | jq -r '.workflow_runs[0].id // ""')
  if [ -n "$active_id" ]; then
    log "deploy already active ($active_id $st); waiting"
    exit 0
  fi
done

# 2. Fetch current main HEAD and track when main actually changed (rather than commit author time).
head_json=$(gh_get "repos/$repo/commits/main")
head_sha=$(printf '%s' "$head_json" | jq -r '.sha // ""')
[ -n "$head_sha" ] || { log "could not read main HEAD sha"; exit 1; }

if [ "$head_sha" != "$observed_head_sha" ]; then
  observed_head_sha=$head_sha
  observed_head_at=$now
  last_dispatch_sha=
  last_dispatch_id=
  last_dispatch_at=0
  dispatch_attempts=0
fi

# 3. Skip if this exact HEAD was already confirmed shipped, or reconcile our last dispatched run.
if [ "$shipped_sha" = "$head_sha" ]; then
  if [ "$first_unshipped_at" != 0 ]; then
    first_unshipped_at=0
    write_state
  fi
  log "already confirmed shipped $head_sha; idle"
  exit 0
fi

retry_cooldown_sec=$((retry_cooldown_min * 60))
if [ "$last_dispatch_sha" = "$head_sha" ] && [ -n "$last_dispatch_id" ]; then
  recent_runs=$(gh_get "repos/$repo/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=30")
  run_info=$(printf '%s' "$recent_runs" | jq -r --arg did "[$last_dispatch_id]" '
    [.workflow_runs[]? | select((.display_title // "") | contains($did))] | first |
    if . then "\(.status)\t\(.conclusion // "")" else "" end
  ')
  if [ -z "$run_info" ]; then
    if [ $((now - last_dispatch_at)) -lt 300 ]; then
      log "waiting for dispatched run $last_dispatch_id to appear"
      exit 0
    fi
    run_status=missing
    run_conclusion=missing
  else
    run_status=${run_info%%	*}
    run_conclusion=${run_info#*	}
  fi

  if [ "$run_status" != completed ] && [ "$run_status" != missing ]; then
    log "dispatched run $last_dispatch_id is still $run_status; waiting"
    exit 0
  fi
  if [ "$run_conclusion" = success ]; then
    shipped_sha=$head_sha
    first_unshipped_at=0
    write_state
    log "dispatched run $last_dispatch_id succeeded for $head_sha; idle"
    exit 0
  fi
  if [ "$dispatch_attempts" -ge "$max_retries" ]; then
    write_state
    log "dispatched run $last_dispatch_id ended ($run_conclusion) and max retries ($max_retries) reached for $head_sha; waiting"
    exit 0
  fi
  if [ $((now - last_dispatch_at)) -lt "$retry_cooldown_sec" ]; then
    write_state
    log "dispatched run $last_dispatch_id ended ($run_conclusion); cooling down before retry"
    exit 0
  fi
  log "previous dispatch $last_dispatch_id ended ($run_conclusion); retrying $head_sha"
fi

# 4. Check live production endpoints + GitHub Compare API against each side's release paths.
# Returns 0 when the side has unshipped changes (or cannot be verified), 1 when already up to date.
side_needs_deploy() {
  kind=$1
  url=$2
  pattern=$3
  if [ "$kind" = api ]; then endpoint=${url%/}/health; else endpoint=${url%/}/version.json; fi
  body=$(curl -fsS --max-time 10 "$endpoint" 2>/dev/null) || return 0
  version=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  if [ "$kind" = api ]; then
    served=$(printf '%s\n' "${version%%+*}" | sed -n 's/^\([0-9a-f]\{40\}\)$/\1/p')
  else
    served=$(printf '%s\n' "$version" | sed -n 's/^\([0-9a-f]\{7,40\}\)[+-].*/\1/p')
  fi
  [ -n "$served" ] || return 0
  case $head_sha in
    "$served"*) return 1 ;;
  esac
  compare_json=$(gh_get "repos/$repo/compare/${served}...${head_sha}" 2>/dev/null) || return 0
  cmp_status=$(printf '%s' "$compare_json" | jq -r '.status // ""')
  case $cmp_status in
    identical | behind) return 1 ;;
  esac
  truncated=$(printf '%s' "$compare_json" | jq -r '((.files | length) >= 300) or ((.total_commits // 0) >= 250)')
  [ "$truncated" = false ] || return 0
  changed_files=$(printf '%s' "$compare_json" | jq -r '.files[]?.filename')
  [ -n "$changed_files" ] || return 1
  if printf '%s\n' "$changed_files" | grep -Eq "$pattern|^pnpm-lock\.yaml$"; then
    return 0
  fi
  return 1
}

needs_deploy=false
if side_needs_deploy api "$prod_api" "$RELEASE_API_PATHS" ||
   side_needs_deploy site "$prod_web" "$RELEASE_WEB_PATHS" ||
   side_needs_deploy site "$prod_admin" "$RELEASE_ADMIN_PATHS"; then
  needs_deploy=true
fi

if [ "$needs_deploy" = false ]; then
  shipped_sha=$head_sha
  first_unshipped_at=0
  write_state
  log "production already up to date for $head_sha; idle"
  exit 0
fi

# 5. Persist first_unshipped_at and observed_head_at BEFORE checking Web checks so time spent
# merging while CI is running counts toward max_wait_min.
if [ "$first_unshipped_at" = 0 ]; then
  first_unshipped_at=$now
fi
write_state

# 6. Require main Web checks to succeed before auto-releasing.
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

# 7. Quiet-period debounce (since main last changed) with anti-starvation max-wait ceiling.
quiet_sec=$((now - observed_head_at))
[ "$quiet_sec" -ge 0 ] || quiet_sec=0
waited_sec=$((now - first_unshipped_at))
[ "$waited_sec" -ge 0 ] || waited_sec=0
debounce_sec=$((debounce_min * 60))
max_wait_sec=$((max_wait_min * 60))

if [ "$quiet_sec" -lt "$debounce_sec" ]; then
  if [ "$max_wait_sec" -eq 0 ] || [ "$waited_sec" -lt "$max_wait_sec" ]; then
    log "holding $head_sha (quiet ${quiet_sec}s/${debounce_sec}s, batch wait ${waited_sec}s/${max_wait_sec}s)"
    exit 0
  fi
  reason="auto-batch (max wait ${max_wait_min}m)"
else
  reason="auto-batch (quiet ${debounce_min}m)"
fi

# 8. Dispatch ONE incremental Deploy production run with unique dispatch_id (token via stdin).
if [ -n "${DEPLOY_DISPATCH_ID:-}" ]; then
  dispatch_id=$DEPLOY_DISPATCH_ID
else
  rand_hex=$(od -An -tx1 -N4 /dev/urandom 2>/dev/null | tr -d ' \n' || echo 00000000)
  dispatch_id="auto-$(date -u +%Y%m%d%H%M%S)-$$-$rand_hex"
fi
payload=$(jq -nc --arg reason "$reason" --arg did "$dispatch_id" \
  '{ref: "main", inputs: {mode: "incremental", reason: $reason, dispatch_id: $did}}')
status=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 30 -X POST --config - \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$api/repos/$repo/actions/workflows/deploy.yml/dispatches" \
  -d "$payload") || status=000

case $status in
  2??)
    last_dispatch_sha=$head_sha
    last_dispatch_id=$dispatch_id
    last_dispatch_at=$now
    dispatch_attempts=$((dispatch_attempts + 1))
    write_state
    log "dispatched $reason for $head_sha (dispatch_id=$dispatch_id, attempt=$dispatch_attempts, HTTP $status)"
    exit 0
    ;;
  *)
    log "dispatch failed for $head_sha (HTTP $status)"
    exit 1
    ;;
esac
