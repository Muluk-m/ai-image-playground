# 生产只读排查

Agent 查生产问题时能做什么、不能做什么。默认只读：先拿证据，再报告，写操作一律等 Nain 批准。发布与回滚见 [Agent 发布手册](release.md)。

## 能直接做的只读操作

### 版本与健康

`/health` 与各站 `version.json` 的 `curl`，命令见发布手册「上线核对」。

### 服务端日志

首选 Admin「运维 → 服务端日志」（`/logs`），能按服务、级别、请求 ID、任务 ID、用户筛选，保留近 7 天，用法见[服务端日志系统](../deploy/server-logs.md)。Admin 数据库角色是 SELECT-only。

Admin 里查不到的（采集容器自己的输出、PostgreSQL、采集故障期间），用 remote-access skill 在 VPS 上读 `docker logs`（本地 Docker 只缓存 3 × 10 MB）：

```sh
R=~/.claude/skills/remote-access/scripts/remote.py
python3 $R exec tx-vps -- docker ps --format '{{.Names}}'
python3 $R exec tx-vps -- docker logs --since 30m --tail 500 <容器名>
python3 $R exec tx-vps -- sh -lc 'docker logs --since 1h <容器名> 2>&1 | grep -i error | tail -50'
```

容器名先用 `docker ps` 查，不要猜。BFF 和 worker 带发布代号，形如 `image-playground-paid-r<时间>-<编号>-bff` / `-worker`，每次发布都会变；其余是 `<project>-admin-1`、`<project>-log-collector-1`、`<project>-release-router`、`<project>-cloudflared-1`，PostgreSQL 是共享的 `image-playground-infra-postgres-1`，segmenter 是 `image-playground-segmenter`。`<project>` 是 `image-playground-paid`、`image-playground-internal` 或 `image-playground-test`。

带管道、重定向的命令包在 `sh -lc '...'` 里。输出里如果出现 key、token、Cookie 或用户原文，转述时打码，不原样贴出。

### 只看配置项的名字

确认某个环境变量配没配，只打印变量名，不打印值：

```sh
python3 $R exec tx-vps -- sh -lc \
  'grep -oE "^[A-Za-z_][A-Za-z0-9_]*=" ~/.config/ai-image-playground/apps/<project>/app.env | cut -d= -f1'

# 只问某一项有没有设置
python3 $R exec tx-vps -- sh -lc \
  'grep -qE "^OPENAI_API_KEY=.+" ~/.config/ai-image-playground/apps/<project>/app.env && echo set || echo missing'
```

不要 `cat`、`grep` 出整行，也不要在容器里跑 `env` / `printenv` 看值。

### Sentry

Sentry MCP 已连接，可用的只读工具：`find_organizations`、`find_projects`、`search_issues`、`search_errors`、`search_logs`、`search_traces`、`search_replays`、`get_sentry_resource`、`find_dropped_events` 等。

注意：本仓库目前没有接入 Sentry SDK，组织里也没有 Muvloom 的项目，所以这里查不到本产品的错误。产品的服务端异常和浏览器异常都在 Admin `/logs` 里（浏览器异常经 `client-errors` 上报）。以后接入 Sentry 时再补上项目名。

Sentry 里的写操作和花钱的操作不能自己做：`update_issue`（改状态、指派）要 Nain 批准；`analyze_issue_with_seer` 会跑付费 AI 分析，只在 Nain 明确要求时用。

## 禁止的写操作（没有 Nain 批准一律不做）

- 对生产数据库跑脚本或手写 SQL，包括「只是查一下」的 `psql` 和 `bun run` 脚本，也包括迁移、补数据、改余额或订单。生产数据查询走 Admin 页面。
- 打印、复制、转发任何 key、token、密码、Cookie、`app.env` 的值或 `operator-config.json` 里的机密。
- 不备份就改 `app.env` / `operator-config.json`；备份了也要先有批准。步骤见发布手册「服务器上的配置与共享组件」。
- 重启、重建、停止、删除容器（`docker restart`、`app-compose.sh up`、`compose down`、`--force-recreate` 等）。
- 手动发布、回滚、改 `current` / `route.json` / `activated/`、动共享 segmenter。
- 删除镜像、卷、发布目录、备份或日志。
- 改 Cloudflare（DNS、Pages、tunnel、Access、R2）和 GitHub 设置、secret、分支保护。
- 在生产站用真实用户账号操作，或用生产账号下单、充值、批量生成。测试用测试环境和测试账号。

遇到只有写操作才能解决的问题：把证据（日志片段已打码、版本、时间、影响范围）和建议的操作写清楚，交给 Nain 决定。
