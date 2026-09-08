# 智能体模式：运行时框架选型调研

调研日期：**2026-09-08**。只读调研，未改动任何实现代码。

所有事实均现场读官方文档 / npm registry 得来，每条带 URL。凡未在官方来源找到的，明确写「未找到官方说明」，不做推断。

---

## 一、先钉住宿主现状（选型的硬约束）

这些是仓库内实测事实，不是假设。它们决定了下面每个候选的真实代价。

| 事实 | 证据 |
| --- | --- |
| BFF 是 Bun + Elysia，Bun 1.3.14 | `apps/bff/package.json`、`bun --version` |
| **数据库驱动是 `bun:sql`，不是 `pg`**。Drizzle 走 `drizzle-orm/bun-sql` | `packages/db/src/client.ts:1-24` |
| Elysia 1.4.28 已装，原生支持 SSE：`sse()` + `SSEPayload { id, event, retry, data }`，客户端断开时自动停 generator | `node_modules/.../elysia/dist/types.d.ts:1219-1227`；<https://elysiajs.com/essential/handler.html>（2026-09-08） |
| 已有 **Postgres 做队列** 的异步任务体系：`tasks` 表 + `task-scheduler` + `task-runner`，独立 worker 进程 `worker-index.ts` 轮询 | `packages/db/src/schema.ts:199-262`、`apps/bff/src/worker-index.ts:26-34` |
| 已有 **预扣 / 结算** 接缝，且是「在同一个 DB 事务里」：`reserveTask` / `finalizeTask` | `apps/bff/src/lib/private-overlay.ts:19-38` |
| 前端 React 19.2.1 + Zustand 5，无任何 chat / streaming 依赖 | `apps/web/package.json` |
| 生图 / 生视频工具本体已存在，是 submit + 轮询模型 | `packages/shared/src/queue-protocol.ts` |

**Cloudflare Edge 的真实约束**（决定「断线重连」的必要性与形态）：

- Cloudflare 默认 **Proxy Read Timeout = 125 秒**，超时报 524；Proxy Write Timeout = 30 秒且**不可调**；企业版可把 524 超时提到 6000 秒。
  <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/>（2026-09-08）
- 关键推论：125s 是**读间隔**超时，不是连接总时长。只要 SSE 流里每 < 125s 至少吐一个字节（心跳），长连接本身不会被 CF 掐。真正需要处理的是**客户端侧断线**（切网、锁屏、刷新页面），这才是「重连」的场景。

**Bun 的 Node 兼容性**（影响所有带 Node 依赖的候选）：

- `node:async_hooks`：🟡 `AsyncLocalStorage` / `AsyncResource` 已实现，`createHook` / `executionAsyncId` 等是 stub。
- `node:net`：🟢 完整实现（`pg` 驱动依赖它）。`node:tls`：🟡 缺 pskCallback / OCSP / session ticket。
  <https://bun.com/docs/runtime/nodejs-apis>（2026-09-08）

---

## 二、标尺：内部 agent-server 是什么形态

参照物（不选，但用来量「完整方案差多少」）：FastAPI + LangGraph 1.2 + Postgres checkpointer + LangGraph SDK 兼容 `/lgapi` SSE，需要独立 worker + Redis。

它提供的「完整方案」清单，本文每个候选都对照这 8 项打分：

1. 工具循环（多步、可控步数上限）
2. 长任务工具（几十秒到几分钟）不阻塞、可中断恢复
3. 逐 token SSE + 工具进度事件
4. **断线重连 / 追流**（客户端掉线后接回同一次 run）
5. 会话 / 消息 Postgres 长期持久化
6. 每轮 usage（含 cached tokens）可读，能包进预扣 / 结算事务
7. 上下文压缩挂钩
8. 运维形态（要不要新增进程 / 中间件）

其中 **第 4 项在 agent-server 里正是 Redis 的用途**：run 在 worker 进程里跑，API 进程要把事件转发给客户端，跨进程只能靠 pub/sub。

**我们不一定要付这个代价**：如果 agent 轮就在 API 进程里跑（不甩给 worker），跨进程 pub/sub 这个问题根本不存在，缓冲一份事件在内存 + 落 Postgres 即可支持重放。这是本次选型最重要的一条判断。

---

## 三、候选一：LangGraph JS

`@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres`（+ 可选 LangGraph Platform 自托管）

