# 服务端日志系统

Admin 侧栏「运维 → 服务端日志」进入独立 `/logs` 页面，内容是部署里每个容器的运行输出（ADR 0033 P3 起经只读代理读本部署的 OpenObserve，见下文「OpenTelemetry 与 OpenObserve」；没开 OpenObserve 的部署，例如测试环境，页面直接说明不可用）（stdout / stderr）：BFF、worker、Admin、发布路由、cloudflared、宿主机采集、备份与迁移，包括用户 API 的请求结果。每条记录带服务、实例、构建版本、级别、事件、消息和结构化字段；请求上下文里的 `requestId` 自动关联，带 `taskId` 的业务事件可以定位到任务。

## 使用

- 默认显示近 24 小时，按服务、日志级别、近 15 分钟 / 1 小时 / 24 小时 / 7 天或自定义时间范围查询。自定义范围最多 7 天，输入和展示统一使用北京时间。
- 关键词不区分大小写、按子串匹配消息、事件，以及请求 ID、任务 ID、链路 ID、用户、图片、路由、错误码、错误信息与堆栈、容器名这些常用字段（其他结构化字段不搜）。用完整 ID 当关键词也是子串匹配，要精确定位请用独立的请求、任务、链路、用户、图片、实例、版本筛选条件。用户与图片定位读取 pino 字段 `userId`、`mediaId`（OpenObserve 里存成 `userid`、`mediaid`）。纯文本行（cloudflared、备份脚本）没有实例号，按容器名定位。
- OpenObserve 保留 `OBS_RETENTION_DAYS` 天（默认 30），页面不再显示留存首末时间。无匹配记录不能说明此前没有故障。
- 筛选保存在 URL 中；「复制查询链接」冻结当前查询的开始和结束时间，重新打开后恢复相同范围和筛选，仍需 Admin 登录。
- 级别按钮显示当前查询中各级别数量（不受已选级别影响），总量、错误数、警告数、趋势和前 30 个事件组统计整个筛选范围，不只统计已加载的一页。事件组按服务、级别、事件名聚合；没有事件名的消息去掉行首时间戳，把 UUID、长十六进制和数字换成占位符后取前 120 字。
- 点击事件组下钻；日志详情的同请求 / 同任务 / 同链路 / 同用户 / 同图片 / 同实例 / 同版本定位会清除其他限制，只保留时间范围和所选关联条件。点击日志在详情抽屉查看消息、错误栈和字段，按需加载同容器前后各 50 行上下文；带链路的日志可「查看链路」，展开和 `bun scripts/obs.ts trace` 相同的 span 树。
- 查询栏支持 `service:worker level:error taskId:xxx`、`container:"容器名"` 与自由文本；`q:"level:error"` 将字段形式的文字作为字面关键词，自动回填的关键词使用同一格式。部署可筛选 `paid`（生产）或 `test`，输出流可筛选 stdout / stderr；只查本部署的 OpenObserve，不跨环境查询。趋势可拖选时间范围，事件组与留存信息默认折叠。跟随最新每 10 秒刷新，列表滚动或打开详情自动暂停，同一筛选条件刷新时保留上一份记录；刷新失败会提示并继续展示旧记录。加载更早日志会暂停自动刷新，保证翻页使用同一个时间范围。聚合只在首页计算；后续分页只读取日志记录和游标。每页 100 条，按时间倒序翻页，游标是最后一行的排序键（时间、实例和 Collector 写的逐条 `log_id`；没有 `log_id` 的旧日志用正文、请求、任务等字段的 md5 代替）。
- 列表以终端形式保留完整换行和缩进，横向滚动长行；点击一段日志查看结构化字段和上下文。
- 「导出已加载」导出当前已加载记录为 NDJSON，不会自动下载整个日志库。

## 概览错误面板

「今日累计」按北京时间零点统计，「最近 15 分钟新增」按滚动窗口统计（跨午夜仍包含前一天的记录）。点击计数切换对应的最新 10 条记录；计数覆盖整个窗口，每 30 秒刷新。历史记录保留，累计数量不代表当前未恢复的故障数；新旧版本切换期间缺少近期统计时回退到今日视图，不把未知显示为零。

