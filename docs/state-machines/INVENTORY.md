# 隐式状态机清单

2026-11-09 对照 `apps/web`、`apps/bff`、`apps/admin`、`apps/website`、`cli-go`、`packages/shared`、`packages/db` 读代码后的清单。做法见 [README](README.md)。

未加载 `~/.cursor/rules/pstack-models.mdc`，没有用户指定的子 Agent 模型配置。

共 **42** 台。价值按「出错会伤到用户或钱、改起来容易改错、现在有多少处各自判断」排。前 10 台在下面展开，其余用同一张字段表。

已做成转移表、但还没接到全部写入点的，标「表已落地」。计费路径只盘点。

## 前 10

| # | id | 价值 | 这次 |
| --- | --- | --- | --- |
| 1 | queue-task | 高 | 表已落地。结算函数不改 |
| 2 | agent-tool | 高 | 表已落地 |
| 3 | credit-hold | 高 | 只盘点（计费） |
| 4 | workbench-generation | 高 | 提案 |
| 5 | canvas-placeholder | 高 | 提案 |
| 6 | agent-turn | 高 | 视图已落地，store 写入不改 |
| 7 | stage-authorization | 高 | 只盘点（计费） |
| 8 | cloud-project-sync | 高 | 已有联合类型，不改 |
| 9 | agent-inbox | 高 | 表已落地 |
| 10 | media-upload | 高 | 表已落地 |

### 1. queue-task

- 位置：`packages/shared/src/queue-protocol.ts`，`packages/db` 的 `tasks.status`，写入在 `apps/bff/src/db/task-transitions.ts`、`apps/bff/src/workers/task-execution.ts`、`apps/bff/src/db/maintenance.ts`、`apps/bff/src/lib/taskSubmission.ts`、`apps/bff/src/lib/task-reconciliation.ts`。
- 状态：`queued`、`in_progress`、`reconciling`、`completed`、`failed`、`cancelled`。
- 转移：见 [queue-task.md](queue-task.md)。提交插入 `queued`；worker `claim` 到 `in_progress`；可重试失败回 `queued`；上游结果不明进入 `reconciling` 且不结算；终态走 `finishTask`；取消只打在 `queued` 和 `in_progress` 上，已发出的先核查。
- 现在能表示的非法组合：终态仍带执行令牌；`reconciling` 但 `reconciliation_required` 不为真（库检查会挡）；`queued` 上直接 `succeed`。客户端另有一套三态 `running | done | error`，两边不是同一个类型。
- 风险：恢复、取消、对账和结算各写各的。对话轮不能回队，回队会被 worker 当成生图重跑。
- UX：进度卡、刷新后续跑、失败退款是否发生。DX：改一条边要搜完整仓字符串。AX：类型在 shared，转移不在一处，代理很容易只改一个写入点。
- 计费：是。`reserveTask` / `finalizeTask` 挂在提交和终态上。本轮不改 `task-transitions.ts`。

### 2. agent-tool

- 位置：`packages/shared/src/agent.ts` 的 `AgentToolStatus`；写入在 `apps/bff/src/lib/agent/confirmations.ts`、`retry.ts`、`background-jobs.ts`、`tools/adapter.ts`。
- 状态：`awaiting_confirmation`、`queued`、`submitted`、`succeeded`、`failed`。
- 转移：见 [agent-tool.md](agent-tool.md)。
- 非法组合：`succeeded` 却没有产物；`submitted` 没有 `job.taskId`；确认之后又 void。卡片 JSON 可以暂时落后于 `tasks.status`，读的时候才结算。
- 风险：两个来源（消息 JSON 和任务表）。重试另插记录，原失败卡留着。
- UX：确认、重试、取消。DX / AX：状态字符串散落，和任务六态容易混。
- 计费：提交那一下会预扣。本轮只定义卡的状态边，不改预扣。

### 3. credit-hold（只盘点）

