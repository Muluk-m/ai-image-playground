# 0033：日志与链路追踪改走 OpenTelemetry，由 Collector 送进自建 OpenObserve

日期：2026-11-19。状态：提议（P0 技术验证通过后改为已接受）。替代：ADR 0021。关联：ADR 0018，docs/deploy/server-logs.md。

2026-11-19 一个 gemini 任务执行了 5 分 13 秒，原因查不出来：worker 对一个任务只写开始和完成两条日志，任务在 BFF 和 worker 之间只靠 taskId 人工拼接，看不到每一步各花了多久。查询入口只有 Admin 网页，鉴权只认 cookie，Agent 和命令行都查不了。存储又放在业务 PostgreSQL 的 `server_logs` 表，只保留 7 天、约 20 万条，解析、脱敏、去重和保留清理都是 BFF 里的自研代码。

我们改用业内标准的三层结构，三层都不绑定厂商：

1. **埋点用 OpenTelemetry。** 业务代码只依赖 `@opentelemetry/api`；SDK 用 `sdk-trace-base`、`context-async-hooks`（Bun 支持 AsyncLocalStorage），通过 `exporter-trace-otlp-proto` 输出 OTLP。HTTP 服务端 span 由 `@elysiajs/opentelemetry` 生成，并解析 W3C `traceparent`。Bun 上 OTel 的自动埋点（require hook、undici）覆盖不到 `Bun.serve` 和 Bun 的 `fetch`，所以上游请求、Vertex 退避、R2 上传、任务状态转移都在现有的少数出口函数里手动建 span。pino 保留，mixin 从当前 span 取 `trace_id`、`span_id` 写进每一行。
2. **任务跨进程按 OTel 消息语义串起来。** 提交任务时把 `traceparent` 存进 task 行（新增字段，迁移向后兼容）；worker 领取时开新的 trace，用 span link 指回提交时的 trace。这样提交、排队、执行、每次上游尝试和落盘在一条链路上，各段耗时都能直接看到。
3. **采集用 OpenTelemetry Collector（contrib 发行版）。** `fluentforward` receiver 直接接收现在 Docker fluentd 驱动的输出，容器日志的采集方式不变，只替换 Fluent Bit；同一个 Collector 接收 OTLP span。脱敏、多行合并、字段解析从 BFF 移到 Collector 的 processor；后端不可用时用 `file_storage` 在磁盘上排队。
4. **存储和查询用自建 OpenObserve。** 单容器，限制内存，数据放 R2（已有）。原生支持 OTLP，日志、追踪、指标在同一处，自带 UI 和告警。HTTP `_search` 接口用 SQL 查询，仓库新增 `scripts/obs.ts`，按 taskId、traceId、服务、级别、时间段查询，Agent 和命令行不再依赖 Admin。

放弃的方案：
- **自建 Loki、Tempo、Grafana 全套**：至少 4 个组件，宿主机只有 3.6 GB 内存，ADR 0021 时就因此放弃过。
- **SigNoz、ClickStack**：依赖 ClickHouse，同样放不下。
- **Grafana Cloud**：不用运维，但日志要发到第三方，免费档保留期短，而且会被厂商绑定。埋点和采集都走 OTLP，以后要换只改 Collector 的 exporter。
- **继续在 `server_logs` 上补**：只能补字段，链路、耗时拆解、保留期和查询入口都还是自研，维护成本只会增加。

迁移顺序：P0 技术验证 → P1 埋点（仍写 `server_logs`）→ P2 部署 Collector 和 OpenObserve，日志双发，上线 `obs` CLI → P3 下线 ingest 接口、`server_logs` 和 Admin 日志页，「断流告警」与错误概览改为读新后端 → P4 指标与 SLO 告警。P3 之前旧链路一直保留，任何一步都可以回退。

P0 必须先验证的问题（任何一项不成立就回来改本 ADR）：
- Bun 上 OTel SDK 加 `@elysiajs/opentelemetry` 能正常解析和传递 `traceparent`，异步上下文能穿过 worker 的任务执行。
- Collector 的 `fluentforward` receiver 能接 Docker fluentd 驱动通过 Unix socket 发来的数据。
- OpenObserve 以 R2 为存储时能正常读写；常驻内存能限制在 512 MB 以内。
- OpenObserve 开源版能否给 `obs` CLI 发只读凭据。如果只读角色只在企业版提供，要另想办法，比如在 BFF 加一个只读代理。

代价：观测后端和生产服务在同一台 VPS 上，要占内存；宿主机挂掉时日志 UI 也不可用，但数据在 R2 里，可以在别处起一个 OpenObserve 读取。多了 Collector 和 OpenObserve 两个组件要升级和监控。Bun 上需要手动埋点，新增上游或存储出口时要记得建 span，靠评审保证。
