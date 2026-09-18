# macmini2 旧备用服务

状态：2026-09-18 已休眠。BFF、worker、PostgreSQL、MinIO 均停止，Tunnel LaunchAgent 已禁用；镜像、配置及数据卷保留。生产运行在 VPS。

## 配置位置

| 项目 | 值 |
| --- | --- |
| 主机 / 目录 | `macmini2` / `/Users/mac/services/aip-free-recovery-20260918` |
| Compose | `compose.json`，project `aip-free-recovery` |
| 本机 / 外部 API | `127.0.0.1:38377` / `backup-api.muvloom.online` |
| PostgreSQL | PG 17，库 `aip_recovery`，卷 `aip-free-recovery_postgres` |
| 对象存储 | R2 `ai-images`，前缀 `recovery-legacy-20260918/` |
| 原 MinIO 卷 | `aip-free-recovery_objects`，仅留作回滚 |
| Tunnel | `~/Library/LaunchAgents/com.muvloom.recovery-tunnel.plist` |
| 历史镜像 | `aip-free-recovery:15f67181` |

凭据在服务目录的 `app.env`、`operator-config.json`、`channels.json` 和 Tunnel 配置中，不提交仓库。该旧环境使用匿名免费模式，不具备生产账号、积分和云同步能力；正式接管须按[冷恢复手册](cold-recovery.md)恢复最新生产快照。

## 启动与停止

在 macmini2 执行。以下仅启动保留的旧环境，不同步生产数据：

```sh
cd /Users/mac/services/aip-free-recovery-20260918
docker compose -p aip-free-recovery -f compose.json start postgres
# 确认 PG 健康后启动应用
docker compose -p aip-free-recovery -f compose.json start bff worker
curl -fsS http://127.0.0.1:38377/health
# 需要对外开放时再启用 Tunnel
launchctl enable gui/$(id -u)/com.muvloom.recovery-tunnel
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.muvloom.recovery-tunnel.plist
```

停止前核对生成任务和智能体调用均已结束，保存数据库快照：

```sh
launchctl disable gui/$(id -u)/com.muvloom.recovery-tunnel
launchctl bootout gui/$(id -u)/com.muvloom.recovery-tunnel
docker compose -p aip-free-recovery -f compose.json stop -t 60 bff worker postgres
```

变更镜像或 schema 须先验证迁移。禁止 `down -v` 或删除历史卷。

## 数据与审计

- 原承接期 10 条任务及关联对话、产物已回填。停机时旧库共 16 条任务（14 完成、2 失败）；另外 6 条在切回界定时间之后，尚未在本次操作中归并，禁止重复或未经归属核对导入。
- 停机快照：服务目录 `shutdown-20260918/`；工作站副本：`~/.config/ai-image-playground/recovery/cold-20260918/legacy-shutdown-20260918/`。
- 原 14 个 MinIO 对象已迁 R2 并逐个验 SHA-256。原配置保留为 `*.before-r2-20260918`。
- 回填审计：工作站 `~/.config/ai-image-playground/recovery/20260918/import-to-vps/`，VPS `/home/ubuntu/backups/recovery-import-20260918/`。
- 浏览器画布、缓存产物和草稿在原站点 IndexedDB；完整对话在对应 PG，本地画布不等于对话备份。

事故期间曾通过 `switch-pages.sh` 改 API 配置。该方式只影响新加载页面，旧页面仍可能向备用写入；不作为后续灾备切换入口。
