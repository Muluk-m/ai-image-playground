# macmini2 备用后端运行手册

状态核验时间：2026-09-18（Asia/Shanghai）。这是当前事故恢复部署，不是 PostgreSQL 高可用副本。部署位置和流量切换完成后，必须同步更新本文件及根目录 `CLAUDE.md`，避免其他 session 按过期状态发布。

## 当前入口与拓扑

| 项目 | 当前值 |
| --- | --- |
| 对外备用 API | `https://backup-api.muvloom.online` |
| 网页入口 | `https://muvloom.online`、`https://image.nainma.online`、`https://image-playground.qiliangjia.one` |
| SSH 主机 | `macmini2` |
| 服务根目录 | `/Users/mac/services/aip-free-recovery-20260918` |
| Compose 文件 / project | `compose.json` / `aip-free-recovery` |
| BFF 本机入口 | `127.0.0.1:38377` → 容器 `37377` |
| 数据库 | 独立 PostgreSQL 17；库名 `aip_recovery` |
| 对象存储 | 本机 MinIO，bucket `aip-recovery`；不依赖原 VPS 对象存储 |
| PostgreSQL 数据卷 | `aip-free-recovery_postgres` |
| MinIO 数据卷 | `aip-free-recovery_objects` |
| Tunnel | 独立 Cloudflare Tunnel，原生 cloudflared HTTP/2 |
| Tunnel 守护 | `~/Library/LaunchAgents/com.muvloom.recovery-tunnel.plist` |
| 线上源码基线 | public `3be694f8`，private `79fc805` |
| 已构建后端镜像 | `aip-free-recovery:c8d3db11`（同一修复的合并前代码；后端版本标识为 `3be694f8…-free-recovery`） |

原 `api.muvloom.online`、`api.nainma.online` 已恢复指向 VPS tunnel。网页通过 `runtime-config.json` 访问备用域名，不是通过劫持原 API DNS 实现恢复。内部原 API `image-api.qiliangjia.one` 也没有改 DNS。

Colima/Docker 必须运行。BFF、worker、PG、MinIO 使用 `unless-stopped`；Tunnel LaunchAgent 使用 KeepAlive。空闲容器实测总内存约 403 MiB，不含 Docker VM 开销。用户积分暂不扣减，但上游 API 仍消耗相应 key 的额度。

## 运行配置与权限

`app.env`、`operator-config.json`、`channels.json`、`tunnel-config.yml` 位于服务根目录。凭据仅在受保护的服务器配置中，不写入仓库或 Pages。工作站备份位于 `~/.config/ai-image-playground/recovery/20260918/`；原始发布配置为 `pages-primary.env`，备用配置为 `pages-backup.env`，当前工作站 `pages.env` 已选备用 API。

当前 operator 能力：`accounts:local-recovery=true`、`accounts:login=false`、`accounts:self-register=false`、`accounts:sync=false`、`billing:credits=false`。图片、智能体和可用视频通道保持开启，保留每日生成限额。不要为了解决历史消息缺失临时打开登录/云同步：备用库没有原账号与数据。

GPT、Grok、Gemini 使用用户提供的独立 key，经 `https://sub2api.qiliangjia.org`；Grok base URL 带 `/v1`。Agnes、Ark 沿用已有配置。不要在日志、截图、commit 或 PR 中输出 key。

## 检查与启动

在 macmini2 上执行：

```sh
cd /Users/mac/services/aip-free-recovery-20260918
/opt/homebrew/bin/docker compose -f compose.json ps
curl -fsS https://backup-api.muvloom.online/health
curl -fsS https://backup-api.muvloom.online/api/capabilities
/opt/homebrew/bin/docker compose -f compose.json logs --tail 100 bff worker
```

启动或更新后端的顺序：

```sh
/opt/homebrew/bin/docker compose -f compose.json up -d postgres minio
/opt/homebrew/bin/docker compose -f compose.json --profile tools run --rm migrate
/opt/homebrew/bin/docker compose -f compose.json up -d bff worker
launchctl kickstart -k gui/$(id -u)/com.muvloom.recovery-tunnel
```

**迁移失败就停止发布。** 已完成的 schema 迁移仅更新备用库结构，不会把 VPS 数据复制过来。当前恢复镜像通过已有镜像加当前后端源码构建，Dockerfile 与源码快照在服务目录中；后续修改依赖或数据库 schema 时应重新核对完整镜像输入，不能只替换源码后假设依赖兼容。