| 维度 | 结论 |
| --- | --- |
| **Bun 兼容** | **未找到官方说明**。`@langchain/langgraph` 的 `engines` 只写 `node: >=18`，`@langchain/core` 写 `node: >=20`；官方文档未提 Bun。<https://registry.npmjs.org/@langchain/langgraph/latest>（2026-09-08） |
| **OpenAI-compatible baseUrl** | 支持。走 `ChatOpenAI`（`@langchain/openai`）的 `configuration.baseURL`。文档示例用 `new ChatOpenAI({ model: "gpt-5.4-mini" })`。<https://docs.langchain.com/oss/javascript/langgraph/streaming>（2026-09-08） |
| **工具循环** | 一等公民：`StateGraph` / `createReactAgent`，图本身就是循环。 |
| **长任务工具** | 表达力最强的一档：checkpointer 让 run 可从任意 step 恢复——「if a worker is interrupted, the run can resume from the last checkpoint rather than from the beginning」。<https://docs.langchain.com/langgraph-platform/langgraph-server>（2026-09-08） |
| **流式事件形状** | `graph.stream(..., { streamMode: "messages" \| "updates" \| "values" \| "custom" })`；工具内部用 `config.writer?.(chunk)` 推自定义进度事件（`streamMode: "custom"` 收）。新版还有 `graph.streamEvents(..., { version: "v3" })`，其 `stream.messages` 投影上直接有 `message.text` 与 **`message.usage`**。<https://docs.langchain.com/oss/javascript/langgraph/streaming>、<https://docs.langchain.com/oss/javascript/langgraph/event-streaming>（2026-09-08） |
| **前端配套** | `@langchain/langgraph-sdk/react` 的 `useStream`，但它对接的是 **LangGraph Server 的 HTTP 协议**，不是随便一个自建 SSE 端点。 |
| **断线重连** | 库本身不提供。官方的追流能力在 **LangGraph Server**：「If the client opened a `/stream` connection, the API server subscribes to the pubsub channel and forwards events to the client via server-sent events」——**那个 pubsub 就是 Redis**。 |
| **是否需要 Redis** | **纯当库用：不需要。** 自托管 LangGraph Server：**需要**。官方原话：「Redis handles the signaling, cancellation, and streaming pub/sub between API servers and queue workers. It stores only ephemeral data」。<https://docs.langchain.com/langgraph-platform/langgraph-server>（2026-09-08）；`REDIS_URI` 是自托管必配环境变量 <https://docs.langchain.com/langgraph-platform/env-var>（2026-09-08） |
| **`langgraphjs` CLI / Platform 能否跑在 Bun** | **未找到官方说明**。且即使能跑，它要 Redis + 自带 Postgres schema + 自带 HTTP server（与现有 Elysia 并存 = 第二个服务），与「不引新基础设施」直接冲突。 |
| **Postgres 持久化** | 官方 `PostgresSaver.fromConnString(DB_URI)`，首次要 `await checkpointer.setup()` 建表；长期记忆另有 `PostgresStore`。<https://docs.langchain.com/oss/javascript/langgraph/add-memory>（2026-09-08） |
| **能否复用现有 Drizzle 连接** | **不能。** `@langchain/langgraph-checkpoint-postgres` 的唯一 runtime 依赖是 `pg`（node-postgres），而本仓库用 `bun:sql`。<https://registry.npmjs.org/@langchain/langgraph-checkpoint-postgres/latest>（2026-09-08）。代价：第二个 Postgres 驱动 + 第二个连接池 + 一套它自己建的表（不进我们的 Drizzle 迁移体系）。 |
| **usage（含 cached）** | `message.usage`（streamEvents v3）/ `usage_metadata`。**cached token 明细字段本次未在 JS 文档中直接读到**，标记为未验证。 |
| **上下文压缩挂钩** | 图节点本身就是挂钩点（在 call_model 前插一个 summarize 节点）。 |
| **包体 / 依赖** | `@langchain/langgraph` 4 个直接依赖 + 2 个 peer；但实际必装 `@langchain/core`（7 个依赖，含 `js-tiktoken`、`langsmith`、`mustache`、`zod`）+ `@langchain/openai` + `@langchain/langgraph-checkpoint-postgres`（拉 `pg`）。**是本次候选里依赖树最深的之一。** |
| **活跃度** | `@langchain/langgraph` **v1.4.14，2026-09-04 发布，周下载 3,019,397**；`@langchain/langgraph-checkpoint-postgres` v1.0.5，2026-08-19，周下载 308,292。<https://registry.npmjs.org/@langchain/langgraph>、<https://api.npmjs.org/downloads/point/last-week/@langchain/langgraph>（2026-09-08） |
| **许可证** | MIT |

