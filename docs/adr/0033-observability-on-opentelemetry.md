# 0033：日志与链路追踪改走 OpenTelemetry，由 Collector 送进自建 OpenObserve

日期：2026-11-19。状态：提议（P0 本地验证已通过，真实 R2 验证通过后改为已接受）。替代：ADR 0021。关联：ADR 0018，docs/deploy/server-logs.md。

2026-11-19 一个 gemini 任务执行了 5 分 13 秒，原因查不出来：worker 对一个任务只写开始和完成两条日志，任务在 BFF 和 worker 之间只靠 taskId 人工拼接，看不到每一步各花了多久。查询入口只有 Admin 网页，鉴权只认 cookie，Agent 和命令行都查不了。存储又放在业务 PostgreSQL 的 `server_logs` 表，只保留 7 天、约 20 万条，解析、脱敏、去重和保留清理都是 BFF 里的自研代码。

我们改用业内标准的三层结构，三层都不绑定厂商：

1. **埋点用 OpenTelemetry。** 业务代码只依赖 `@opentelemetry/api`；SDK 用 OTel JS 3.x 的 `@opentelemetry/sdk-trace`（取代 `sdk-trace-base`）、`context-async-hooks`（Bun 支持 AsyncLocalStorage），通过 `exporter-trace-otlp-proto` 输出 OTLP。HTTP 服务端 span 不用 `@elysiajs/opentelemetry` 插件，而是在 `request-context` 的 `withRequestContext` 边界手动建，并解析 W3C `traceparent`；匹配到路由后由 `app.ts` 的 `onBeforeHandle` 补上 span 名和 `http.route`。这样做是为了和 requestId 放在同一层，也避开 Elysia 钩子预读请求体的风险。外部传入的 `traceparent` 只用来接链路，是否采样由我们自己的采样器决定。Bun 上 OTel 的自动埋点（require hook、undici）覆盖不到 `Bun.serve` 和 Bun 的 `fetch`，所以上游请求、Vertex 退避、R2 上传、任务状态转移都在现有的少数出口函数里手动建 span。pino 保留，mixin 从当前 span 取 `trace_id`、`span_id` 写进每一行。
2. **任务跨进程按 OTel 消息语义串起来。** 提交任务时把 `traceparent` 存进 task 行（新增字段，迁移向后兼容）；worker 领取时开新的 trace，用 span link 指回提交时的 trace。这样提交、排队、执行、每次上游尝试和落盘在一条链路上，各段耗时都能直接看到。
3. **采集用 OpenTelemetry Collector（contrib 发行版）。** `fluentforward` receiver 直接接收现在 Docker fluentd 驱动的输出，容器日志的采集方式不变，只替换 Fluent Bit；同一个 Collector 接收 OTLP span。脱敏、多行合并、字段解析从 BFF 移到 Collector 的 processor；后端不可用时用 `file_storage` 在磁盘上排队。
4. **存储和查询用自建 OpenObserve。** 单容器，限制内存，数据放 R2（已有）。原生支持 OTLP，日志、追踪、指标在同一处，自带 UI 和告警。HTTP `_search` 接口用 SQL 查询。开源版没有只读角色，所以前面加一个只读代理，只放行查询接口。仓库新增 `scripts/obs.ts`，通过这个代理按 task_id、trace_id、服务、级别、时间段查询，Agent 和命令行不再依赖 Admin。

放弃的方案：
- **自建 Loki、Tempo、Grafana 全套**：至少 4 个组件，宿主机只有 3.6 GB 内存，ADR 0021 时就因此放弃过。
- **SigNoz、ClickStack**：依赖 ClickHouse，同样放不下。
- **Grafana Cloud**：不用运维，但日志要发到第三方，免费档保留期短，而且会被厂商绑定。埋点和采集都走 OTLP，以后要换只改 Collector 的 exporter。
- **继续在 `server_logs` 上补**：只能补字段，链路、耗时拆解、保留期和查询入口都还是自研，维护成本只会增加。

迁移顺序：P0 技术验证 → P1 埋点（仍写 `server_logs`）→ P2 部署 Collector 和 OpenObserve，日志双发，上线 `obs` CLI → P3 下线 ingest 接口、`server_logs` 和 Admin 日志页，「断流告警」与错误概览改为读新后端 → P4 指标与 SLO 告警。P3 之前旧链路一直保留，任何一步都可以回退。

