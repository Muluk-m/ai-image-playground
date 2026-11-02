# Admin「提示词」页实施方案

原型：[admin-chat-prompts-prototype.html](../design/admin-chat-prompts-prototype.html)（方案 2，示例数据）。

## 目标

运营在 Admin 里按时间倒序查看智能体（chat）拟出的每一条生成提示词：

- 提示词全文，以及用户确认前改过的差异（chat 原稿 → 提交稿）；
- 上下文：用户原话、归属（用户 / 设备）、chat 模型、会话与轮；
- 结局：待确认 / 生成中 / 已出图 / 失败，关联任务与产物缩略图；
- 顶部统计：时间窗内提示词条数、被改过比例、未确认比例、提交后失败比例；
- 筛选：时间窗、状态、是否被改过、用户、关键词。

不做：LLM 原始请求 / 返回原文落库；整段对话回放（列表行上的「看对话」先跳到该轮所在任务或留作二期）。

## 数据来源（已核实）

| 情形 | 落在哪 | 提示词 | 关联任务 |
| --- | --- | --- | --- |
| 对话模式：拟稿等确认 | `agent_generation_drafts` | `prompt` | `task_id`，确认前为 null |
| 对话模式：已确认 | 同上 | `prompt` **已被确认时那一份覆盖**（`confirmations.ts` 的 `claimSubmitted`） | `task_id` |
| 出图模式：当场提交（`auto-submit.ts`） | 不落草稿，只有任务 | `queue_tasks.request_payload.prompt`，带机器指令（`shapeQueuePrompt`） | `queue_tasks.agent_conversation_id / agent_turn_id` |
| 批量出图 | `agent_batch_items.prompt` + `agent_batch_attempts.task_id` | 同上，任务里带机器指令 | 同上 |

上下文：

- 用户原话：同 `(conversation_id, turn_id)` 的 `agent_messages` 中 `role = 'user'` 的文本块；唤醒轮 / 续跑轮没有用户原话，显示「后台唤醒」。
- chat 模型与 token：`agent_model_calls` 中同轮 `purpose = 'conversation'` 的记录（取首条模型名，token 求和）。
- 归属：`agent_conversations.user_id / device_id`，用户名来自 `users`。

**缺口：确认后 chat 原稿丢失。** 确认时草稿行的 `prompt` 被用户版本覆盖，卡片也被改写，“被改过”无从计算。工具参数快照 `agent_tool_calls.snapshot.args` 里只有模型给的 `prompt` + `designIntent`，原稿是 BFF 里 `designPrompt()` 合成的，Admin 不应复刻这段逻辑。所以需要新增一列保存原稿（见步骤 1）。历史数据补不回来，界面上显示「原稿未记录」，统计只算有原稿的行。

## 实施步骤

按 tracer-bullet 拆成 4 张 ticket，前一张合并后再做下一张。

### T1 · 草稿保留 chat 原稿（db + bff）

- 迁移 `0070_agent_draft_drafted_prompt`：
  - `ALTER TABLE agent_generation_drafts ADD COLUMN drafted_prompt text;`（可空，新旧版本兼容：旧 BFF 不写它，读路径不依赖它）
  - `CREATE INDEX idx_agent_generation_drafts_created ON agent_generation_drafts (created_at DESC, id DESC);`
  - `CREATE INDEX idx_tasks_agent_submitted ON tasks (submitted_at DESC, id DESC) WHERE agent_conversation_id IS NOT NULL;`
  - 配 `rollback/0070_….down.sql`；`schema.ts` 同步，`db:verify` 通过。当前普通 `db:generate` 因既有 BigInt 默认值报错、最近快照停在 0022；本次用 `drizzle-kit generate --custom` 创建迁移，沿用 0023–0069 的 SQL + journal 约定，不提交复用旧 schema 的快照。
- `apps/bff/src/lib/agent/confirmations.ts` 的 `saveGenerationDraft`：`drafted_prompt: input.prompt`。`claimSubmitted` 不动，继续只覆盖 `prompt`。
- 把 `unshapeQueuePrompt` 从 `apps/bff/src/lib/agent/prompt-shaping.ts` 挪到 `packages/shared`（它只依赖 shared 里的 `PROMPT_REWRITE_GUARD_PREFIX` 与 `buildAspectInstruction`），BFF 改为从 shared 引入，Admin 后面复用，用来剥掉任务提示词里的机器指令。
- 测试：`packages/db` 迁移测试；BFF `confirmations` 测试断言确认后 `drafted_prompt` 保持原稿、`prompt` 变为用户版本；shared 增加 `unshapeQueuePrompt` 单测（从 BFF 原测试迁过去）。

