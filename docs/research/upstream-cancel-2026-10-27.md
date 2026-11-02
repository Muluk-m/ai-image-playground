# 上游取消能力调研（2026-10-27，BUG-32）

用户中止一轮时，平台已退还积分（见 [ADR 0012 修订](../adr/0012-agent-background-jobs-and-postgres-inbox.md)）。本文回答：已提交给上游的任务能不能叫停，叫停后上游还收不收钱。结论决定「中止」的真实成本落在谁身上。

实现：`apps/bff/src/lib/upstream.ts` `cancelUpstreamTasks`（只有声明了 `cancelUrl` 的线路会发请求）与 `apps/bff/src/lib/upstream-cancel.ts`（取消入口提交后直接触发；上游 id 晚于取消落库时由 `apps/bff/src/workers/task-execution.ts` 补发）；结果记 `task.upstream_cancel` 日志，`outcome` 取值 `cancelled` / `partial` / `unsupported` / `upstream_id_unknown` / `no_upstream_task`，补发的带 `late: true`。

已知限制：任务表不保存提交时的渠道快照，叫停按 provider/model 解析当前渠道；提交后渠道下线、替换或 base URL 变更，叫停可能落空（只影响上游成本，不影响退款）。

| 上游（线路） | 能否取消已提交任务 | 我们怎么做 | 取消后上游是否仍计费 | 依据 |
| --- | --- | --- | --- | --- |
| 火山方舟 Seedance（`ark-videos`） | 能，但只限**排队中**：`DELETE /api/v3/contents/generations/tasks/{id}`；运行中的任务拒绝取消 | 发 DELETE；排队中 → `cancelled`，运行中 → `rejected` | 排队中取消：不计费（按成功产出计费，取消无产出，推断）；运行中：会跑完并计费 | [方舟文档：取消或删除视频生成任务](https://ark.volcengine.com/region:cn-beijing/docs/cancel-or-delete-video-generation-tasks-api) |
| OpenAI gpt-image-2.5-flare（Responses 流式，`store:false`） | 否。`POST /v1/responses/{id}/cancel` 只对 `background: true` 的响应有效 | 断开连接（worker 中断 fetch） | 很可能仍计费（服务端可能已生成完），未证实 | [OpenAI Responses cancel](https://developers.openai.com/api/reference/resources/responses/methods/cancel)、[Background mode](https://developers.openai.com/api/docs/guides/background) |
| Grok Image / grok-imagine-video（经 sub2api 网关） | 否，网关无取消接口 | 停止轮询 / 断开连接 | 计费（网关按请求转发，上游 xAI 无取消） | 网关接口清单；见下行 xAI |
| xAI 视频（直连） | 否。只有 `POST /v1/videos/generations` + 轮询；取消接口只有批处理 `/v1/batches/{id}:cancel` | 停止轮询 | 计费 | [xAI Videos API](https://docs.x.ai/developers/rest-api-reference/inference/videos)、[Batches](https://docs.x.ai/developers/rest-api-reference/inference/batches) |
| Vertex Gemini / Nano Banana（同步） | 否，同步请求只能断开连接 | 断开连接 | 未知，很可能计费（请求已到模型） | Vertex generateContent 无取消语义 |
| Veo（Gemini API `predictLongRunning`） | 否。文档只给轮询，没有 operations.cancel | 停止轮询 | 计费 | [Gemini API Veo](https://ai.google.dev/gemini-api/docs/veo) |
| Agnes（生产已停用） | 未知，文档未见取消接口 | 停止轮询 | 未知 | — |

## 需要另行跟进

- **Veo 3.1 Preview 已于 2026-10-22 在 Gemini API 下线**，生产配置仍列着 `veo-3.1-fast-generate-preview` / `veo-3.1-lite-generate-preview`。
- **生产 `ark-video` 的 `ARK_BASE_URL` 主机为空**（付费版），方舟线路实际不可用，取消也就无从谈起。

## 成本结论

每次中止，平台退还该轮所有未结束任务的积分。除方舟排队中的任务外，上游已开始的工作仍会向我们收费：这是「中止即退款」的代价，量级等于被中止任务的上游成本。