**一句话**：能力上最贴近 agent-server（因为它就是同一个东西的 JS 版），但**它的「完整」有一半在 Server 层，而 Server 层要 Redis 且未验证能跑 Bun**。只用库层，则丢掉了追流与 `useStream`，还得为 checkpointer 引入第二套 Postgres 驱动。

---

## 四、候选二：Vercel AI SDK（`ai` v7）

| 维度 | 结论 |
| --- | --- |
| **当前大版本** | **v7**。`ai@7.0.93`，2026-09-04 发布。<https://registry.npmjs.org/ai>（2026-09-08） |
| **Bun 兼容** | `engines` 写 `node: >=22`，官方站未见 Bun 专章；但 **Elysia（Bun-only 框架）有官方 AI SDK 集成文档**，直接示范在 Elysia 路由里返回 `streamText()` 的流、`stream.toUIMessageStreamResponse()`，并注明「UI Message Stream Response will use SSE」。这是最强的 Bun 实证。<https://elysiajs.com/integrations/ai-sdk.html>（2026-09-08） |
| **OpenAI-compatible baseUrl** | 一等公民：`createOpenAICompatible({ name, baseURL, apiKey, headers, queryParams, fetch, includeUsage, transformRequestBody, metadataExtractor })`。其中 `includeUsage: true` 即 `stream_options.include_usage`；`transformRequestBody` 专为「代理型 provider」改请求体；`metadataExtractor` 用来把上游特有字段（比如缓存 token）提取进 `providerMetadata`。<https://ai-sdk.dev/providers/openai-compatible-providers>（2026-09-08） |
| **工具循环** | `ToolLoopAgent`（v7 的 agent 类）或 `generateText` / `streamText` + `stopWhen`。停止条件有 `isStepCount(n)` 与 `isLoopFinished()`。<https://ai-sdk.dev/docs/agents/loop-control>、<https://ai-sdk.dev/docs/agents/workflow-agent>（2026-09-08） |
| **长任务工具** | 工具 `execute` 就是普通 async 函数，里面轮询几分钟没有语法障碍。真正的约束不在 SDK 而在传输层（CF 125s 读超时），解法是工具执行期间往 UI stream 里写心跳 / 进度 data part。 |
| **流式事件形状** | `createUIMessageStream({ execute: ({ writer }) => ... })` + `writer.write({ type: 'data-xxx', id, data })`。**带 `id` 的 data part 会按 id 做 reconciliation（同 id 覆盖更新）**，不带 id 或标 `transient: true` 则只走 `onData` 回调不进历史。这正好是「生图任务 queued → in_progress → completed」的形状。返回用 `createUIMessageStreamResponse` / `toUIMessageStreamResponse`。<https://github.com/vercel/ai/blob/main/content/docs/04-ai-sdk-ui/20-streaming-data.mdx>（2026-09-08） |
| **前端配套** | `@ai-sdk/react` 的 `useChat`。**v4.0.96，peer 只要 `react: ^18 \|\| ~19.0.1 \|\| ~19.1.2 \|\| ^19.2.1`**——本仓库 React 19.2.1 落在允许区间内。<https://registry.npmjs.org/@ai-sdk/react/latest>（2026-09-08） |
| **断线重连** | 有官方章节 `chatbot-resume-streams`：客户端 `useChat({ resume: true })` 自动在挂载时尝试接回；服务端 POST 用 `consumeSseStream({ stream })` 把 SSE 副本交给一个「可恢复流」实现并记下 `activeStreamId`，另开一个 GET 端点用 `resumeExistingStream(id)` 续播。<https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams>（2026-09-08） |
| **是否必须 Redis** | **官方推荐路径依赖 Redis，但不是 SDK 的硬依赖。** 官方原话是开发者需「use Redis for UIMessage streams」并接 `resumable-stream` 包（v2.2.12，ISC，**零 runtime 依赖**）。该包导出 `./redis`、`./ioredis`、**`./generic`**，`generic` 允许自带 `Publisher`/`Subscriber`（需实现 publish/subscribe/set/get/incr）。<https://raw.githubusercontent.com/vercel/resumable-stream/main/README.md>（2026-09-08，via curl）<br>**更重要的是**：README 明说该包是「Designed for use in serverless environments without sticky load balancing」。我们的 BFF 是**单个长驻 Bun 进程**，根本不在这个问题域里——`consumeSseStream` 是个通用接缝，把事件顺序写进内存 ring buffer + 落一张 Postgres 表，GET 端点按 `Last-Event-ID` 重放，就能不引 Redis 地实现同一语义。 |
| **Postgres 持久化** | SDK 不带存储层，官方给的是**参考实现**：Vercel 官方示例仓库 `vercel-labs/ai-sdk-persistence-db` 就是 **PostgreSQL + Drizzle**，`chats` / `messages` / `parts` 三张表，`upsertMessage` 在一个 `db.transaction` 里删旧 parts 再插新的，`loadChat` 按 `parts.order` 还原 UIMessage。<https://context7.com/vercel-labs/ai-sdk-persistence-db/llms.txt>（2026-09-08） |
| **能否复用现有 Drizzle 连接** | **能，而且是唯一一个「表由我们自己定义」的候选**——schema 是我们写的，直接进 `packages/db/src/schema.ts` 和现有迁移体系，走 `bun:sql`，不引第二个驱动。 |
| **usage（含 cached）** | `LanguageModelUsage` 有 `inputTokens` / `outputTokens` / `totalTokens` / **`cachedInputTokens`** / `reasoningTokens`；多步下每步 usage 在 `steps[].usage`，官方 cookbook `track-agent-token-usage` 演示在 `prepareStep({ steps, context })` 里读 `lastStep?.usage?.inputTokens`「to implement context compaction strategies」。<https://ai-sdk.dev/cookbook/next/track-agent-token-usage>（2026-09-08） |
| **上下文压缩挂钩** | `prepareStep`（每步前改 messages / activeTools / toolChoice）是明确的挂钩点，且有官方专门 recipe：`agent-context-compaction`。<https://ai-sdk.dev/resources/recipes/guides/agent-context-compaction>、<https://ai-sdk.dev/docs/agents/loop-control>（2026-09-08） |
| **包体 / 依赖** | 极轻：`ai` 只有 3 个直接依赖（`@ai-sdk/gateway`、`@ai-sdk/provider`、`@ai-sdk/provider-utils`）；`@ai-sdk/openai-compatible` 2 个；`@ai-sdk/react` 6 个（含 `swr`、`throttleit`）。**是候选里依赖最少的框架。** |
| **活跃度** | `ai` **v7.0.93，2026-09-04 发布，周下载 21,639,648**；`@ai-sdk/openai-compatible` v3.0.44，同日；`@ai-sdk/react` v4.0.96，同日，周下载 5,909,960。 |
| **许可证** | Apache-2.0 |