概览按恢复证据分为「未恢复」「待确认」「已恢复」，每类单独统计整个时间窗口并展示最新 10 条。
默认先显示未恢复记录，没有时显示待确认；仅有已恢复记录时默认显示空的未恢复视图，点击已恢复可查历史。
任务失败或崩溃日志通过同一任务 ID 判断：任务仍失败为未恢复，错误之后完成为已恢复。
cloudflared 控制流关闭错误通过同一容器相邻的同原因警告确定连接编号，再匹配该连接后续的注册成功记录；
多个连接同时报错导致编号不唯一、缺少上下文、其他容器或其他连接成功，均保持待确认。
恢复时间和「恢复记录」入口保留证据；同一连接再次断开会产生新的待确认记录，不受上次恢复影响。
其他错误（包括浏览器异常）没有可靠恢复证据时保持待确认；近期无错误或版本更新本身不证明恢复。
分类只读现有任务和日志，不修改日志级别、不删除原始记录；计数为错误记录数，不是独立故障数。

服务端日志从 OpenObserve 读（ADR 0033 P3-3，`apps/admin/server/lib/server-log-source.ts`）：每次取窗口内的 ERROR/FATAL、cloudflared 的注册、断开与 Serve tunnel error，以及与这些错误同一请求、带原因字段的行，转成 `server_logs` 的行形状，再交给原来的分类 SQL 和任务、前端错误、恢复记录一起关联，规则不变。一次最多取 5000 条错误，超出时截掉最旧的（总数偏小，较早的错误可能缺恢复证据而判成「待确认」，日志里会留一条警告）；原因只给最新 300 条错误所在的请求去查。OpenObserve 读不到时服务端错误按空处理，面板其余部分照常。没开 OpenObserve 的部署（测试环境）面板只有前端错误。

API 错误展示接口、HTTP 状态、原始错误码和已记录的具体原因。通用请求失败日志可关联同一请求、服务、实例前后一分钟内的结构化错误，只有展示的 10 条记录参与关联，不改变日志条数。未知错误码保留原文；没有原因时明确提示查看相关日志，不推断故障已经恢复。原始消息、堆栈与相关日志入口继续保留。

## 图片上传诊断

图片接口拒绝业务请求时记录 `media.request_rejected`，包括用户、图片（已知时）、阶段、错误码和 HTTP 状态。图片内容校验失败另记录 `media.validation_failed`，包括格式不符、动画、像素上限、解码或预览失败等原因，以及声明类型、检测格式、字节数和尺寸；不记录图片内容。两条事件沿用请求上下文，点击「同请求」能关联 HTTP 请求结果和具体错误栈。客户端仍收到原有错误码，上传策略保持原有行为。`media.confirmation_finished` 记录实际确认操作的总耗时、各阶段 `phaseMs`、是否遇到跨实例锁占用及结果；阶段覆盖处理排队、锁等待、存储读取、哈希、解码、预览生成、存储写入与发布。`media_processing_busy` 的 `reason` 区分确认总容量满、处理队列满、排队超时与同图锁等待超时，不记录图片内容或存储签名地址。

## 采集和保留

采集不改应用代码，走 Docker 本身的日志转发（ADR 0021）：

1. `deploy/compose.app.yaml` 的 `x-log-forward` 把每个容器的日志驱动设为 `fluentd`，非阻塞异步发往本部署的 `log-collector`；`scripts/rollout-runtime.sh` 用同样的参数创建 BFF、worker、发布路由和迁移容器。Docker 本地缓存轮转上限为 3 × 10 MB，`docker logs` 照常可用；驱动或磁盘失败仍可能丢失缓存。
2. `log-collector`（Fluent Bit 5.1）在 `$XDG_CONFIG_HOME/ai-image-playground/log-forward/<部署>/forward.sock` 上收日志，每 2 秒把一批记录发到 BFF 的 `/internal/logs/ingest`（通过独立的 `bff-logs` 网络别名，内部令牌鉴权）。BFF 写入失败时回 503，采集容器保留这批数据，按退避重试；未送达的数据存在 `log-buffer` 卷，上限 256 MB。
3. Fluent Bit 将同容器、同输出流的 WARN / ERROR 标题及连续堆栈行合并，跨批次缓冲最多等待 1 秒，随后按完整记录转发；Docker 默认 tag 区分容器，采集器只对原始标签追加输出流；重发标签跳过改写，避免重复处理。BFF 以容器、驱动时间戳和原始输出的摘要去重重试批次，解析每条记录：pino 的 JSON 行保留级别、事件、请求 ID、任务 ID 和结构化字段；其他程序的纯文本行优先认时间戳后面的级别词（cloudflared 的 `INF` / `WRN` / `ERR`），没有这个词再在整行里找 `ERR` / `WARN` / `INFO`。消息里的 `error=` 不会把一条 `WRN` 抬成错误。判断不出时 stderr 记为警告、stdout 记为信息。服务名取自容器名，无法识别的记为 `other`。