- 位置：公开树只有 `apps/bff/src/lib/private-overlay.ts` 的 `reserveTask`、`finalizeTask`、`runMaintenance`。实现在 `private.lock` 钉住的 overlay，本检出没有 `private/`。
- 状态（从调用点看）：预扣 → 完成结算 / 失败或取消退回 / 核查期间挂起。
- 转移：提交事务里预扣；`finishTask` 和 `cancelTasks` 里结算；`reconciling` 不结算。
- 非法组合：任务行没了但预扣还在。提交失败会回滚同一事务。
- 风险：核查和结算的时序；GPT 档位结算改倍率。AX 差：公开树看不到账本。
- UX：402 / 429，失败文案里的退款。不改。

### 4. workbench-generation（提案）

- 位置：`apps/web/src/types.ts` 的 `TaskStatus`，`apps/web/src/lib/generationJob.ts`，`store.ts`，`platformGenerations.ts`，`queueClient.ts`。
- 状态：客户端 `running | done | error`，另加 `queuePhase`、`batchQueued`、`cancelled`、`bffRequestId`。
- 转移：本地插入 running → 受理 → 轮询阶段 → done，或 failed/cancelled 变成 error。刷新后续跑，或把不能续的标成 error。
- 非法组合：`done` 仍带着 `queuePhase: generating`；`running` 且永远 `batchQueued`；`running` 但没有可恢复句柄。`cancelled` 在筛选里归到 error。
- 风险：客户端三态和服务端六态同名不同义。两个监视器可能盯同一条任务。
- UX：进度和刷新恢复。DX / AX：生命周期横跨 store、sink、轮询。收成一个可辨联合类型会动生成主路径，这次不动。

### 5. canvas-placeholder（提案）

- 位置：`apps/web/src/features/canvas/lib/editor.ts` 的 `CanvasTaskStatus`（`loading | error | stale`），`canvasGenerationSink.ts`，`recoverCanvasTasks.ts`。
- 转移：占位 loading → 换成图或视频，或 error / stale。恢复按 meta 决定删掉、标 stale 还是续跑。
- 非法组合：loading 且没有可恢复 meta；`agent: true` 的 loading 若恢复没删掉会一直转。
- UX：画布主路径。这次不改恢复逻辑。

### 6. agent-turn

- 位置：`apps/web/src/features/agent/store.ts` 的 `turn`、`stopping`、`reconnecting`；流在 `agentClient.ts`。
- 状态：三态乘两个布尔。视图见 [agent-turn-session.md](agent-turn-session.md)。
- 非法组合：`idle` 且 `reconnecting`（旧的跟随者没清掉）；`running` 且没有 `activeTurn`；`failed` 且 `reconnecting`。
- 风险：和队列阶段、登录门的 `reconnecting` 同名不同义。
- UX：断流提示、停止。写入点太多，这次只加视图，面板表现不变。

### 7. stage-authorization（只盘点）

- 位置：`packages/shared/src/stage-authorization.ts`，`apps/bff/src/lib/agent/stage-authorizations.ts`，JSONB，不是单独的列检查。
- 状态：`pending`、`active`、`exhausted`、`ended`、`expired`。审计日志另有 `proposed`、`confirmed`、`preflight`、`retry`、`submitted`、`reported`。
- 转移：提议 → 确认变成 active；花到上限 exhausted（失败释放后可能回到 active）；作废 ended；TTL 且没有在途任务则 expired。
- 非法组合：active 但没有确认审计。新提议会收掉旧的 pending 和 active。
- 风险：预算和任务提交绑在一起。不改。

### 8. cloud-project-sync

- 位置：`apps/web/src/features/canvas/lib/cloudProjects.ts` 的 `ProjectSyncStatus`，节点版在 `cloudNodeProjects.ts`。
- 状态：`deleted`、`loading`、`pending`、`local`、`offline`、`syncing`、`saved`、`error`、`load-error`、`conflict`、`media-local`、`local-error`、`auth-error`、`permission-error`、`quota-error`、`format-error`。
- 转移集中在 `CloudProjectSession`。另有 `editedBeforeLoaded`、`forking`、`writable`。
- 非法组合：离线时仍 `syncing` 的竞态；`saved` 同时 `baseline.conflict`。
- UX：覆盖和分叉。这是画布里已经最接近显式机器的一处，这次不重写，避免动同步。

### 9. agent-inbox