**一句话**：8 项里唯一一项没有开箱方案的是「断线重连」，而它给了一个不绑 Redis 的接缝（`consumeSseStream` + `useChat({ resume })`），在单进程 BFF 下用 Postgres 就能补齐。其余 7 项全部有官方路径，且持久化的官方参考实现本身就是 Postgres + Drizzle。

---

## 五、候选三：Mastra

| 维度 | 结论 |
| --- | --- |
| **Bun 兼容** | **官方明确支持**：运行时列表为「Node.js `v22.13.0` or later, Bun, Deno, Cloudflare」。<https://mastra.ai/docs/deployment/overview>（2026-09-08） |
| **能否嵌进现有 Elysia** | 部分能。官方有 **Server adapters**：「Server adapters allow you to run Mastra within your own HTTP server rather than the default Hono server」，示例是 Express（`new MastraServer({ app, mastra })` + `await server.init()`）。**未找到 Elysia adapter**。另有 `registerApiRoute` 在其自带 Hono server 上加自定义路由。<https://mastra.ai/docs/server/server-adapters>、<https://mastra.ai/docs/server/custom-api-routes>（2026-09-08） |
| **OpenAI-compatible baseUrl** | 底层用 AI SDK provider 体系，可接 `@ai-sdk/openai-compatible`。（Mastra 自身也有 model router。） |
| **工具循环 / 长任务** | `createTool` + agent 循环；workflow 有 `suspend` / `resume`，状态存 storage。 |
| **流式** | `agent.stream()`；官方另有 **AI SDK UI 集成**，把 Mastra 的流转成 AI SDK 的 UI message stream 给 React 用。<https://mastra.ai/integrations/agentic-ui/ai-sdk-ui>（2026-09-08） |
| **断线重连** | **未找到官方说明。** |
| **Postgres 持久化** | `new PostgresStore({ id, connectionString })` 挂在 `new Mastra({ storage })` 上，thread / message / workflow 状态都进它。<https://mastra.ai/docs/storage>（2026-09-08） |
| **能否复用现有 Drizzle 连接** | **不能。** `@mastra/pg` 依赖 `pg` + `pg-connection-string`，接的是 `connectionString`，自建自己的表与迁移。<https://registry.npmjs.org/@mastra/pg/latest>（2026-09-08） |
| **usage（含 cached）** | 透传 AI SDK 的 usage 结构。**cached 字段本次未直接在 Mastra 文档中读到**，标记未验证。 |
| **上下文压缩** | Memory 有 `lastMessages`、semantic recall、working memory；`@mastra/memory` 依赖里带 `tokenx`（token 计数）。 |
| **包体 / 依赖** | **最重的一个**：`@mastra/core` **31 个直接依赖**，含 `@a2a-js/sdk-v0_3` + `@a2a-js/sdk-v1`、`@ai-sdk/provider-v5/v6/v7` 三套 provider 并存、`@modelcontextprotocol/server`、`posthog-node`（遥测）、`execa`、`ws`、`croner`、`xxhash-wasm`。<https://registry.npmjs.org/@mastra/core/latest>（2026-09-08） |
| **活跃度** | `@mastra/core` **v1.64.0，2026-09-03 发布，周下载 1,136,408**；`@mastra/pg` v1.22.3，周下载 509,577。版本号推进极快（1.64.x），API 面还在动。 |
| **许可证** | Apache-2.0 |

