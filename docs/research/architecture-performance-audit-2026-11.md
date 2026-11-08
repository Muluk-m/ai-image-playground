# 系统架构、数据库与性能走查（2026-11）

## 结论

当前系统的核心设计是「BFF + PostgreSQL durable task row + 独立 worker」：提交、幂等与计费预扣在事务内完成；worker 通过 fenced lease 执行；上游异步任务 ID 持久化后只轮询、不重复提交；终态写入、生成发布与计费结算走带 fence 的状态迁移。整体不需要引入第二套队列或重写成通用协议代理。

本次落地的低风险改进是 `GET /v1/queue/requests/:id` 的显式列投影。该接口只需要任务身份、状态、provider、结果 JSON 和公开错误字段；此前 `select()` 会把请求、归档、计费、租约等无关字段及可能较大的 JSONB 一并读入 Bun 进程。

## 架构调用链

```text
submit route
  -> createQueueTask (事务：任务、幂等、额度/配额、agent job)
  -> TaskScheduler.poll
  -> selectRunnableTasks (公平性与账号/provider/model 限制)
  -> claimTaskExecution (queued -> in_progress，execution token + lease)
  -> task-runner / upstream adapters (同步、fan-out、异步提交与轮询)
  -> archive/media persistence
  -> fenced finish/requeue/reconcile transition
  -> generation publication + result/status polling
```

关键实现：

- 提交：`apps/bff/src/routes/submit.ts`、`apps/bff/src/lib/taskSubmission.ts`
- 调度：`apps/bff/src/workers/task-scheduler.ts`、`apps/bff/src/workers/runnable-tasks.ts`
- 执行归属：`apps/bff/src/workers/task-execution.ts`、`apps/bff/src/db/task-transitions.ts`
- 上游：`apps/bff/src/lib/upstream.ts` 及 `apps/bff/src/lib/upstream/adapters/`
- 读路径：`apps/bff/src/routes/status.ts`、`apps/bff/src/routes/result.ts`

## 数据库走查

### 已覆盖的设计

`tasks` 是高基数核心表，包含队列状态、重试、租约、上游任务 ID、结果/归档 payload、用户归属和计费快照。现有索引覆盖：

- provider + queued + 时间/eligible 顺序的 worker 候选读取；
- lease 到期与 next retry 扫描；
- 用户历史、管理员按模型/provider/status/error 筛选；
- 任务幂等键；
- agent conversation/turn 反查。

迁移采用不可改号的追加式顺序；`packages/db/src/migrate.ts` 会检查跳过迁移，仓库规则要求已应用迁移不得改号或挪位。

### 后续候选

自动对账路径 `apps/bff/src/lib/auto-reconcile.ts` 按 `status = 'reconciling'`、`kind = 'queue'`、`next_retry_at <= now` 及租约条件扫描并按 `next_retry_at` 处理。当前只有广义的 nullable `next_retry_at` 索引，随着对账行积累会扫描并过滤其它状态和 kind。建议另开带迁移的 PR 增加 partial index，例如：

```sql
CREATE INDEX ... ON tasks (next_retry_at, id)
WHERE kind = 'queue'
  AND status = 'reconciling'
  AND next_retry_at IS NOT NULL;
```

该改动需要迁移兼容性检查和 Nain 批准，本 PR 不混入。

## 性能与可靠性风险

1. **已修复：结果元数据过读。** `apps/bff/src/routes/result.ts` 原来对 `tasks` 使用全列 `select()`；现改为六列投影。二进制输出仍走独立 object-store/range 路径，不改变结果协议。
2. **上游错误响应的缓冲上限。** `apps/bff/src/lib/upstream.ts:1525` 对所有响应直接 `await res.text()`；错误诊断虽之后截断，但超大恶意/异常 body 已经完整进入内存。可单独增加只针对 non-2xx 的 bounded reader；成功图片 JSON 不能共用同一个粗粒度上限。
3. **调度器 N+1 限制读取。** `selectRunnableTasks` 在公平性计算中按候选用户读取账号限制。它是正确性与公平性的有意成本；只有有基准数据证明调度 DB 时间成为瓶颈后才批量化，避免改变 claim 语义。
4. **异步 fan-out 并行度。** 当前 HTTP `n` 上限为 16，因此不是无界输入；若未来上调，需要引入内部有界 poll/fan-out，而不是直接 `Promise.all` 扩大并发。

## 社区方案横向调研

| 方案 | 官方事实 | 与本仓库的决策 |
| --- | --- | --- |
| PostgreSQL `FOR UPDATE SKIP LOCKED` | PostgreSQL 官方文档将其列为多个消费者处理 queue-like table 的适用语义；锁在事务结束时释放，顺序是 best-effort。 | 本仓库已有 lease/fence 与状态迁移，不能只用短事务锁替代；清理批次已使用 `FOR UPDATE SKIP LOCKED`。 |
| pg-boss | 官方文档说明其是 PostgreSQL-backed job queue，默认 claim 使用 `SELECT FOR UPDATE SKIP LOCKED`，并采用 at-least-once 语义。 | 不引入：本仓库已有计费、对账、上游 task ID、generation publication 等领域状态，迁移到通用 queue 会重复建模并增加双重 source of truth。 |
| Drizzle ORM | 官方文档支持复合、表达式、partial index，并建议通过 `generate` 生成迁移后审阅 SQL。 | 保持现有 schema-first + 追加 SQL migration 纪律；对账 partial index 适合单独实现。 |
| OpenTelemetry JS | 官方 JS 文档和 zero-code 文档主要保证 Node.js/browser 等运行时；没有 Bun 自动 instrumentation 的同等保证。 | 不因“社区成熟”直接加入自动埋点；当前先使用已有 heartbeat、接口统计与结构化日志，若要扩展应以手工关键路径计时并在 Bun 上验证。 |

来源（官方）：

- PostgreSQL `SELECT` locking clause：<https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE>
- PostgreSQL multicolumn indexes：<https://www.postgresql.org/docs/current/indexes-multicolumn.html>
- PostgreSQL partial indexes：<https://www.postgresql.org/docs/current/indexes-partial.html>
- Drizzle indexes and constraints：<https://orm.drizzle.team/docs/indexes-constraints>
- Drizzle migration generation：<https://orm.drizzle.team/docs/drizzle-kit-generate>
- pg-boss introduction：<https://pgboss.io/introduction>
- pg-boss database backends：<https://github.com/timgit/pg-boss/blob/master/docs/database-backends.md>
- OpenTelemetry JavaScript：<https://opentelemetry.io/docs/languages/js/>
- OpenTelemetry zero-code JavaScript：<https://opentelemetry.io/docs/zero-code/js/>

## 验证计划

- 结果接口：运行现有 BFF route/generation tests，覆盖 completed/failed/cancelled、匿名/用户归属和已清理任务回退到 generation history 的行为。
- 迁移候选：先在测试数据库用 `EXPLAIN (ANALYZE, BUFFERS)` 对对账扫描前后对比，再单独提交迁移 PR；不得重编号已有迁移。
- 上游 body 限制：增加只覆盖 non-2xx 超大响应的测试，确认错误码提取和持久化诊断仍保持原契约。