持久化前端检出：服务目录下 `web-paid`（带 private overlay）和 `web-internal`（不带 overlay）。沿用仓库发布脚本；新代码仍须走 PR、CI 和对应版本校验。构建、安装依赖及 Docker 操作均在 macmini2 执行。

## Pages 发布与切回

服务目录下有 `switch-pages.sh`：

```sh
./switch-pages.sh backup paid
./switch-pages.sh backup internal
# VPS 已确认恢复、备用中的任务已完成后：
./switch-pages.sh primary paid
./switch-pages.sh primary internal
```

脚本调用对应 checkout 的 `scripts/pages-release.sh`，使用 `pages-remote.env` 或 `pages-primary-remote.env`；切回前会检查原 API `/health`。内部版发布需要从工作站现有、已授权的 wrangler 登录刷新公司 OAuth token：临时 `company-pages-token.env` 在本次发布后已移除，不要把过期 token 当作长期部署凭据。个人 Pages token 文件为 `pages-token.env`。

切回还必须检查原 API 的登录/同步能力、原账号可读及版本，不能仅凭 `/health` 就断言原业务恢复。发布后核对三个网页域名的 `runtime-config.json` 和 `version.json`，并同步工作站 `pages.env`。不要换网页域名，否则浏览器本地存储会隔离。

**不要 `docker compose down -v`，不要删除备用 PG/MinIO 卷。** 备用期间新增的对话和服务端产物不会自动写回 VPS；切回后仍应保留、按需迁移。原登录 Cookie 不被本次切换清除，但原服务端会话自身的到期时间不由备用服务延长。

## 本地数据和对话历史的边界

| 数据 | 持久化位置 | 当前能否读取 |
| --- | --- | --- |
| 本机已保存的画布、图片/视频内容、生成记录 | 原网页域名的 IndexedDB | 已验证可读；未下载到本机的云端内容除外 |
| 输入草稿 | `image-playground-agent-drafts` IndexedDB | 保留 |
| 原账号的完整对话消息、轮次、上下文压缩记录 | 原 VPS PostgreSQL | 备用库没有，须等原库或有效备份可读取 |
| 备用期间的新对话 | macmini2 PostgreSQL | 可读，刷新页面后会从备用库恢复 |
| 账号、积分、云同步目录 | 原 VPS PostgreSQL | 备用模式不启用 |

代码依据：`packages/db/src/schema.ts` 的 `agent_conversations`、`agent_messages`；`apps/bff/src/lib/agent/conversations.ts` 读写这些表；`apps/web/src/features/agent/store.ts` 从 `fetchMessages` 读历史，消息数组本身没有完整的本地持久化；`features/agent/lib/drafts.ts` 仅保存草稿。

`accounts:local-recovery` 会使用最后确认的本地账号命名空间；旧版没有标记时，仅在本机唯一账号明确时恢复，不合并多个账号。对话 ID 按备用 backend URL 隔离，项目的原生产对话关联仍保留。**画布能恢复不代表完整对话也有本地副本；切回恢复旧消息的前提是原 PG 数据仍完整。**

## 本次验收

- 迁移执行成功；BFF / worker / PG / MinIO 和 Tunnel 正常。
- 实际生图通过：GPT Image 2、GPT Image 2.5 Flare、Gemini 3.1 Flash Image、Grok Imagine Image 2.0、Agnes Image 2.1 Flash。
- 实际视频通过：Grok Imagine Video、Seedance 2.0 Mini。
- Agnes 视频触发上游免费用户限额，已从发现列表隐藏；Veo 缺 key 未启用。
- 原 Chrome 窗口无需重新登录；旧画布及创作记录可见，18/7/9 元素画布的内容 SHA-256 与切换前一致。
- 页面实际生图 41 秒完成；新画布和备用对话刷新后仍可读取；免费模式头像及名称已修复。
- 付费前端版本：`3be694f8+79fc805-20260917T173848Z`；内部前端版本：`3be694f-20260917T174005Z`。
- 部署修复的 public/private PR 和 main CI 均通过。验收记录在服务目录与工作站备份目录的 `evidence/`。