- 位置：`packages/shared/src/agent.ts` 的 `AgentQueuedMessageState`，`apps/bff/src/lib/agent/inbox.ts`。
- 状态与转移：见 [agent-inbox.md](agent-inbox.md)。
- 非法组合：`consumed` 没有 `consumed_turn_id`（写入点会带上；类型不强制）。已 consumed 再撤回会得到 `already_consumed`，不改行。
- UX：排队、撤回、停止退回、插话。DX / AX：同一文件里多处写状态字符串。

### 10. media-upload

- 位置：`apps/web/src/lib/mediaUpload.ts`，调用在 `attachmentUploads.ts` 和输入栏。
- 状态：`queued`、`uploading`、`verifying`、`ready`、`failed`。见 [media-upload.md](media-upload.md)。
- 非法组合：`ready` 之后 catch 仍可能标 `failed`（计时上报抛错）。表里保留这条边。
- UX：不传完不能发智能体。服务端对象状态是另一台机器（media-object）。

## 其余

字段顺序：位置 / 状态 / 转移（观察到的） / 非法或风险 / 体验 / 这次。

### 11. cli-job（中，表已落地）

`apps/bff/src/lib/cli/jobs.ts` 把任务六态投影成 `queued | running | persisting | succeeded | failed | canceled`。`projectCliJobStatus` 是唯一投影。Go CLI 只消费这六态，`cli-go/internal/cli/images.go` 的 `jobOutcome` 把 failed / canceled 变成退出码，其余当成功。非法：客户端超时后服务端任务还在跑。UX：CLI 和运营后台对不上「核查中」。计费：终态才有 `actual_credits`。不改结算。

### 12. device-authorization（中高，表已落地）

`packages/db` `device_authorizations.status`：`pending | approved | denied | consumed`。`apps/bff/src/lib/cli/auth.ts`。见 [device-authorization.md](device-authorization.md)。非法：`approved` 没有 `user_id` 时兑换拒绝。风险：兑换更新按 id，不复查状态。UX：CLI 登录。鉴权路径，接入时只替换状态字面量。

### 13. announcement（中，表已落地）

`announcements.status`：`draft | scheduled | published | archived`。`apps/bff/src/lib/announcements.ts`。有效状态另算。见 [announcement.md](announcement.md)。非法：库存 published 但已过期，列表按有效状态显示 archived。不依赖定时改列。

### 14. inspiration（中，表已落地）

`draft | published | archived`。`apps/bff/src/lib/inspirations.ts` 的 `setInspirationStatus` 没有转移矩阵。见 [inspiration.md](inspiration.md)。风险：`published_at` 离开 published 时不清。UX：探索页清单。不收紧 API。

### 15. agent-batch（中高，表已落地）

`draft | running | paused | closed | cancelled`。`apps/bff/src/lib/agent/batch-execution.ts`、`batch-progress.ts`、`batch-plans.ts`。见 [agent-batch.md](agent-batch.md)。非法：关闭和取消有的写入不看当前状态。计费：确认后才派发。只准备替换状态字面量。

### 16. media-object（中，表已落地）

`pending | ready | deleting`。`apps/bff/src/lib/projectMedia.ts`。见 [media-object.md](media-object.md)。读取拒绝 deleting。过期回收会先标 deleting 再删对象。

### 17. bff-queue-poll（高，提案）

`apps/web/src/lib/channels/queueClient.ts` 的 `poll`。结局 `pending | transient | fatal | done | failed | cancelled`，外加连续失败计数和 `confirming` 的短间隔。非法：永久 4xx 若被分成 transient 会空转到超时。UX：工作台、画布、视频共用。改轮询会动生成，这次只记在清单里。

### 18. agent-background-poller（高，提案）

`apps/web/src/features/agent/lib/backgroundJobs.ts`。按消息 id 轮询，终态后投递、续跑或跟批量。风险：`reset` 之后定时器还在。和计费、画布落位有关，不改循环。

### 19. agent-artifact-delivery（高，提案）

`apps/web/src/features/agent/lib/artifactDelivery.ts`。`AgentDeliveryStatus`：`pending | placed | unavailable | failed`，和工具卡状态平行。非法：工具还是 submitted，投递已经 placed（有意并行）。不改落位。

### 20. auth-gate（高，提案）