采集容器停止期间，运行中的容器在内存里暂存日志，恢复后补发（每容器驱动最多缓存 4096 条，超限会丢弃）；运行时间短于停机时间的一次性容器（例如迁移）会丢失这段输出。采集容器自身的输出只留在 `docker logs`，否则会形成回路。初次部署时 `scripts/app-compose.sh` 在其他服务之前启动它，启动失败只打警告，不影响发布。Compose BFF 和动态 BFF 都声明 `bff-logs` 别名。首个兼容 BFF 启动前，HTTP 连接失败由采集器缓冲重试，不向尚未支持接口的旧发布路由发送；后续新旧兼容实例可共同接收并去重。HTTP 400/401/404/413 等不可重试响应会丢弃该批次，不能用 Retry_Limit 声称所有错误都会补发。发布收尾用 Compose 更新 admin、采集和备份。已经在跑的 cloudflared 不重建，避免每次发布都把边缘连接拆掉。

迁移 `0060_server_logs` 建表，`0061_server_logs_containers` 放宽服务名约束，`0062_server_logs_instance_at` 支持同容器上下文范围查询；只有 BFF 写入。P3 期间这张表照常写入，Admin 的日志页和概览错误面板都已改读 OpenObserve，停写和删表见 #1937。日志界面和接口都要求 Admin 会话。写入使用独立单连接池，连接超时 2 秒、语句超时 1.5 秒，避免挤占业务连接。

日志保留由持有 PostgreSQL session advisory lock 的单个维护执行者在启动时及每分钟清理，保留近 7 天、约 20 万条。保留原来的每分钟清理能力，同时避免所有 BFF／worker 重复删除同一共享数据。单次删除最多 5000 条，容量超限会逐步回落。领导连接关闭或失败后释放锁，其他实例下一周期尝试接管；每个维护 job 的领导者占用一个专用连接，跟随者不保留空闲连接。worker 的过期服务心跳与宿主机历史采样从 10 秒任务恢复循环移到独立的 5 分钟共享维护。接管或重启后可能在同一时间窗口再次清理，删除操作幂等；清理失败不阻塞业务，任务恢复、取消检测与租约续期保持原频率。

数据库日志隐藏常见密钥字段、认证头、Cookie、原始请求体、响应预览和序列化 JSON 中的用户内容，消息里的 Bearer、常见 API key、URL 密钥参数与 URL 密码也会脱敏。单行消息最多 4000 字符；多行终端记录整体脱敏后最多保留 16000 字符，结构化字段超限会标记截断。应用日志仍应遵守不输出秘密和用户原文的约定。

BFF 的 `/api/*` 与 `/v1/*` 请求用 OpenTelemetry 建链路（ADR 0033）：接着调用方的 W3C `traceparent`，在请求里打的 pino 日志自动带 `trace_id`、`span_id`，在本页用关键词搜 `trace_id` 就能查到同一请求的日志。健康检查、`/internal/*` 与静态资源不建链路。生成任务提交时把当前链路的 `traceparent` 写进 `tasks.traceparent`；worker 每次认领执行都开一个新的 `task.execute` 链路，用 span link 指回提交链路，执行期间（含中断收尾）的 worker 日志带这条新链路的 `trace_id`；提交请求的 span 带 `task.id` 属性。从任务找提交链路看 `tasks.traceparent`，从执行链路找提交链路看 span link。认领本身（含弹性名额判定）发生在执行链路之前，相关日志只带任务 ID。上游请求（CLIENT span，并把 `traceparent` 带给上游）、Vertex 限流退避（执行 span 上的事件）与 R2 读写（CLIENT span，只记操作和字节数）也各有 span（#1927）。配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（Collector 的 OTLP/HTTP 地址，不含 `/v1/traces`）时才导出 span，默认不导出；`OTEL_TRACES_SAMPLE_RATIO`（0–1，默认 1）按比例采样；`OTEL_DEPLOYMENT_ENVIRONMENT` 可选，写进 span 的 `deployment.environment.name`。

## OpenTelemetry 与 OpenObserve（ADR 0033 P2）