**一句话**：Bun 是官方支持这点很好，但它是**一个框架，不是一个库**——自带 server、自带 storage、自带遥测、31 个依赖、并存三套 AI SDK provider。我们已经有 Elysia + Drizzle + 私有 billing overlay 这一整套，塞一个同样想当宿主的框架进来，边界会很难维护。

---

## 六、候选四：OpenAI Agents SDK for TypeScript（`@openai/agents`）

| 维度 | 结论 |
| --- | --- |
| **Bun 兼容** | **未找到官方说明**（package 无 `engines` 字段，文档未列 runtime 矩阵）。间接证据：其核心依赖 `openai` 官方 SDK 明确支持「Bun 1.0 or later」（<https://github.com/openai/openai-node>，2026-09-08）；SDK 的 tracing 需要 `AsyncLocalStorage`，Bun 已实现该类（<https://bun.com/docs/runtime/nodejs-apis>，2026-09-08）。仍属未验证。 |
| **OpenAI-compatible baseUrl** | 支持，且是文档化路径：`setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey }))`（**要求 `openai` >= 7.2**）。第三方网关通常只有 Chat Completions，用 `setOpenAIAPI('chat_completions')` 切过去。另外应 `setTracingDisabled(true)`，否则 tracing 会往 OpenAI 官方上报。<https://openai.github.io/openai-agents-js/guides/config>、<https://openai.github.io/openai-agents-js/guides/models>（2026-09-08） |
| **工具循环** | `tool()` + `run(agent, input, { maxTurns })`。 |
| **长任务 / 断点恢复** | **这是它的强项**：`RunState.toString()` / `RunState.fromString(initialAgent, str)` 可把整个 run 状态序列化成字符串存库、之后恢复。<https://openai.github.io/openai-agents-js/openai/agents/classes/runstate>（2026-09-08） |
| **流式** | `run(agent, input, { stream: true })` 返回可 `for await` 的事件流，三类事件：`raw_model_stream_event`（原始 token）、`run_item_stream_event`（工具调用等 item）、`agent_updated_stream_event`。<https://openai.github.io/openai-agents-js/guides/streaming>（2026-09-08） |
| **断线重连** | **未找到官方说明。** 要自己在事件流外面包一层缓冲 + 重放。 |
| **前端配套** | **没有官方 React 包**。UI 事件形状要自己定义、自己在前端解析。 |
| **持久化** | 有 `Session` 概念：内置只有 `MemorySession`（进程内，退出即丢）；持久化要**自己实现 `Session` 接口的 5 个方法**（`getSessionId` / `getItems` / `addItems` / `popItem` / `clearSession`）。官方原话：「You can implement the Session interface to back agent memory with external datastores like Redis, DynamoDB, or SQLite」。<https://openai.github.io/openai-agents-js/guides/sessions>（2026-09-08） |
| **能否复用现有 Drizzle 连接** | **能**（因为存储层完全是我们写的）。这点和 AI SDK 一样好。 |
| **usage（含 cached）** | `RunState` 上的 usage 有 `inputTokens` / `outputTokens` / `totalTokens` / `requests`，以及 **`inputTokensDetails?: Record<string, number>[]`** 与 `outputTokensDetails`——cached token 会落在 details 里（字段名取决于上游 envelope）。<https://openai.github.io/openai-agents-js/openai/agents-core/classes/runstate>（2026-09-08） |
| **上下文压缩挂钩** | 只能在 `Session` 实现的 `getItems` 里做（自己决定返回哪些历史）。没有 `prepareStep` 这种「每步前改 messages」的一等回调。 |
| **包体 / 依赖** | 中等：`@openai/agents` 5 个直接依赖（`@openai/agents-core`、`@openai/agents-openai`、**`@openai/agents-realtime`**、`debug`、`openai`）。注意 realtime 包是无条件带上的，我们用不到。 |
| **活跃度** | **v0.17.0，2026-08-19 发布，周下载 1,509,397**。**仍是 0.x**，首发 2025-06-03，语义化版本上没有稳定承诺。 |
| **许可证** | MIT |

