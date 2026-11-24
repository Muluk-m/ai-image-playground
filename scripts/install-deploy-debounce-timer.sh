#!/bin/sh
set -eu
# 在 macmini2 上安装静默合批自动发布器（launchd 每 2 分钟跑一次 scripts/deploy-debounce-tick.sh）：
# main 上有未上线提交且 Web checks 通过后，连续 10 分钟无新合并（或首条待发提交已等满 45 分钟）
# 自动触发一次增量 Deploy production。重复执行即更新。
#
# 常用操作：
#   暂停：touch ~/.config/ai-image-playground/deploy-auto.pause
#   恢复：rm -f ~/.config/ai-image-playground/deploy-auto.pause
#   卸载：launchctl bootout "gui/$(id -u)/com.muvloom.deploy-debounce" && rm -f ~/Library/LaunchAgents/com.muvloom.deploy-debounce.plist
#
# token：只对本仓库有 Actions 读写 + Contents 只读权限的 fine-grained PAT，放到
# ~/.config/ai-image-playground/deploy-dispatch.token（chmod 600）。

label=com.muvloom.deploy-debounce
here=$(cd "$(dirname "$0")" && pwd)
bin_dir=$HOME/.local/bin
log_dir=$HOME/Library/Logs/ai-image-playground
plist=$HOME/Library/LaunchAgents/$label.plist
interval=${DEPLOY_TICK_INTERVAL_SECONDS:-120}
debounce_min=${DEPLOY_DEBOUNCE_MINUTES:-10}
max_wait_min=${DEPLOY_MAX_WAIT_MINUTES:-45}

mkdir -p "$bin_dir" "$log_dir" "$HOME/Library/LaunchAgents"
install -m 755 "$here/deploy-debounce-tick.sh" "$bin_dir/muvloom-deploy-debounce-tick.sh"
install -m 644 "$here/lib/release-paths.sh" "$bin_dir/muvloom-release-paths.sh"

cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$bin_dir/muvloom-deploy-debounce-tick.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>DEPLOY_DEBOUNCE_MINUTES</key><string>$debounce_min</string>
    <key>DEPLOY_MAX_WAIT_MINUTES</key><string>$max_wait_min</string>
  </dict>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$log_dir/deploy-debounce.log</string>
  <key>StandardErrorPath</key><string>$log_dir/deploy-debounce.log</string>
</dict>
</plist>
PLIST
plutil -lint "$plist" >/dev/null

domain=gui/$(id -u)
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl print "$domain/$label" >/dev/null || { echo "$label did not load" >&2; exit 1; }

token_file=$HOME/.config/ai-image-playground/deploy-dispatch.token
[ -r "$token_file" ] || echo "warning: $token_file is missing; auto-batcher will stay idle until it exists (chmod 600)" >&2
echo "installed $label (every ${interval}s, debounce=${debounce_min}m, max_wait=${max_wait_min}m); log: $log_dir/deploy-debounce.log"