P0 验证结果（2026-11-19，macmini2：Bun 1.3.14、`@elysiajs/opentelemetry` 1.4.11、otelcol-contrib 0.165.0、OpenObserve latest，MinIO 代替 R2）：

- **通过**：Bun 上 OTel SDK 加 Elysia 插件，10 项检查全部通过：服务端 span 能延续传入的 `traceparent`；pino 日志自动带 `trace_id`；任务行存下的 `traceparent` 能让 worker 用 span link 接回提交链路；跨 await 的父子 span 关系完整；上游请求能注入 `traceparent`；OTLP proto 导出能到达接收端。
- **通过**：Collector 的 `fluent_forward` receiver 能在 Docker 宿主目录的 Unix socket 上接收 fluentd 驱动的数据；`transform` 用 `ParseJSON` 能把 pino 行拆成字段，纯文本行原样入库。
- **通过**：OpenObserve 以 S3 协议存储时，日志、trace 和索引都以 Parquet 写入桶中；`_search` 能按 `taskid` 查到日志，也能按 trace 查到 span。常驻内存：OpenObserve 约 230 MB（限制 512 MB），Collector 约 42 MB（限制 200 MB）。
- **不成立，改方案**：OpenObserve 开源版没有 RBAC，服务账号默认拥有全部权限。企业版每天 50 GB 以内免费，但 RBAC 需要另外部署 OpenFGA。改为在 OpenObserve 前面放一个只读代理，只放行 `_search` 和 trace 查询路径，用独立 token 鉴权，由代理代填 OpenObserve 凭据。
- **未验证**：真实 R2。需要新建 R2 桶和访问密钥，属于改 Cloudflare 的操作，要 Nain 批准后在 P2 验证。

P0 中发现、实施时必须处理的问题：
- Collector 启动时不会清理遗留的 socket 文件。进程崩溃后再启动会因为地址已被占用而失败，启动前要先删掉旧 socket。
- OpenObserve 会把字段名统一转成小写（`taskId` 存成 `taskid`）。日志字段规范改用小写 snake_case，比如 `task_id`、`elapsed_ms`，查询时不必猜大小写。
- pino 输出的级别是数字（30 表示 info），要在 Collector 里映射成 OTel 的 severity 文本。
- OTel 各包的大版本不一致（api 1.x、sdk-trace-base 2.x、core 3.x），接入时按同一个发布批次统一锁定版本。
- 生产镜像用的是 `oven/bun:1-slim`（CI 是 Bun 1.4.3）；P1 要在生产 Bun 版本上重跑一遍 P0 检查。

P2 实施（2026-11-20，macmini2 端到端：Docker fluentd 驱动 → Fluent Bit 5.1.3 → otelcol-contrib 0.165.0 → OpenObserve v1.1.2 → MinIO；另发 OTLP span；经只读代理用 `scripts/obs.ts` 查回）：

- **日志双发不换采集入口**：Docker 驱动仍只连 Fluent Bit，Fluent Bit 多一路 `forward` 输出到 Collector，多行合并在 Fluent Bit 里已经做完。P3 再决定是否让 Collector 直接接 Docker 驱动。
- **Fluent Bit 5 的 forward 默认发 `[[时间, 元数据], 记录]`，Collector 的 `fluent_forward` 直接拒收整批**（`unknown type of value ... at Time`，只在 debug 日志里看得到）。输出设 `time_as_integer: true` 改发旧格式；丢掉的毫秒由 Collector 用 pino 自己的 `time` 字段补回。`fluentd_compat: true` 不解决这个问题。
- **OpenObserve 每个部署一套**（paid、test 各一个，同一个桶用不同前缀），跟着各自的发布走，测试数据不进生产实例。实测常驻：OpenObserve 约 180 MB，Collector 约 50 MB。
- OpenObserve 镜像是 distroless，没有 shell 和 curl，不配容器健康检查；默认还会外连下载 GeoIP 库、同步模型价格，均已关闭。
- 0.165 起组件名 `otlphttp`、`fluentforward` 已弃用，改用 `otlp_http`、`fluent_forward`。
- 字段名小写、点换下划线：span 属性 `task.id` 存成 `task_id`，日志字段 `taskId` 存成 `taskid`。

代价：观测后端和生产服务在同一台 VPS 上，要占内存；宿主机挂掉时日志 UI 也不可用，但数据在 R2 里，可以在别处起一个 OpenObserve 读取。多了 Collector 和 OpenObserve 两个组件要升级和监控。Bun 上需要手动埋点，新增上游或存储出口时要记得建 span，靠评审保证。
