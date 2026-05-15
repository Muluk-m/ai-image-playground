<?xml version="1.0" encoding="UTF-8"?>
<!--
  LaunchAgent 模板：apps/admin/deploy/install.sh 会把 @@占位符@@ 替换为实际值后写到
  ~/Library/LaunchAgents/qlj.image-playground.admin.plist 并 load。

  跟 BFF 同款用户级 LaunchAgent：
  - WorkingDirectory = apps/admin，bun 自动读 .env（ADMIN_PASSWORD / ADMIN_COOKIE_SECRET
    / BFF_INTERNAL_URL / DATABASE_URL / PORT 等）
  - admin 100% 只读 SQLite，无 task drain 需求；ExitTimeOut 短即可
  - admin 启动期望 BFF 已经跑过 runMigrations（device_id VIRTUAL 列等）。deploy:local
    把 BFF kickstart 排在 admin 前面，第一次升级 race 由 launchd KeepAlive 兜底。
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>qlj.image-playground.admin</string>

  <key>WorkingDirectory</key>
  <string>@@WORKING_DIR@@</string>

  <key>ProgramArguments</key>
  <array>
    <string>@@BUN_PATH@@</string>
    <string>run</string>
    <string>server/index.ts</string>
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

  <key>ExitTimeOut</key>
  <integer>20</integer>

  <key>StandardOutPath</key>
  <string>@@LOG_DIR@@/qlj-admin.log</string>

  <key>StandardErrorPath</key>
  <string>@@LOG_DIR@@/qlj-admin.err.log</string>

  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
