<?xml version="1.0" encoding="UTF-8"?>
<!--
  LaunchAgent 模板：apps/bff/deploy/install.sh 会把 @@占位符@@ 替换为实际值后写到
  ~/Library/LaunchAgents/qlj.image-playground.bff.plist 并 load。

  关键设计：
  - LaunchAgent（用户级，~/Library/LaunchAgents/）而非 LaunchDaemon
    → 不需 sudo；BFF 跑当前用户身份，能访问当前用户的 .env / sqlite 文件
  - 不在 plist 里塞 env vars：bun 在 WorkingDirectory 自动读 .env
  - KeepAlive 仅在异常退出时重启，避免 install.sh load 后立刻起的轻微 race
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>qlj.image-playground.bff</string>

  <key>WorkingDirectory</key>
  <string>@@WORKING_DIR@@</string>

  <key>ProgramArguments</key>
  <array>
    <string>@@BUN_PATH@@</string>
    <string>run</string>
    <string>src/index.ts</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>@@PATH@@</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!--
    SIGTERM 到 SIGKILL 的宽限期。默认 20s 不够等图片生成（typically 30-60s），
    BFF 拿到 SIGTERM 后会 drain 在跑的 runTask 让任务跑完写到 'completed'，
    避免部署/重启时把任务卡在 in_progress 让用户看到「BFF 重启时中断」。
    BFF 内部硬上限 55s，留 5s 给 launchd 收尾。
  -->
  <key>ExitTimeOut</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>@@LOG_DIR@@/qlj-bff.log</string>

  <key>StandardErrorPath</key>
  <string>@@LOG_DIR@@/qlj-bff.err.log</string>

  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