app.env 里 `OBSERVABILITY_ENABLED=true` 时，下一次发布由 `scripts/app-compose.sh` 拉起 `observability` profile 的三个服务。Fluent Bit 多一路输出，把多行合并之后的同一份日志发给 Collector；`server_logs` 照常接收，P3 之前两份并存。关掉开关后的下一次发布会停掉并删除这三个容器（数据卷保留），回到只有 `server_logs`。开启时 app.env 必须同时设 `OBS_PROXY_HOST_PORT`、`OBS_UI_HOST_PORT`（同一宿主机上每个部署各用一对），缺了只打警告、不启动。

- `otel-collector`（otelcol-contrib 0.165.0，上限 200 MB）：`fluent_forward` 收容器日志，OTLP/HTTP `:4318` 收 BFF 和 worker 的 span（app.env 设 `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`）。处理规则写在 `deploy/compose.app.yaml` 的 `configs.otel-collector`：pino 行拆成字段，消息作正文，用 pino 的毫秒时间，日志挂到 `trace_id`/`span_id`，级别映射成 OTel severity（cloudflared 的 `INF/WRN/ERR` 也认），没写 service 的按容器名推断；脱敏对照 `server_logs`（`packages/shared/src/redact-log.ts`），实现方式不同：键名命中私密字段（`prompt`、`messages`、`headers`、含 `token`/`secret`/`password`/`api_key` 等）的整项按任意层级删掉；正文和每个字段值里的 Bearer/Basic、`sk-`/`AIza` 形状的 key、`token=` 一类赋值、URL 账号密码、base64 图片替换掉；文本里一旦出现 `prompt:`、`content=`、`messages:`、`body:` 这类带标签的私密字段（包括字符串里嵌的 JSON），从标签起到行尾整段换成 `[REDACTED PAYLOAD]`。和 `server_logs` 的差别：字符串里嵌的 JSON 不解析，命中标签就截掉后面全部（比逐字段清更宽）；字段值截到 4000 字符、正文 16000 字符。发送队列放在 `otel-queue` 卷，OpenObserve 重启期间不丢；按字节计量，日志和链路各至多 256 MB，满了就拒收新数据，不会写满磁盘。
- `openobserve`（v1.1.2，上限 512 MB）：日志和 span 都写进 `app` 流，以 Parquet 存在 `OBS_S3_BUCKET` 的 `OBS_S3_PREFIX` 下，保留 `OBS_RETENTION_DAYS` 天（默认 30）。本地卷 `openobserve-data` 只放预写日志和查询缓存（数据缓存 1 GB、结果缓存 128 MB 封顶；宿主机约有 19 GB 空闲）。关了遥测、GeoIP 下载和模型价格同步，除 R2 外不外连。镜像没有 shell，不配容器健康检查。它自己的输出只留在 `docker logs`：转发进来会自己喂自己。
- `obs-proxy`：开源版 OpenObserve 没有只读角色，对外只开这个代理。它用自己的 `OBS_PROXY_TOKEN`（Bearer，至少 32 字符）鉴权，只放行 `POST /api/default/_search`、`GET /api/default/streams` 和 `GET /api/default/<流>/traces/latest`，OpenObserve 账号由代理代填（`apps/bff/src/ops/obs-proxy.ts`）。

worker 的断流告警、Admin 的日志页和概览错误面板经这个代理读 OpenObserve（ADR 0033 P3，#1937）。需要 app.env 设 `OBS_PROXY_URL=http://obs-proxy:5090`，令牌用同一个 `OBS_PROXY_TOKEN`。不设时视为这个部署没开观测，断流告警不观测、日志页说明不可用（测试环境就是这样）；`OBSERVABILITY_ENABLED=true` 却没设时，发布会打警告。查询客户端在 `packages/node-kit/src/obs-client.ts`，SQL 拼装在 `packages/shared/src/obs-query.ts`，CLI、Admin、BFF 共用。

查询用 `scripts/obs.ts`，不需要 Admin：

```sh
bun scripts/obs.ts task <任务ID>                 # 任务的日志 + 每次执行的 span 树
bun scripts/obs.ts trace <trace_id>              # 一条链路的 span 树和日志
bun scripts/obs.ts logs --service worker --level error --since 2h
bun scripts/obs.ts logs --grep timeout --env test
bun scripts/obs.ts sql 'SELECT upstream_model, COUNT(*) FROM "app" WHERE span_status = '"'"'ERROR'"'"' GROUP BY 1' --type traces
```

