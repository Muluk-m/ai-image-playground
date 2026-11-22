#!/bin/sh
set -eu
# 在 macmini2（时区 Asia/Shanghai）上安装发布窗口定时器：launchd 在 12:30、18:30、23:30 跑
# scripts/deploy-window-tick.sh。重复执行即更新。卸载：
#   launchctl bootout "gui/$(id -u)/com.muvloom.deploy-window" && rm ~/Library/LaunchAgents/com.muvloom.deploy-window.plist
# token 另行放到 ~/.config/ai-image-playground/deploy-dispatch.token（chmod 600），见脚本头注释。

label=com.muvloom.deploy-window
here=$(cd "$(dirname "$0")" && pwd)
bin_dir=$HOME/.local/bin
log_dir=$HOME/Library/Logs/ai-image-playground
plist=$HOME/Library/LaunchAgents/$label.plist

[ "$(date +%z)" = +0800 ] || { echo "local timezone is not UTC+8; windows would fire at the wrong time" >&2; exit 1; }

mkdir -p "$bin_dir" "$log_dir" "$HOME/Library/LaunchAgents"
install -m 755 "$here/deploy-window-tick.sh" "$bin_dir/muvloom-deploy-window-tick.sh"

slot() {
  printf '    <dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>30</integer></dict>\n' "$1"
}
{
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$bin_dir/muvloom-deploy-window-tick.sh</string></array>
  <key>StartCalendarInterval</key>
  <array>
PLIST
  slot 12
  slot 18
  slot 23
  cat <<PLIST
  </array>
  <key>StandardOutPath</key><string>$log_dir/deploy-window.log</string>
  <key>StandardErrorPath</key><string>$log_dir/deploy-window.log</string>
</dict>
</plist>
PLIST
} >"$plist"
plutil -lint "$plist" >/dev/null

domain=gui/$(id -u)
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
launchctl print "$domain/$label" >/dev/null || { echo "$label did not load" >&2; exit 1; }
token_file=$HOME/.config/ai-image-playground/deploy-dispatch.token
[ -r "$token_file" ] || echo "warning: $token_file is missing; windows will not fire until it exists (chmod 600)" >&2
echo "installed $label; log: $log_dir/deploy-window.log"