`apps/web/src/auth/AuthGate.tsx`。`checking | ready | reconnecting`，另加 `sessionExpired`。`ready` 且会话过期是有意的叠层。鉴权，不改。

### 21. task-progress-phase（中，已是纯函数）

`apps/bff/src/lib/task-progress.ts`。`queued | generating | reconnecting | confirming | reconciling`，由状态、归档载荷、上游 id、租约推导。不是库存列。和 status 不一致是 ADR 0009 的确认阶段。不改。

### 22. async-upstream（高，提案）

`apps/bff/src/lib/upstream/async-tasks.ts`。`pending | completed | failed`。未知上游字符串当成 pending 继续轮。视频用按供应商配置的词表，配错会永远 pending。计费：上游可能已经扣费。不改轮询。

### 23. agent-execution（高，提案）

`agent_executions.state`：`running | completed | failed`。`apps/bff/src/lib/agent/execution.ts` 用会话主键保证一个 running。心跳过期可被接管。风险：多实例靠心跳，不靠这张表本身。不改占用。

### 24. agent-turn-stop（高，提案）

`agent_turns.stop_reason`：`completed | aborted | failed`。运行中的一轮在内存 `runningTurns`。和面板的 agent-turn 不是同一层。计费在轮结束。不改。

### 25. gpt-direct-key（高，只盘点）

`packages/shared/src/gpt-direct-admin.ts`：`available | cooldown | disabled | budget | off`。`apps/bff/src/lib/upstream/gpt-keys.ts` 按 429、额度、预算改。非法：`enabled=false` 但视图还没重算。这是上游花费，不改。

### 26. managed-model（高，提案）

派生：`active`、`paused`（有 pause_reason）、`inactive`。`apps/bff/src/lib/model-availability.ts`，后台 `model-state.ts`。非法：`active=true` 同时有 pause_reason，界面当 active。提交时 `modelUnavailable` 会拒绝。动它会碰到扣费边界，不改。

### 27. task-reconciliation-operator（高，只盘点）

后台 `TaskReconciliation.tsx` 把 `reconciling` 收成 completed 或 failed。504 保持命令钉住。预扣留到确认。不改。

### 28. user-account（低）

`users.status`：`active | disabled`。`setUserStatus` 已经拒绝其他字符串。禁用会撤会话。两个方向和自身都允许。不值得再包一层。

### 29. analysis-model-call（中，提案）

`prepared | dispatched | completed | failed | cancelled | unknown`。`apps/bff/src/workers/analysis-runner.ts`。挂在分析任务的预扣上。不改。

### 30. agent-model-call（中，提案）

`in_progress | completed | failed | cancelled`。`agent_model_calls`。轮次计量，不改。

### 31. generation-archive（中，提案）

`generation_records.archive_status`：`none | pending | ready | unavailable`。跟着任务归档走。另有一份 `generation_records.status` 镜像任务状态，不单独转移。

### 32. scene-record（中，提案）

`apps/web/src/features/canvas/lib/sceneRecord.ts`。`loading`、`loadFailed`、`saveFailed` 三个布尔，不是一个阶段。可以同时表达不清楚的组合。本地画布持久化，不改。

### 33. agent-history（中高，提案）

`loaded`、`historyCached`、`historyLoading`、`historyFailed`。类型不禁止「缓存着且正在加载」。错了会显示旧对话。不改存储。

### 34. composer-mode（中高，提案）

`AgentComposer` 派生 `agent | image | video`，另有持久化的智能体 `AgentMode`。两套模式不是一个枚举。选错发送函数会走错协议和计费。不改作曲器。

### 35. library-sync（中，提案）

`apps/web/src/lib/sync/status.ts`：`idle | syncing | error`，失败原因另列。引擎里还有 `changedInFlight`。不改同步。

### 36. mask-proposal（中，提案）

`AgentMaskProposalCard`：`loading | suggested | rough | failed`，外加 `refining`、`submitting`、`drawing`。澄清门。不改。

### 37. plan-card（中，提案）

`planCardState.ts`。`skipped`、`busy`、`stops` 几套集合。同一 id 可以既 busy 又 skipped。批量确认会花钱。不改。