**一句话**：作为「工具循环 + 状态可序列化」的引擎很扎实，但流式 UI 与持久化都得从零建，且它硬绑定 OpenAI 官方 SDK + realtime 包，还停在 0.x。

---

## 七、候选五：Anthropic Claude Agent SDK（TS）—— 排除

**不适用，一句话结论**：它不是一个「接任意 LLM」的 agent 库，而是 Claude Code 的编程接口——SDK「bundles a native Claude Code binary for your platform as an optional dependency」，通过子进程运行（可用 `pathToClaudeCodeExecutable` 指定路径），模型侧只支持 Anthropic API / Bedrock / Vertex，**官方文档未提供任何 OpenAI-compatible 网关或自定义 OpenAI 协议 baseUrl 的接入方式**。我们的 LLM 走 sub2api 的 OpenAI 协议中转，从根上对不上。
<https://code.claude.com/docs/en/agent-sdk/typescript>（2026-09-08）

补充事实：`@anthropic-ai/claude-agent-sdk` v0.3.263，2026-09-06 发布，周下载 12,786,790，许可证 `SEE LICENSE IN README.md`（**非标准 OSS 许可证**）。<https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest>（2026-09-08）

---

## 八、候选六：自建最小循环（`openai` SDK + 自写 loop / 表 / SSE）—— 基线

| 维度 | 结论 |
| --- | --- |
| **Bun 兼容** | **官方明确支持**：`openai` SDK 支持列表含「Bun 1.0 or later」（还有 Node 22/24 LTS、Deno、Cloudflare Workers、Vercel Edge）。<https://github.com/openai/openai-node>（2026-09-08） |
| **OpenAI-compatible baseUrl** | 天然：`new OpenAI({ baseURL, apiKey })`，还能传自定义 `fetch`。 |
| **工具循环** | 自己写 while 循环：`chat.completions.create({ tools, stream: true })` → 累加 `delta.tool_calls[].function.arguments` 分片 → `finish_reason === 'tool_calls'` 时执行工具 → 追加 `role: 'tool'` 消息 → 再来一轮。官方文档明确提醒工具参数 JSON 可能非法，执行前必须校验。<https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events>（2026-09-08） |
| **长任务工具** | 完全自由——工具就是我们的函数，直接调现有 `tasks` 队列（submit + 轮询 `tasks` 表），跟现有 `task-runner` 复用同一套超时 / 重试 / 恢复逻辑。**这是唯一一个能零摩擦复用现有异步任务体系的方案。** |
| **流式** | Elysia 原生 `sse()`，`SSEPayload` 支持 `id` / `event` / `retry` / `data`，客户端断开自动停 generator。事件形状我们自己定，不受任何框架协议约束。<https://elysiajs.com/essential/handler.html>（2026-09-08） |
| **断线重连** | 自己实现：给每个事件发 `id`（单调序号），客户端重连带 `Last-Event-ID`，服务端从 Postgres 的事件表按序号之后重放。**不需要 Redis**——因为 run 在同一个 API 进程里跑，且事件已经落库。 |
| **前端配套** | 无。要自己写 SSE 客户端 + 消息状态机（React 19 + Zustand，本仓库已有 Zustand）。**这是最大的一块自建成本。** |
| **持久化** | 自己建表，进 `packages/db/src/schema.ts`，走 `bun:sql` + Drizzle，与 `tasks` / `users` 同一套迁移与测试体系。 |
| **usage（含 cached）** | 直接读上游：非流式 `usage` 含 `prompt_tokens` / `completion_tokens` / **`prompt_tokens_details.cached_tokens`** / `completion_tokens_details.reasoning_tokens`；流式需 `stream_options: { include_usage: true }`，**中间 chunk 的 usage 为 null，最后一个 chunk 给整轮总量**。<https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create>、<https://developers.openai.com/api/docs/api-reference/chat/create>（2026-09-08） |
| **上下文压缩挂钩** | 循环是我们的，想在哪压就在哪压。 |
| **包体 / 依赖** | **最小**：`openai` v7.10.0 **零 runtime 依赖**（只有可选 peer：`ws` / `zod` / `undici` / 三个 `@smithy`/`@aws-sdk` 包）。<https://registry.npmjs.org/openai/latest>（2026-09-08） |
| **活跃度** | v7.10.0，2026-09-03 发布，**周下载 27,990,712**。 |
| **许可证** | Apache-2.0 |

