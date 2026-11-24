-- 记录 CLI 连接的客户端 User-Agent（版本与 OS/架构，例如 muvloom-cli/0.2.7 (darwin/arm64)），
-- 便于用户在「已连接的插件」列表里区分多台设备与不同版本。只加可空列，兼容新旧后端。
ALTER TABLE "cli_connections" ADD COLUMN IF NOT EXISTS "user_agent" text;
