# 0034：单仓模块化单体、商业代码脱敏并入与热路径渐进重构

日期：2026-11-22。状态：已全部实施完成（Phase 0–6 架构重构与 Contract Wave 1–2 全部删表/删列清理均已合入 `main`；仅余按需运维启用可选 PgBouncer 连接池）。关联：[ADR 0003](0003-agent-runtime-in-bff-process.md)、[ADR 0012](0012-agent-background-jobs-and-postgres-inbox.md)、[ADR 0023](0023-canvas-document-on-yjs.md)、[ADR 0033](0033-observability-on-opentelemetry.md)。

## 背景

服务端核心链路（事务内预扣、fenced lease、上游异步任务不重提、`reconciling` 隔离态、Admin 只读角色）在生产保持约 97.7% 成功率，但代码与协作结构已形成明显的结构性包袱：

1. **双树外挂税过高**：`private/` overlay 带来 `private.lock`、`overlay-bump.yml`、`with-overlay` 重复 CI、`pnpm-lock.yaml` private importer 脆弱性以及 61 处公开文件直引 `lib/private-overlay` 的耦合；实际 `private/` 里的代码并无机密算法，仅收款/客服二维码等静态图片与密钥/部署配置需要保密。
2. **目录扁平、上帝文件与反向依赖**：`packages/db/src/schema.ts` 单文件承载 80 张表/视图（2,271 行）；`apps/bff/src/lib/` 与 `lib/agent/` 平铺 260+ 文件；`db/task-transitions.ts`、`db/maintenance.ts`、`workers/task-scheduler.ts` 与 10 个 HTTP 路由存在跨层反向依赖；`upstream.ts`（1,858 行）、`taskSubmission.ts`（1,376 行）、`turn.ts`（1,201 行）、`billing/service.ts`（1,947 行）耦合严重。
3. **热路径表宽与多头媒体**：`tasks` 表将高频更新的调度/租约列与 4 个大 JSONB payload 列（`request_payload`、`result_payload`、`archive_payload`、`metering`）及文本诊断列（`upstream_body`）混放一行，MVCC 更新放大膨胀；`user_asset_objects` 与 `media_objects` 双轨记账；占 58% 流量的参考图改图仍通过 BFF 内存搬运 base64。
4. **单机连接预算紧绷**：3.6 GB VPS 上单实例 PostgreSQL（`max_connections=100`）迫使 BFF/Worker/Admin 连接池压到 6/4/3；`#1937 P3-5` 已停止写入 `server_logs`，仍待 P3-6 删表并引入轻量连接池缓解压力。

## 决定

1. **合并为单一公开仓库（Phase 1 优先执行），密钥、部署品牌配置与涉信息图片全外置私有 R2**：
   - 将 `private/` 中的计费、订阅、订单、邀请、飞书 OAuth 与前端/Admin 商业面板代码逻辑脱敏后并入公开主仓库，继续按 `operator-config` 能力开关默认关闭（`billing:credits=false`）。
   - 收款码/客服二维码等涉信息图片不进入仓库，统一外置至私有 R2（由 `billing_settings.payment_qr_url` / `contact_qr_url` 配置指向）；充值档位等运营参数走配置化；主仓库既有官网与指南品牌保持不变。
   - 计费迁移迁入 `packages/db/drizzle-billing/`，**保持 `migrationsSchema: 'private_billing', migrationsTable: 'migrations'` 不变**，确保现网测试/生产库无缝衔接。下线 `private.lock`、`overlay-bump.yml` 与 `with-overlay` 重复 CI。
2. **在 `apps/bff/src/modules/<bc>/` 内落地 9 大限界上下文模块化单体，保留独立只读 `apps/admin` 容器**：
   - 划分为 `identity`、`catalog`、`media`、`execution`、`billing`、`library`、`canvas`、`cms`、`agent` 九个限界上下文；跨模块只允许经 `modules/<bc>/index.ts` 公共 Facade 或领域事件通信。
   - 全部功能行为保留，并将 `lib/agent` 深度拆解为严格单向的 `contracts` → `conversation` → `inbox` → `runtime` → `tools` → `orchestration`（`batch` / `production` / `stage` / `masked`）六层子域。
   - 保留 `apps/admin` 独立进程与 `SELECT-only` 数据库角色隔离；将共用只读聚合查询下沉到共享包 `packages/read-models`，消除 BFF 与 Admin 的平行 SQL 漂移。