代理和 OpenObserve 界面只绑在宿主机回环地址上（`OBS_PROXY_HOST_PORT`，生产 15090、测试 15091；`OBS_UI_HOST_PORT`，生产 15080、测试 15081），不经 Cloudflare 暴露。本机查询先开 SSH 隧道，例如 `ssh -N -L 15090:127.0.0.1:15090 tx-vps`，再把 `OBS_PAID_URL` 设成 `http://127.0.0.1:15090`；看界面同理转发 15080，用 `OBS_ROOT_EMAIL` 登录。地址和令牌放在 `$XDG_CONFIG_HOME/ai-image-playground/obs.env`（`OBS_PAID_URL`、`OBS_PAID_TOKEN`、`OBS_TEST_URL`、`OBS_TEST_TOKEN`），或用环境变量 `OBS_URL`/`OBS_TOKEN` 覆盖。OpenObserve 里字段名全是小写、点换成下划线：日志 `taskid`、`service`、`event`、`severity`、`body`、`trace_id`；span `trace_id`、`span_id`、`reference_parent_span_id`、`operation_name`、`duration`（微秒）、`span_status`、`task_id`、`upstream_model`、`http_response_status_code`。

`LOG_LEVEL` 控制 BFF 与 worker 的输出级别，默认 info。PostgreSQL 属于共享的基础设施栈，暂不转发，用 `docker logs` 查看。数据库不可用时界面报告读取失败，日志在采集容器里排队等待，现场排障仍可用 `docker logs`。

页面的「采集容器状态」打开运维看板，检查 Fluent Bit 容器是否运行和宿主机采样是否新鲜。旧 BFF 内存缓冲的心跳计数已停用，不代表当前 Docker → Fluent Bit 传输状态。Fluent Bit 的重试错误用 `docker logs <部署>-log-collector-1` 查看；当前未接入其缓冲积压、丢弃量指标。

概览只计完整 ERROR / FATAL 记录与浏览器异常；旧采集器误判为 ERROR 的单独 `at ...` 堆栈行按输出流默认级别展示（stderr 为 WARN、stdout 为 INFO），列表筛选、统计和概览使用相同规则，入库原文保留。已入库的旧分行记录缺少精确行顺序，不能还原为原始多行事件；多行合并从新版采集器生效后开始。

## 断流告警

worker 的应用告警每分钟经只读代理读一次 OpenObserve 最近 1 小时最新一条日志的时间（#1940）：超过 10 分钟没有新日志（`OPS_THRESHOLDS.SERVER_LOGS_MAX_AGE_MS`）就经值班 webhook 告警，恢复后发已恢复。低流量部署每分钟也有备份、宿主机采样等周期日志，正常不会踩线。最近 1 小时一条都没有时，持续 10 分钟才报，新部署因此有宽限。读不到 OpenObserve 算这一块失明，连续失明另有告警。没配 `OBS_PROXY_URL` 的部署（测试环境）不观测。

## 上游告警

ADR 0033 P4（#1938）：worker 每分钟从 OpenObserve 里的 `upstream POST` span 聚合最近 15 分钟，按上游渠道、实际访问的主机（`server.address`：同为 openai-compat 的 OpenAI 直连和网关分开算）和模型，统计请求数、失败数和 429 数。这要求每个上游 span 都被采集：`OTEL_TRACES_SAMPLE_RATIO` 小于 1 时上游告警不观测，worker 启动时记一条 `ops.upstream_alerts_disabled`。

- `upstream-errors`：同一渠道和模型至少 10 次请求，且三成以上失败。失败 = 连接失败、响应读到一半失败（不论状态码）、5xx；4xx 是请求本身的问题（参数、内容审核），不算上游故障。用户取消、换路时掐掉的请求（span 的 `upstream_outcome = aborted`）不算请求，也不算失败。
- `upstream-throttle`：同一渠道和模型 15 分钟内至少 10 个任务碰到 429。Vertex 退避重试同一任务会留下多条 429，按任务只算一次。

告警文本列出出事的渠道和模型；回到线内发已恢复。报过的组如果之后整组没了请求（熔断或停用），或请求跌破 10 次但失败率仍在线上，都不算恢复，要等它重新有请求且回到线内；限流同理。读数缺失既不触发，也不算恢复。流里有 span 却缺上游字段（属性改名）时，这一块算读不到（计入失明轮数，连续读不到另有告警），worker 记一条 `ops.upstream_fields_missing` 警告。阈值在 `packages/shared/src/ops.ts` 的 `UPSTREAM_*`，先按 2026-11 的流量定，跑一段时间再调。API 5xx 比例、生成失败、出图变慢这三项早就有规则（`api`、`generation`、`generation-latency`，读 PostgreSQL），P4 没有重复建设。
