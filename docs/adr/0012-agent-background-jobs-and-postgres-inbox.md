# 生成改为后台任务，收件箱自建于 Postgres

状态：accepted。确认日期：2026-09-20。规格与验收见 [#600](https://github.com/Muluk-m/ai-image-playground/issues/600)。补记既成决定：实现已随 #600 的各切片陆续落地，本文补上当时没写下来的取舍。

生图与生视频不再阻塞对话。工具调用只负责**提交**，轮立刻收尾；结果按产物交付落画布。智能体忙时用户发出的话进**会话收件箱**，存服务端、看得见、撤得回。任务结束后是否**唤醒**智能体回来复核，由规则和智能体自己决定。

## 四条决定

**一、继续用 pi-agent-core 的基础 `Agent`，不迁 `AgentHarness`。**
从 `AgentHarness` 照搬语义、自己实现，不依赖其内部代码：收件箱四类取件规则、撤回三态、停止退回、工具重放标记、快照加增量。理由是迁移要连带为它实现一套 Postgres 存储，而我们需要的只是那几条语义——语义是文档，几百行；存储层是负债，长期。

**二、编排自建在现有 Postgres 与 worker 上，不引入 Temporal / Inngest / BullMQ / pg-boss。**
队列、租约、重试、幂等在这个仓库里已经各有一份实现（`tasks` 表、`agent_executions` 租约、`generation_commands` 幂等）。再进一个编排引擎，等于同一件事两套真相，还要在部署里多养一个进程。

**三、不接 AG-UI 协议，继续用自有 SSE 事件协议。**
AG-UI 的收益是与第三方前端互通，而我们只有一个前端。代价是把内部事件形状钉死在外部协议上。

**四、界面复制 assistant-ui Elements 组件源码到前端，不接它的运行时。**
组件改写成本仓库的 Tailwind v3 token 与样式常量，数据来自现有 Zustand store。接运行时会引入第二套状态源，与 `useAgentStore` 争夺同一份消息列表。

## 落地形状

| 关注点 | 实现 | 位置 |
| --- | --- | --- |
| 会话收件箱 | 四类记录（用户消息 / 澄清答复 / 任务结果 / 系统事件），会话内单调 `seq`，`client_message_id` 会话内唯一做幂等，待处理用户消息上限 10 | `agent_inbox`（`packages/db/src/schema.ts`）、`apps/bff/src/lib/agent/inbox.ts` |
| 取件顺序 | 系统事件 → 澄清答复 → `seq`；用户消息每轮取一条，同一时刻到达的任务结果一次全取 | `inbox.ts` `turnOrder` / `processingOrder` |
| 撤回三态 | `cancelled \| already_consumed \| not_found`，由单条原子更新决定，跨设备并发只有一个结果成立 | `inbox.ts` `withdrawAgentMessage` |
| 后台任务登记 | 关联会话、发起轮、工具调用、生成任务，记录状态与提交时选的「成功后唤醒」；执行与唤醒投递分开记录 | `agent_jobs`、`apps/bff/src/lib/agent/background-jobs.ts` |
| 唤醒规则 | 失败必唤醒；成功按提交时的选择；同批次全部结束才唤醒，等待上限两分钟；有待处理用户消息则并入那一轮；连续自动唤醒上限 3 次；积分不足跳过并标注 | `apps/bff/src/lib/agent/wake.ts`、`inbox.ts` |
| 单写者 | 会话执行租约，滚动发布时新旧实例并存靠原子租约区分，沿用 [ADR 0009](0009-preserve-executors-during-rollout.md) 的执行者保留与接管 | `agent_executions`、`apps/bff/src/lib/agent/inbox-pickup.ts` |
| 中断续跑 | 丢弃未收尾的助手输出，注入「上一轮被中断」的说明后续跑**一次**；已提交的生成任务按提交内容去重，不重复提交 | `apps/bff/src/lib/agent/interrupted.ts` |
| 失败与重试 | 工具调用开始时持久化完整参数快照；重试按快照提交、不经对话模型，进会话级重试队列串行执行，结果落回原失败占位 | `agent_generation_drafts`、`apps/bff/src/lib/agent/retry.ts` |
| 错误分流 | 失败记录与事件带结构化错误码，界面只按错误码决定按钮，不读服务端文字（[ADR 0006](0006-ui-trusts-error-codes-not-server-messages.md)） | `packages/shared/src/agent.ts` `AgentToolErrorCode` |

## Consequences

- **「工具返回」不再等于「有结果」。** 系统提示词与工具说明都必须写明结果未就绪时不得宣称完成，否则模型会顺口说「图已经好了」。这条是常驻约束，不是一次性修补。
- **停止只中止当前回复，不取消后台任务**；删除会话才连带取消其全部后台任务与排队重试。
- **收件箱是会话状态，不是设备状态。** 多设备看到同一份排队列表，撤回的胜负由数据库那一行决定。
- **唤醒要花钱。** 连续上限 3 次与积分不足跳过是成本闸门，不是体验优化；放宽它们等于放开一条用户不说话也在扣费的路径。
- **协议事件仍不完整。** 后台任务进度与结束、唤醒已跳过、重试已排队/已撤回目前由 `GET /api/agent/conversations/:id/jobs` 轮询与下一次快照承载，不是 SSE 一等事件。这是已知缺口，不是本 ADR 要推翻的决定。

## Considered Options

- **迁移到 `AgentHarness` 并为它实现 Postgres 存储。** 语义最齐，但要新写并长期维护一套存储适配层，且把会话生命周期绑在上游的演进节奏上。未采纳。
- **引入外部编排引擎（Temporal / Inngest / BullMQ / pg-boss）。** 重试、租约、幂等现成，但与仓库里已有的那套并存，部署要多一个进程，两套真相。未采纳。
- **让生成继续阻塞对话，只在界面上做「插话」。** 改动最小，但用户在几十秒到几分钟里唯一能做的仍是等待，服务重启还会丢掉那段回复。未采纳。