**一句话**：8 项全部可达，但第 3、4 项（SSE 事件形状 + 前端消费 + 重放）的代码要一行行自己写，且没有社区约定的事件协议——将来换模型、加多智能体、接 MCP 都得自己扩。

---

## 九、横向对比总表

| | LangGraph JS | **AI SDK v7** | Mastra | OpenAI Agents TS | 自建（`openai`） |
| --- | --- | --- | --- | --- | --- |
| Bun 官方说明 | 未找到 | 未找到（Elysia 官方集成为实证） | **明确支持** | 未找到 | **明确支持** |
| 自定义 baseUrl | ✅ | ✅ 一等公民 | ✅ | ✅（需切 chat_completions + 关 tracing） | ✅ |
| 工具循环 | ✅ 图 | ✅ `ToolLoopAgent` / `stopWhen` | ✅ | ✅ `maxTurns` | 自写 |
| 长任务工具 | ✅ checkpoint 恢复 | ✅ 普通 async | ✅ workflow suspend | ✅ `RunState` 序列化 | ✅ 直接复用现有队列 |
| 工具进度事件 | `config.writer` + `custom` | **`data-*` part 按 id 覆盖更新** | 透传 AI SDK | 自定义 | 自定义 |
| 前端配套包 | `useStream`（绑 LangGraph Server） | **`useChat`（React 19.2.1 兼容）** | AI SDK UI 集成 | 无 | 无 |
| 断线重连 | 仅 Server 层（要 Redis） | **官方章节；Redis 可替换** | 未找到 | 未找到 | 自建（Last-Event-ID + 事件表） |
| 需要 Redis | 库=否 / Server=**是** | **否**（`consumeSseStream` 是通用接缝） | 否 | 否 | 否 |
| Postgres 持久化 | `PostgresSaver`（自建表） | 官方 Drizzle 参考实现 | `PostgresStore`（自建表） | 自实现 `Session` | 自建表 |
| **复用现有 `bun:sql` + Drizzle** | ❌ 引入 `pg` | ✅ | ❌ 引入 `pg` | ✅ | ✅ |
| usage cached token | 未验证 | ✅ `cachedInputTokens` | 未验证 | ✅ `inputTokensDetails` | ✅ `prompt_tokens_details.cached_tokens` |
| 压缩挂钩 | 图节点 | **`prepareStep`（有官方 recipe）** | Memory 配置 | `Session.getItems` | 任意 |
| 直接依赖数 | 4（+`@langchain/core` 7 + `pg`） | **3** | **31** | 5（含 realtime） | **0** |
| 最新版 / 日期 | 1.4.14 / 09-04 | 7.0.93 / 09-04 | 1.64.0 / 09-03 | **0.17.0** / 08-19 | 7.10.0 / 09-03 |
| 周下载 | 3.02M | **21.6M** | 1.14M | 1.51M | 27.99M |
| 许可证 | MIT | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 |

---

## 十、建议

### 方案 A：Vercel AI SDK v7 当库，跑在现有 Elysia 进程里

`ai` + `@ai-sdk/openai-compatible` + `@ai-sdk/react`。`ToolLoopAgent`（或 `streamText` + `stopWhen`）跑循环；4 个工具是本进程函数，生图 / 生视频工具内部直接调现有 `tasks` 队列并轮询，期间用 `writer.write({ type: 'data-task', id: taskId, data })` 按 id 覆盖推进度（同时充当 CF 125s 心跳）；会话表自己用 Drizzle 定义（照 `vercel-labs/ai-sdk-persistence-db` 的 chats / messages / parts 三表）；重连用 `consumeSseStream` 把事件顺序写进 Postgres 事件表 + `useChat({ resume })` 接回，**不引 Redis**；预扣 / 结算包在 `streamText` 调用外层，照 `reserveTask` / `finalizeTask` 的样子加一对 `reserveTurn` / `finalizeTurn`，结算读 `steps[].usage.cachedInputTokens`。