3. **务实边界依赖注入（不推翻现有测试体系）**：
   - 在启动装配根（`bootstrap/`）显式注入跨模块事件总线（`TaskLifecycleBus`）、计费/权益端口（`MeteringPort` / `EntitlementPort` / `AccountLifecyclePort`）、上游适配器注册表（`UpstreamRegistry`）与预留端口（`ConcurrencyGate` / `TurnBroker` / `CanvasRoomBroker`）。
   - 模块内部仓储继续沿用现有 `db/client` + 显式 `tx` 传参，保持现有测试隔离框架零破坏。
   - 引入 `scripts/check-arch-boundaries.ts` 作为 `pnpm lint` 棘轮门禁：禁止新增循环依赖、`routes -> db`、`db -> non-db`、`workers -> agent` 以及新模块深路径越界导入。
4. **热路径数据库渐进改造（零停机 Expand-Contract）**：
   - 先将 `packages/db/src/schema.ts` 按域拆为 `packages/db/src/schemas/*.ts`（`schema.ts` 原样重导出，零迁移）。
   - 后续按「建表双写 → 分批回填 → 切读验收 → 清理旧列」四步将 `tasks` 的 5 个冷 payload 列拆至 1:1 `task_payloads`，并补齐对账 partial index；推动 `user_asset_objects` 与 `cli_reference_media` 统一收敛到 `media_objects` + `media_references`，工作台改图主路径升级 R2 预签名直传 `media_id`。
5. **允许借重构做一轮接口清理**：
   - 补齐会话列表与消息读取的游标分页、移除无调用方历史遗留端点（如 `/api/looks/batch`）、消除读路径写副作用（将读消息顺带 `settleAgentJobs` 迁至任务终态监听），同步更新 `apps/web`、`apps/admin` 与 `cli-go`。
6. **维持单机紧凑拓扑，暂不上 Valkey 与多副本**：
   - 配合 ADR 0033 P3-6 完成 `server_logs` 删表清理，并在 `deploy/compose.infra.yaml` 引入轻量 PgBouncer（Transaction Pooling，约 10 MB 内存）解除连接池紧箍咒（迁移与 `LISTEN` 连接保持直连 PG）。
   - 暂不引入 Valkey 与多副本拆分，仅在代码边界预留 Port 接口，待真实并发需求到来再接入。

## 考虑过的方案

- **将主仓库改为私有仓后合并 `private/`**：私有仓会失去 GitHub Actions 公开仓免费额度与开源传播价值。否决。
- **保留双仓仅收窄 `PrivateTaskHooks`**：仍需长期维护 `private.lock`、`overlay-bump`、双套 CI 与 lockfile 三 importer 约束，无法真正减负。否决。
- **停产推倒重写或拆分为微服务 + Valkey/Kafka**：会重踩既有计费、上游无幂等、Yjs 同步等大量生产坑，且超出 3.6 GB 单机运维预算。否决。
- **合并 `apps/admin/server` 进 `apps/bff`**：虽省一个容器，但失去 PG `SELECT-only` 角色防误写隔离与 BFF 异常时运维看板可用性。否决。
- **全仓彻底去单例做全量构造函数 DI**：需要重写全部 379 个 BFF 文件及大量测试，投入产出比低于边界 DI。否决。

## 后果

- **短期**：Phase 0 先立门禁与拆 `schema.ts`（零行为变更）；Phase 1 优先合仓，完成后所有后续重构均在单仓、单套 CI 下推进。
- **安全边界**：计费结算迁入事件总线（Phase 2）与数据库热路径拆分（Phase 5）必须独立切片，严格遵守零停机前后向兼容与结算专项评审纪律；公开合仓前须逐项扫描确认零密钥、零收款/客服二维码入仓。
- **演进路径**：Phase 0（护栏与 Schema 拆包）→ Phase 1（`private/` 脱敏并入公开单仓）→ Phase 2（`TaskLifecycleBus` 断环、`taskSubmission` 与 `billing` 拆解）→ Phase 3（`upstream` 适配器化、接口清理与 `packages/read-models`）→ Phase 4（`lib/agent` 六子域拆解至 0 循环依赖）→ Phase 5（`task_payloads` 冷热分离、统一媒体与 R2 直传）→ Phase 6（`server_logs` 收尾、PgBouncer 与基线清零）。

## 实施记录（Phase 0–6）

### 已锁定架构基线（`scripts/check-arch-boundaries.ts`）

- **全服务端 0 运行时循环依赖**：`apps/bff/src`（原 85 文件巨型 SCC → 0）、`apps/admin/server`（0）、`packages/db/src`（0）、`packages/read-models/src`（0）。
- **清零的跨层反向依赖**：`routes -> db` = 0、`workers -> agent` = 0、`lib/agent -> lib/agent/tools` = 0、`modules/canvas -> agent` = 0。
- **陈旧白名单棘轮锁定**：`checkBffBoundaries(..., { checkStaleAllowlist: true })` 在 `pnpm lint` 与基线单测中强制开启；每消除一条存量例外即必须同步移出白名单，防止违规边静默回流。

