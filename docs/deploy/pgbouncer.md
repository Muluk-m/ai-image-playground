# PgBouncer 事务连接池与连接预算（ADR 0034 / PR-6.2）

单台 VPS 上 `paid`、`test` 与滚动发布排空期的双代次 BFF / worker 共用同一个 PostgreSQL 17 实例（默认 `max_connections = 100`）。本手册说明可选的共享 PgBouncer 事务连接池接入、session 级特性的直连绕过策略与回滚步骤。

## 连接拓扑与预算

| 角色 / 路径 | 连接目标 | 连接池 / 上限 | 说明 |
| --- | --- | --- | --- |
| BFF 常规业务与事务锁（`pg_advisory_xact_lock`） | `APP_DATABASE_URL`（启用时 `pgbouncer:6432`） | `DATABASE_POOL_MAX=6`（客户端） | 事务池复用后端连接 |
| Worker 常规任务调度与结算 | `APP_DATABASE_URL`（启用时 `pgbouncer:6432`） | `DATABASE_POOL_MAX=4`（客户端） | 含 `analysis-runner` 显式 `BEGIN..COMMIT` 事务 |
| BFF / Worker `mediaObjectLock`（`pg_try_advisory_lock`） | `APP_DIRECT_DATABASE_URL` → `postgres:5432` | 惰性创建直连池 `max <= 2` | 未设直连地址时复用主池（零额外连接） |
| BFF `CanvasSyncRooms`（`LISTEN canvas_changed`） | `APP_DIRECT_DATABASE_URL` → `postgres:5432` | 每 BFF 实例惰性 `max = 1`（`bff-canvas-listener`） | 仅首个画布 WebSocket 进入房间后建立长监听连接 |
| Worker `shared-maintenance`（`pg_try_advisory_lock` + `pg_backend_pid`） | `APP_DIRECT_DATABASE_URL` → `postgres:5432` | 领导者 `max = 1`，跟随者 `0` | 仅维护领主占一条长连接 |
| `migrate`（DDL / `pg_advisory_lock` / `CREATE INDEX CONCURRENTLY`） | `MIGRATOR_DATABASE_URL` → `postgres:5432` | 一次性短任务 | 永不经过 PgBouncer |
| `admin` / `pg-backup`（`pg_dump`） | `ADMIN_DATABASE_URL` → `postgres:5432` | `DATABASE_POOL_MAX=6` | 保持直连避免影响夜间 `pg_dump` |
| PgBouncer → PostgreSQL 后端上限 | `deploy/pgbouncer/pgbouncer.ini` | `default_pool_size=15`、`reserve_pool_size=5`、`max_db_connections=30` | 两套环境 PgBouncer 峰值合计 `<= 60` + 直连（Admin `<= 12`、监听 `<= 4`、维护领主 `<= 2`、媒体锁 `<= 8`、`pg_dump`/`migrate` 短连）仍稳定低于 `max_connections = 100` |

## 事务池兼容保障

1. **Prepared Statements**：`pgbouncer.ini` 开启 `max_prepared_statements = 200`（PgBouncer 1.24 原生协议级支持）；应用侧亦支持 `DATABASE_PREPARE=false` 作为兼容开关。
2. **启动参数与超时保护**：Bun SQL 启动参数携带 `statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout`。`pgbouncer.ini` 将这三项列入 `ignore_startup_parameters` 避免握手报错，同时 `postgres-provision` 为每个 `app_user` 角色设置同等默认 GUC（`60s` / `10s` / `60s`），确保经连接池执行的语句依旧受服务端超时约束。
3. **最小权限动态鉴权（SCRAM-SHA-256）**：`pgbouncer-provision` 仅在维护库 `postgres`（不触碰业务库与 `pg_dump`）中创建非超级用户 `pgbouncer_auth` 与 `SECURITY DEFINER` 函数 `pgbouncer.get_auth(text)`，显式排除 `rolsuper` 与已过期角色；PgBouncer 无需超级用户凭据，也无需在 `infra.env` 重复存放各业务角色密码；健康检查经 `pgbouncer_auth` 执行 `SELECT 1` 端到端校验鉴权链路。
4. **入口凭据隔离**：`scripts/docker-entrypoint.sh` 仅在 `bff` / `worker` 且配置了 `APP_DIRECT_DATABASE_URL` 时将其映射为 `DIRECT_DATABASE_URL`，未配置时显式 `unset DIRECT_DATABASE_URL`；`migrate`、`admin`、`host-collector` 与 `obs-proxy` 启动前统一清理 `APP_DIRECT_DATABASE_URL` 与 `DIRECT_DATABASE_URL`，防止错配或凭据泄漏。

## 启用步骤（按需开启，默认关闭）

1. 在宿主机 `infra.env` 中追加强密码 `PGBOUNCER_AUTH_PASSWORD=...`。
2. 重新运行对应环境的 `scripts/infra-compose.sh provision`（为 `app_user` 写入角色级默认超时，幂等安全）。
3. 开通最小权限鉴权角色与函数：
   ```sh
   scripts/infra-compose.sh provision-pooler
   ```
4. 启动共享 PgBouncer 容器并等待健康检查通过：
   ```sh
   scripts/infra-compose.sh up-pooler
   ```
5. 在部署描述（如先在 `deploy/deployments/test.json`，验收后再到 `prod.json`）的 `database` 段设置 `"pooler": true`，按配置中心流程渲染下发并在下一轮发布生效。

## 回滚步骤

- 在对应 `deploy/deployments/<env>.json` 中移除 `"pooler": true`（或手工将 `app.env` 的 `APP_DATABASE_URL` 改回 `@postgres:5432` 并删除 `APP_DIRECT_DATABASE_URL`），触发一次常规发布即可即时切回直连，无需停止或重置 PostgreSQL。