**代价**：断线重连是 8 项里唯一需要自己实现的（官方推荐路径是 Redis，我们要写一个 Postgres 版的重放）；并且绑定了 AI SDK 的 UIMessage 数据模型，前端消息结构以后跟着它走。

### 方案 B：自建最小循环（`openai` SDK + Elysia `sse()` + 自建表）

零框架。循环、事件协议、重放、前端 store 全自己写。

**代价**：前端 SSE 消费与消息状态机是从零起的一大块（AI SDK 的 `useChat` 免费给了这块），且没有社区事件协议——后面要加多智能体 / MCP / 换 provider 时，所有扩展点都得自己设计。

### 方案 C：LangGraph JS 当库（不上 LangGraph Server）

`@langchain/langgraph` + `PostgresSaver`，图跑在 Elysia 进程里，SSE 用 `streamMode: ['messages','custom']` 自己转成前端事件。

**代价**：为 checkpointer 引入第二个 Postgres 驱动（`pg`）和一套不进我们迁移体系的表，依赖树最深；而且放弃 LangGraph Server 就同时放弃了 `useStream` 和官方追流——等于付了框架的重量却没拿到它最贵的那部分能力，还得自己补重连。

---

### 倾向：**A**

理由，逐条对着 agent-server 这把尺子：

1. **它是 8 项里唯一「只差一项」的方案**，而差的那一项（断线重连）恰好是 agent-server 用 Redis 解决的那一项——但**我们不需要 Redis 来解它**。agent-server 要 Redis 是因为 run 在 worker 进程、事件要跨进程转发；我们的 agent 轮跑在 API 进程内，事件天然同进程，落一张 Postgres 事件表 + `Last-Event-ID` 重放就够。这是本次选型最实质的一条结论，也是「不引新基础设施」能成立的原因。
2. **它是唯一不逼我们引入第二个 Postgres 驱动的框架方案**。LangGraph 和 Mastra 的持久化都自带 `pg` + 自建表；AI SDK 不带存储层，反而让表留在 `packages/db/src/schema.ts`、走现有 `bun:sql` + Drizzle + 迁移 + 测试体系。这对预扣 / 结算尤其关键——`reserveTask` / `finalizeTask` 的模式要求「计费和业务写在同一个事务里」，第三方自带连接池的存储层做不到这件事。
3. **usage 与压缩挂钩都是文档化的一等能力**，不是我们逆向出来的：`cachedInputTokens` 直接在 `LanguageModelUsage` 上，`prepareStep` 有官方的 token 追踪 cookbook 和上下文压缩 recipe。
4. **前端白拿一整块**：`useChat` + `data-*` part 的 id reconciliation，正好对上「生图任务卡片从 queued 变成 completed」这种 UI，且 peer 兼容我们的 React 19.2.1。
5. **重量最轻、活跃度最高**：3 个直接依赖、周下载 21.6M、Apache-2.0；对比 Mastra 的 31 个依赖和 OpenAI Agents 的 0.x。
6. **Bun 侧风险可控**：虽然 AI SDK 官方没写 Bun 章节，但 Elysia（Bun-only）有官方 AI SDK 集成页并直接示范 `toUIMessageStreamResponse()`，这是比一句 runtime 声明更硬的实证。

**相对 agent-server 仍然差什么（要认下来的账）**：

- **没有 durable execution**。LangGraph 的 checkpointer 能让一次 run 从任意 step 恢复（进程重启也不丢）；AI SDK 方案里，进程被 SIGKILL 时正在跑的那一轮会丢，只能靠「用户重发」或「工具侧的 `tasks` 行仍在，重发时识别已有结果」来兜。若以后真需要 run 级 durable，补法是把每步的 messages 快照落库——不是重选框架的理由。
- **没有 SDK 兼容的标准协议层**（agent-server 的 `/lgapi`）。我们的端点形状是自定的，未来若要多客户端接入需自己写规格。
- **多智能体 / handoff 编排**比 LangGraph 弱。首批只有 4 个工具、单智能体，这条暂时不构成成本。

**若否决 A**：选 **B（自建）** 而不是 C。理由是 C 付了框架的全部重量（第二个驱动、最深依赖树、外挂表）却仍要自己写重连和前端，收益不成比例；而 B 至少把复杂度全留在自己手里，跟现有 `tasks` 队列贴得最紧，随时可以后续把循环换成 AI SDK 而不动数据模型。