### 38. batch-generate-scheduler（中，提案）

`store.ts` 的 `batchQueued`。进程死了，排队中的任务不会续跑。不改调度。

### 39. cli-connection（中，提案）

`cli_connections` 没有状态列。`revoked_at` 和过期时间合成 active / revoked / expired。`apps/bff/src/lib/cli/auth.ts`。不改令牌轮换。

### 40. cli-auth-client（高，提案）

`cli-go/internal/cli/auth.go`、`internal/auth/store.go`。未登录、设备码等待、ready、过期、服务不匹配。等待里还有 slow_down。多进程锁。不改登录。

### 41. website-auth（中，提案）

`apps/website/src/components/SiteAuth.tsx`。`loading | ready | error`。没有结账状态机。不改。

### 42. 其余小生命周期

| id | 状态 | 说明 |
| --- | --- | --- |
| container-health | healthy / failed / cooldown / restarted / restart_limit_reached | `apps/bff/src/lib/container-health.ts`。基础设施 |
| worker-health | starting / active / stale，另加 draining | `worker-health.ts`。发布排空 |
| ops-reconcile-alert | `reconcile_alerted_at` 空或已写 | 核查超过 30 分钟告警一次 |
| error-recovery | recovered / unresolved / unknown | 后台启发式，不是写入机器 |
| overview-source | loading / ready / failed | 后台概览拉数 |
| admin-session | 未登录 / access / refresh / 绝对过期 | `apps/admin/server/lib/session.ts`。不改登录 |
| agent-prompt-aggregate | awaiting / running / completed / failed | 后台 SQL 汇总，cancelled 算进 failed |
| film-export | fetching → encoding，单例 | `filmExportStore.ts`。已是小联合 |
| canvas-media-transfer | waiting / packing / finished / failed | 打包下载 |
| production-export | idle / inspecting / packing / complete / partial / cancelled | 组件内 |
| inpaint-session | 打开的 imageId + submitting | 画布局部编辑 |
| canvas-undo | past/future + busy | 本地与云命令混在一个栈 |
| channel-catalog | settled 布尔 | 空列表可以是「没有渠道」而不是加载中 |
| inspiration-feed | idle / loading-remote / ready / error | 已是联合 |
| announcement-feed | loading / ready / error + 序号 | 防过期响应 |
| save-card | pending / saved | 智能体保存卡 |
| cli-skill | 未装 / 完整 × 是否当前版本 | `cli-go/internal/skill/status.go` |
| cli-update-check | 当天缓存 / 去拉 GitHub | `internal/updates/check.go` |
| toolbox-combine | pending / done / failed | 组件内防过期结果 |

## 提案（这次不改）

1. **不要做的迁移。** 不改状态字符串的库存值，不加 CHECK 来收紧现网已经写入的边（灵感的任意跳转、批量取消不看当前状态）。若以后要收紧，新加迁移，不改已应用的迁移号。
2. **计费。** 不改预扣、结算、退款、阶段预算、GPT 直连密钥、对账确认。`task-transitions.ts` 的 `requeue` / `reconcile` / `finish` / `cancel` 应改成 `queueTask.step`，但与 `finalizeTask` 同函数，留给下一轮专门的结算 PR。
3. **设备码兑换。** 更新加上 `status = approved`，更新不到行就不要发令牌。现在按 id 更新。
4. **工作台与画布任务。** 客户端用一个可辨联合表达本地排队、服务端阶段和终态，替换 `status + queuePhase + cancelled + batchQueued`。要单开，并在测试环境走一遍出图。
5. **对话轮 store。** 把 `turn` / `stopping` / `reconnecting` 的写入收成 `agentTurnSession` 的事件。视图已经定了合法形状。
6. **智能体历史。** `historyCached`、`historyLoading`、`historyFailed` 收成一个阶段。
7. **灵感。** 若运营确认不需要 published → draft 以外的跳转，再收紧表。那是接口变化，要单独说明。

## 明确不修的行为

- 公告库存状态不随时间改写。
- CLI 把核查中显示成 running。
- 上传成功后计时上报抛错仍回调 `failed`。
- 灵感三种状态任意互写。
- 批量取消不读当前状态。