### 已合入 PR 账本（`main`）

| 阶段 | PR | 摘要 |
| --- | --- | --- |
| Phase 0 | #1950 | 落盘 ADR 0034、`scripts/check-arch-boundaries.ts` 与 `packages/db/src/schemas/*.ts` 按域拆包 |
| Phase 1 | #1952 | `private/` overlay 脱敏并入公开单仓，下线 `private.lock` 与双套 CI |
| Phase 2 | #1964, #1966, #1968, #1973, #1976 | `TaskLifecycleBus` 事务内事件总线、`modules/execution` 拆解、worker 去 agent 依赖、`billing` 6 模块拆解与 3 窄端口 |
| Phase 3 | #1984, #1985, #1987, #1994 | `upstream` 无环网关与注册表、0 `routes -> db`、接口清理与 keyset 游标分页、`@image-playground/read-models` 共享只读模型包 |
| Phase 4 | #1999, #2003, #2004, #2012, #2014 | `modules/agent/{contracts,conversation,inbox,runtime,tools,orchestration}` + `modules/canvas`，全仓 0 运行时循环依赖 |
| Phase 5 | #2020, #2024, #2025, #2026, #2027 | `tasks` 对账局部索引、`task_payloads` Expand/双写/切读、统一媒体账本与零搬运回填、工作台大图预签名直传与精确下标透传 |
| Phase 6 | #2028, #2029, #2030 | 移除 PG `server_logs` 运行时清理与旧缓冲代码、可选 PgBouncer 事务连接池与 `DIRECT_DATABASE_URL` 直连路由、锁定棘轮与完结 ADR |
| Contract Wave 1 | #2033, #2034, #2035 | 删除 `server_logs` 表（`0109`）、停止读写 `user_asset_objects`、解耦 `tasks.device_id` 并停止读写 `tasks` 冷载荷列（`0110`） |
| Contract Wave 2 | #2037, 本 PR (Contract 1b) | 删除 `user_asset_objects` 表（`0111`）并挂载 `reclaimUnreferencedAssetMedia`；删除 `tasks` 5 个冷载荷列与兼容触发器（`0112`）并移除一次性回填脚本 |

## 生产回填与 Contract 收尾记录（已完成）

Phase 5–6（`v0.4.481`）上线排空、生产全量回填零差异验收以及 Contract Wave 1（`#2033` / `#2034` / `#2035`，`v0.4.484`）与 Contract Wave 2（`#2037` + 本 PR）均已完成：

1. **`task_payloads` 回填与 `tasks` 瘦身（已完成）**：生产已完成 `--repair` / `--verify-only` 零差异验收（`totalTasks = 3004`，`missingCount = 0`、`mismatchCount = 0`）；Contract 1a（`#2035` / `0110`）解耦 `tasks.device_id` 并停写 5 个冷列上线排空；Contract 1b（`0112_drop_tasks_cold_columns.sql`）移除 `0106`/`0110` 兼容同步触发器与函数并物理删除 `tasks` 5 个冷列，一次性回填脚本 `scripts/backfill-task-payloads.ts` 已随列退场移除。
2. **统一媒体账本回填与退场 `user_asset_objects`（已完成）**：生产已完成零差异回填验收（`totalLegacyAssets = 7`，5 项差异计数均为 `0`）；Contract 2a（`#2034`）已停止全部应用读写；Contract 2b（`#2037` / `0111_drop_user_asset_objects.sql`）删除 `public.user_asset_objects` 并在 `apps/bff/src/index.ts` 拆步挂载 `reclaimUnreferencedAssetMedia` 周期回收，原一次性回填脚本 `scripts/backfill-asset-media.ts` 已随表退场移除。
3. **退场 `server_logs`（已完成）**：Contract 3（`#2033` / `0109_drop_server_logs.sql`）已将 Admin 测试日志夹具迁至内存并删除 `public.server_logs` 表。
4. **（可选、按需运维启用）共享 PgBouncer 事务连接池**：代码与基础设施编排已随 `#2029` 完备，默认保持关闭；如需启用，按 [PgBouncer 连接池手册](../deploy/pgbouncer.md) 先在宿主机 `infra.env` 配置 `PGBOUNCER_AUTH_PASSWORD`，依次执行 `scripts/infra-compose.sh provision`、`provision-pooler` 与 `up-pooler`，再先后在 `deploy/deployments/test.json`、`prod.json` 开启 `database.pooler: true` 验收。