### T2 · Admin 接口 `GET /api/agent-prompts`

- `apps/admin/contracts.ts`：`AgentPromptItem`、`AgentPromptsResult`（`items`、`summary`、`nextCursor`）、`parseAgentPromptFilters`（`from/to`、`status: awaiting|running|completed|failed`、`edited`、`userId`、`deviceId`、`q`）。
- `apps/admin/server/lib/agent-prompts.ts`，一条 `UNION ALL` 查询：
  - A 段：`agent_generation_drafts d LEFT JOIN queue_tasks t ON t.id = d.task_id`，提示词取 `d.prompt`，原稿取 `d.drafted_prompt`；
  - B 段：`queue_tasks t WHERE t.agent_conversation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_generation_drafts d WHERE d.task_id = t.id)`，提示词在 TS 里用 `unshapeQueuePrompt` 处理，原稿 = 提交稿（不存在改动）；
  - 两段都 JOIN `agent_conversations` 与 `users`；用户原话和 chat 模型对本页的 (conversation_id, turn_id) 批量补查，避免 N+1；
  - 按 `(created_at DESC, kind, id)` 游标分页，每页 50；`q` 走 `ILIKE`，必须带时间窗（默认今天，最长 31 天）。
  - `summary` 与第一页并行计算，只在首页返回（沿用服务端日志页的做法）。
- 只读 `queue_tasks` 视图，不读裸 `tasks`（`task-visibility.test.ts` 会拦）。不回传 `request_payload` 与输入图 base64；缩略图复用现有任务图片接口。
- `server/routes/agent-prompts.ts` 挂 `requireAuth`，在 `app.ts` 注册。
- 测试：`src/__tests__/server/routes/agent-prompts.test.ts`（bun:test + 测试库），覆盖待确认草稿、确认后被改过、历史行没有原稿、出图模式任务（机器指令已剥掉）、唤醒轮没有原话、游标翻页不重不漏、筛选组合、筛选参数不合法时返回 400。

### T3 · Admin 页面

- 路由 `src/routes/_authed.prompts.tsx`，侧栏「经营」组加「提示词」（`AppSidebar.tsx` 的 `NavTo` 与 entries，同步 `AppSidebar.test.tsx`）。
- `src/lib/queries.ts` 增加 `useAgentPrompts`（`useInfiniteQuery`，同 `useGenerationTasks`），筛选状态走 search params（`search-params.ts` 增加解析与测试）。
- 组件放 `src/features/agent-prompts/`：`PromptSummary`（4 个 KPI）、`PromptCard`（状态、工具、模型、差异、原话、归属、产物、复制 / 任务 / 用户按钮）、`PromptDiff`（按词做 LCS 差异，纯函数单测）。
- 交互：任务按钮打开现有 `TaskDetailSheet`；用户名跳 `/users/$userId`；复制按钮复制提交稿。
- 样式按 `docs/design/admin-design-system.md` 与 `tokens.css`，不写死颜色；差异的增删色用已有 success / danger token 的浅底。
- 测试：`PromptDiff` 单测；`PromptCard` 渲染各状态（vitest）。

### T4 · 任务列表标出 Chat 来源（可选，小）

- `mapTaskListItem` 增加 `source: 'chat' | 'manual'`（依据 `agent_conversation_id`）；生成任务页加来源列和筛选，任务详情加「在提示词页查看」链接。

## 发布与验证

- 每张 ticket：`pnpm exec biome check --write .` → `pnpm lint` → `pnpm typecheck` → 只跑改动包的测试（`apps/admin` 用 `pnpm test --filter agent-prompts`，`packages/db`、`apps/bff` 同样收窄），全量交 CI。
- T1 迁移只加列和索引，新旧版本都能跑；生产 `tasks` 表较大，若索引创建耗时明显，改用 `CREATE INDEX CONCURRENTLY`（按迁移框架是否允许非事务语句决定）。
- 先推 `test` 分支，在 https://test.muvloom.online 走一遍：对话模式拟稿 → 改提示词 → 确认，出图模式直出，再到测试 Admin 核对四种状态与差异显示。
- 合并 main 后跟进 `deploy.yml`，在生产 Admin 核对接口耗时（今天窗口 < 500ms）和数据。

## 隐私

页面会让运营看到用户原话和提示词。Admin 已经能看任务提示词，权限边界不变；如果需要留查看痕迹，二期再在审计里记录“查看了谁的提示词”。
