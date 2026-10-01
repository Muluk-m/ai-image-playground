# Craft OSS 与 Muvloom Agent harness 对比

调查日期：2026-10-01。本文记录改动前的源码事实与建议，不把建议表述成已交付功能，也不据此宣称线上缓存率已经改善。

## 基线与结论

- Muvloom 基线：[`d82160e0399b45656bd5c80dfc96d46543bc8def`](https://github.com/Muluk-m/ai-image-playground/tree/d82160e0399b45656bd5c80dfc96d46543bc8def)，BFF 使用 `@earendil-works/pi-agent-core`、`pi-ai` **0.85.1**。
- Craft 最新基线：[`73bd9c2a3573158bea880984eb8d5fdb41e0cac2`](https://github.com/craft-ai-agents/craft-agents-oss/tree/73bd9c2a3573158bea880984eb8d5fdb41e0cac2)，提交时间 2026-09-30，产品 **0.14.0**。通过 `git ls-remote … HEAD` 确认，再单独只读 clone；未安装依赖、运行构建或修改参考仓库。
- 旧参考 checkout `3eac37be` 为 Craft 0.13.6；本文以下结论均复核于 0.14.0。Craft 的 `pi-agent-server` 使用 `pi-coding-agent`、`pi-agent-core`、`pi-ai` **0.87.1**。[Craft manifest](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/pi-agent-server/package.json)，[Muvloom manifest](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/package.json)

最优先的差距是**跨轮模型历史的保真与持久化**。Craft 恢复 Pi 原生 session；Muvloom 每轮把产品展示消息重新转换成纯文本历史。时间已在当轮用户消息中，继续挪动时间不能修复历史转换导致的前缀变化。依赖版本落后也是事实，但升级有破坏性 API 变化，不能把换版本当作缓存修复。[Craft session](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/pi-agent-server/src/index.ts#L681-L716)，[Muvloom replay](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn-input.ts#L224-L255)

## 模块对比

| 模块 | Craft 0.14.0 | Muvloom 基线 | 判断与建议 |
| --- | --- | --- | --- |
| 运行时 | 子进程内 `createAgentSession`，由 coding-agent 管理 session/重试/压缩 | 直接 `new Agent`，BFF 自管租约、压缩、账本 | 服务端多用户产品的合理差异；不需要引入整个桌面 coding-agent |
| 历史 | `.pi-sessions` 原生 transcript，`continueRecent` 恢复 | 产品消息 → 纯文本 user/assistant；工具结果摘要化 | 高影响差距：增加独立、版本化的模型历史持久化 |
| 时间与动态上下文 | stable system + volatile user tail | `turnPromptBody` 注入当前 UTC 时间 | 已对齐；需保护历史中已发送的时间，不能下轮重新生成 |
| 系统前缀 | 首次钉住偏好/项目上下文，漂移提示新建会话 | 模板目录已稳定排序，但每轮按当前权限和可用能力构建 | 权限撤销必须立即生效；不应为了缓存冻结失效权限 |
| 工具调用 | 名称 allowlist + customTools + pre/post hook | 固定注册表、能力筛选、TypeBox 校验、逐工具业务授权 | 核心防线已有；不可用 Craft 通用权限弹窗替代计费与画布确权 |
| 工具返回 | 模型窗口相关阈值，原文落盘，返回摘要/预览 | 网页 15k 字符；画布和素材列表有页数限制；无统一边界 | 增加统一可观测边界，保留原文取回能力；避免静默截断 ID/JSON |
| 压缩 | SDK 自动压缩与手动 compact，等待与终止有期限 | 自有分段摘要、逐字保留、熔断、截尾、出站硬闸 | 我们已有更多业务约束；新 transcript 必须与锚点/删除规则一起设计 |
| 重试 | 主会话最多 4 次 agent retry，provider 每次最多 2 次 | 当前 Pi provider 默认 0 次；BFF 自有调用账本 | 不能直接复制；每次真实请求必须独立入账再谈重试 |
| 取消与流错误 | 错误分类，重试前撤销半截文本，子进程 abort | AbortSignal + 180s 空闲看门狗，失败轮撤销未完成文本 | 已有主体；需要 wire-level 回归锁住 usage 与终帧语义 |
| usage/cache | Pi usage 映射到 UI；context occupancy 单独维护 | 每个对话模型调用落库，全部调用已知才结算 | 不应换成 Craft 的 UI 累加器；我们的结算语义应保留 |
| 辅助请求 | 短时 session、独立超时与重试预算 | 压缩/搜索记录 side-call，标题请求没有 onAttempt | 明确缺口：标题失败和实际成本不进入统一调用面板 |
| Provider | 多 provider registry，定制 endpoint 能力覆盖 | 固定 OpenAI-compatible gateway，显式 usage/store/max_tokens 兼容 | 不应因为模型名是 GPT 就盲切 Responses API |

表格对应源码：[Craft session/tools](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/pi-agent-server/src/index.ts)，[Craft prompt](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/shared/src/agent/pi-agent.ts#L2118-L2229)，[Craft retries](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/pi-agent-server/src/session-settings.ts)，[Craft large responses](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/shared/src/utils/large-response.ts)，[Muvloom turn](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn.ts)，[Muvloom tool registration](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/tools/index.ts)，[Muvloom compaction](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/compaction-transform.ts)。

## 优先级与验收边界

### P1：持久化模型实际看见的历史

Muvloom `replayed()` 把每条历史消息投影成纯文本；assistant 的模型、usage、stopReason 都使用占位。`replayedSkillTexts()` 还会重新读取当前版本技能，而非原始返回内容。即使系统说明完全不变，上一轮模型实际看见的用户时间、图片、toolCall/toolResult 与下一轮回放也不同。这既减少可重复前缀，也丢失模型已经取得的网页证据及工具结构。缓存损失的具体比例仍需前缀指纹或受控样本确认。[replay](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn-input.ts#L210-L255)，[skill replay](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/tools/loadSkill.ts#L69-L113)

建议引入与展示消息分离的模型 transcript：保存原始 role、文本、工具调用 ID/参数、工具返回和图片内容引用；图片使用内容寻址或稳定归档引用，避免在 PostgreSQL 重复存 base64。历史读取仍校验会话归属和删除/压缩边界。旧会话使用现有重建路径；新记录只在完整持久化且锚点有效时恢复。

验收应覆盖：两轮连续对话的旧前缀逐字一致；含读图/网页/工具返回的恢复；服务重启；中止在工具批次中间；删除历史后失效；压缩之后按新边界续接；换模型/权限变更；未完成工具不会重执行扣费；预扣基于新的真实历史计算。

### P2：依赖升级前明确兼容策略

Pi 0.87.0 修复了未知 OpenAI-compatible endpoint 默认发 strict tool schema 的兼容问题；0.85.1 的 URL 启发式对普通自定义网关默认 `supportsStrictMode=true`。我们的 `gatewayModel.compat` 没显式指定它。可先在现有版本对网关显式声明 strict 支持与否，并测试最终请求中的工具 schema；这属于确定的配置缺口，**不等于已证明当前用户报错都来自 strict**。[Pi AI 0.87.0 changelog](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/ai/CHANGELOG.md)，[Pi 0.85.1 adapter](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-completions.ts)，[gateway model](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/model.ts)

升级 0.87.1 的必要迁移：0.86 provider 输入从 `Context` 变为 `TranscriptContext`，system/tools 由 transcript system message 承载；0.87 移除 `shouldStopAfterTurn`，换 `finishTurn`。新增 `prepareRequest` 适合从持久层装配 canonical messages，但不得在纯升级中顺带改结算/授权含义。Craft 的 system override 已改成 `before_agent_start` 扩展，不能复制旧版私有字段赋值方案。[Pi Agent changelog](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/agent/CHANGELOG.md)，[Pi AI changelog](https://github.com/earendil-works/pi/blob/f07218c4d4bbc12bef056a7058c3dd49dfe41abe/packages/ai/CHANGELOG.md)，[Craft override](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/pi-agent-server/src/system-prompt-override.ts)

### P2：输出截断与辅助请求必须可见

`turn.ts` 只把模型 `stopReason=error` 识别为失败，纯文本 `length` 仍可能以 completed 收尾；如果用户看到的是半句话，运行成功率会掩盖这类未完成回答。Pi 0.85.1 已禁止执行 length 消息中的工具调用参数，因此无需再补一个重复的工具参数保护层。建议将文本截断作为明确的可恢复结果，保留已收到的内容与 usage，避免自动重试产生隐形扣费。Craft 当前 adapter 也没有完整的纯文本 length 分支，所以这一项是我们应完善的契约，并非照抄其实现。[Muvloom message_end](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn.ts#L396-L428)，[Pi loop](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts)，[Craft adapter](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/shared/src/agent/backend/pi/event-adapter.ts#L521-L619)

标题生成 `nameConversation()` 没有给 `askChatModel` 传 `onAttempt`，异常 catch 全吞。压缩/搜索已经有 side-call 账本；标题应按相同方式记录用途、尝试、失败与实际 usage，同时仍由平台承担、不得混入用户对话结算。验收包括标题超时、解析失败重试、空 usage、重复回调幂等和总用户费用不变。[title](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn-preparation.ts#L576-L600)，[side-call ledger](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/usage-ledger.ts#L133-L170)

### P2：工具大结果先保留、再有界送入模型

Craft 按 `min(12000, contextWindow × 10%)`、最低 2000 token 处理大结果，保存全文后返回摘要或 2000 字符预览。我们的网页 15000 字符上限、画布分页和素材 20 条上限已有效限制常见来源，但技能附属文件允许 64 KiB，扩展工具没有统一最后一道边界。建议统一记录工具结果估算 token、是否截断与可取回引用；对结构化结果采用工具自己的分页，不能把 JSON/图片 ID 切断。[Craft threshold](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/shared/src/utils/large-response.ts#L132-L139)，[Craft save/preview](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/packages/shared/src/utils/large-response.ts#L653-L716)，[Muvloom webpage](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/tools/webFetch.ts)，[Muvloom skill limit](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/skills.ts#L193)

不要为了这一层再无条件增加摘要模型调用。摘要需要自己的 attempt 账本、超时和费用归属；摘要失败仍可返回明确预览。我们已有 CJK token 修正，不能直接换回 Craft 的纯字符数/4 估算。[Muvloom estimator](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/token-estimate.ts)

## 已排除与不能直接照搬的做法

1. **async subscribe 不会天然漏等。** 安装的 Pi 0.85.1 `Agent.subscribe` 明确支持 Promise listener，loop 会 await emit。我们在 `message_end` 等待账本写入的方式符合契约；应通过实际 SDK 测试保护，而非无证据重写事件队列。[Pi Agent](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts)
2. **usage 的输入分母应含 cacheRead/cacheWrite。** Pi 的 input 是非缓存输入；Muvloom `input + cacheRead + cacheWrite` 正确。缺 usage 的全零值被视为未知，不能为了好看的命中率把未知当 0% 或免费。[ledger](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/usage-ledger.ts#L70-L104)，[Pi adapter](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-completions.ts)
3. **中止不应清掉已收到 usage。** 0.85.1 provider catch 保留 output 上已收到的用量，ledger 对 aborted 记 cancelled 并保留 usage。验证断流在 usage 前/后的两种情况；缺失用量继续走未知结算。[Pi adapter](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-completions.ts)，[ledger](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/usage-ledger.ts)
4. **sessionId 不是万能缓存开关。** 0.85.1 Chat Completions 只在 OpenAI 官方 URL，或显式支持 long retention 的特定兼容路径写 `prompt_cache_key`。普通自定义网关仅加 sessionId 不保证发送缓存键；要先确认网关的路由和字段支持，且路由键不能修复不同的消息前缀。[Pi adapter](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-completions.ts)
5. **自动重试必须逐尝试入账。** 当前 Pi provider 默认 maxRetries=0，而我们的 ledger.begin 包在 streamFn 外层。若照搬 Craft 的内层重试，一个账本记录会涵盖多个 HTTP 请求。应先设计 attempt ID、失败/未知 usage、取消和费用归属，再打开重试；不得重试已经提交的生图副作用。[Pi provider retry](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/utils/provider-retry.ts)，[Muvloom streamFn](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/turn.ts#L226-L268)
6. **桌面依赖不等于缺失功能。** Craft 的 MCP、OAuth、shell/文件工具、Sentry Electron 与子进程恢复服务于桌面通用 agent；我们的服务端只开放有限画布/生成工具，有 PostgreSQL 执行租约和业务确认。保持 SELECT-only Admin、能力默认关闭、会话确权、生成任务幂等和费用账本；无需为“对齐依赖”引入未经产品授权的 shell/MCP 入口。[Craft dependencies](https://github.com/craft-ai-agents/craft-agents-oss/blob/73bd9c2a3573158bea880984eb8d5fdb41e0cac2/package.json)，[Muvloom execution](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/execution.ts)，[tool replay](https://github.com/Muluk-m/ai-image-playground/blob/d82160e0399b45656bd5c80dfc96d46543bc8def/apps/bff/src/lib/agent/tools/index.ts#L129-L190)

## 建议交付次序

先落地模型历史保真和网关/取消/事件顺序的契约测试，再独立迁移 Pi 0.87.1；输出截断、标题账本和工具结果边界按模块分别交付。缓存验收看同模型后续轮首调、同轮续调、图片/纯文本与冷启动的分组，配合前缀哈希变化原因；整个窗口的单个百分比不能区分实现改善、模型切换、缓存过期与用户样本变化。

本文是源码审计，未调用付费模型进行 A/B，也未检查全部真实请求负载；因此确认的是实现差异与可复现的契约风险，不是每个线上错误的唯一根因。

## 本次落地范围

本次实现：

- 独立的原生模型历史缓存，保留历史日期、图片、工具调用与返回；预扣与实发共用，并检查归属、模型、工具、技能正文和产品历史指纹。
- 缓存读取/写入有界，压缩、选区、状态变更、删除、故障时回到现有产品历史；后台任务与技能文件在保存前变更也会使缓存失效。详见 [ADR 0013](../adr/0013-agent-native-model-history-cache.md)。
- 兼容网关显式 `supportsStrictMode: false`，采用 Pi 0.87 对未知网关的兼容策略，不改 SDK 主 API。
- 响应头等待也受空闲期限控制；传输层无视取消时仍结束本地等待，已取消请求不再派发，迟到响应释放流。
- `stopReason=length` 同时记模型调用与对话轮失败，保留已报告 usage，不执行截断参数、不自动付费重试。

尚未实施：Pi 0.87.1 全面升级、标题调用的独立 purpose 账本、通用大工具结果取回协议。它们涉及 provider transcript API、数据库迁移或工具协议，不能据本文视为已完成。本次不新增模型重试，也不将受控前缀一致性宣称为已测得的生产缓存命中率提升。
