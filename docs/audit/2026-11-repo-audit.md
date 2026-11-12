# 2026-11 仓库审查清单

基线：`main` @ `0fc025573`（`fix(bff): preserve prompt shaping compatibility`）。公开树通读加调用检索；`private/` 未检出，计费实现以公开接缝和注释为准。公开树没有 `CODEOWNERS`。

本轮直接改掉的只有三件没有行为风险的事，见对应 PR：删掉零引用的文件和 hook、官网 404 按路径选语言、修正断链和过期说明。下面都是**没改**的项。每条都对照过代码，不凭文件名猜测。

## 计费与支付

未改任何计价、预扣、结算或支付代码。

### 高 — 画布阶段张数没有按模型上限收口

- 位置：`packages/shared/src/stage-execution.ts:249`；`apps/web/src/features/agent/store.ts:1494`；对照 `apps/bff/src/lib/agent/tools/queueTask.ts:242-245`、`packages/shared/src/agent.ts:436-452`
- 问题：对话生图用 `agentModelImageCount`，`gemini-3.1-flash-lite-image` 一单最多 4 张（BUG-91，注释写明 8 张会打出 8 条 Vertex 请求并整单 429）。画布阶段授权 `resolveStageImageExecution` 只用 `agentImageCount`，上限是 `AGENT_IMAGE_MAX_N`（10）。前端把 `canvasImageCount` 也按 `agentImageCount` 送出。阶段路径可以按 8 或 10 张报价并提交，对话路径会收成 4 张。
- 为什么没直接修：改张数会改变生成次数和预扣金额，属于计费与生成行为，不是无风险清理。
- 建议做法：阶段执行和 `canvasImageCount` 都走 `agentModelImageCount`，补一条和 BUG-91 相同的 shared / web 测试。PR 里写清少生成的张数对积分的影响。
- 风险等级：高

### 中 — 读消息时顺带结算任务积分

- 位置：读路径是 `apps/bff/src/lib/agent/conversations.ts:361` 的 `settleAgentJobs`（不传 `requireCharges`，失败只打 warn）。同文件 `:325` 是另一条：`settleAgentConversationJobs` 在清任务行之前调用，带 `requireCharges: true`，失败会抛。计费读取在 `apps/bff/src/lib/agent/background-jobs.ts` 的 `taskHooks.taskCredits`。
- 问题：每次拉取会话消息都会跑结算。读路径带写，热点是刷新和轮询。
- 为什么没直接修：结算时机牵动扣费是否漏掉，动它等于动计费接缝。不要把 `:325` 的强制结算和 `:361` 的读路径当成同一次调用。
- 建议做法：先量一条长会话的读延迟和结算次数，再决定能不能把 `:361` 挪到 worker，读路径只看已落库的状态。`:325` 保持清任务前的强制结算。
- 风险等级：中

## 高

没有单独再列一条「高」。上面画布张数是这次看到的最高风险，已放在计费一节。

## 中

### 登录后整页初始化重跑，并可能重复弹出「历史已接收」

- 位置：`apps/web/src/App.tsx:90-117`
- 问题：effect 依赖 `user` 和 `adoptedTaskCount`。用户变化会再次 `setSettings({})`、`initStore()`（IndexedDB 任务、图片 GC、平台生成记录）。`adoptedTaskCount > 0` 时 toast 写在同一个 effect 里，登录造成的重跑会再弹一次。
- 为什么没直接修：登录后重跑初始化可能是为了领养匿名存储，拆开有漏恢复的风险，没有先在浏览器里复现 toast 次数。
- 建议做法：用一次会话只弹一次的标记包住 toast；确认 `initStore` 里哪些步骤必须跟 `user` 走，其余只在挂载时跑。
- 风险等级：中

### 本地对话缓存丢掉大部分工具卡字段

- 位置：`apps/web/src/features/agent/lib/conversationCachePanel.ts:17-75`、`:109-113`；写入侧在 `conversationCache.ts`
- 问题：注释写明缓存不可信，只重建小的展示模型。文件自己也写了：没有工具名和产物 id 时，刷新会先露出提示词卡再跳成图块。目前只为 `generateImage` / `editImage` 补回工具名和产物。其它工具卡在服务端快照返回前没有 `toolName`、失败码、job、门禁和画布字段。
- 为什么没直接修：把 IndexedDB 里的对象原样铺回界面会放行不可信嵌套状态。要扩也得继续用白名单，并补缓存往返测试。
- 建议做法：按工具名白名单补展示所需字段（至少 `toolName`、`errorCode`、`artifacts`），拒绝未知嵌套对象。
- 风险等级：中

### 排队消息失败后参考图计数还在，附件已经清空

- 位置：`apps/bff/src/lib/agent/inbox.ts:314-321`；`apps/web/src/features/agent/components/AgentMessageQueue.tsx:58-61`
- 问题：`failAgentMessage` 把 `attachments` 写成 null，载荷里的 `referenceCount` 还在。队列行仍显示「N 张参考」，用户不能从这条失败记录把图重新发出去。
- 为什么没直接修：保留失败消息上的图片字节涉及存储和隐私；改计数又会改失败队列的可见文案。需要产品决定是留附件还是隐藏计数。
- 建议做法：失败时一并清掉 `referenceCount`，或保留附件直到用户撤回。
- 风险等级：中

### 会话列表和消息读取没有上限

- 位置：`apps/bff/src/lib/agent/conversations.ts:107-118`（`listAgentConversations` 无 `limit`）；同文件 `readAgentMessages`（约 332 行起）按 `seq` 读完整段；`apps/bff/src/routes/agent.ts` 的消息接口走这条
- 问题：历史很长时，一次列表或一次打开会话会把全部行读进内存。回合执行另有 `listAgentHistoryWindow`，和 HTTP 快照不是同一套边界。
- 为什么没直接修：客户端今天按完整快照渲染，加上限会截断历史，属于协议变更。
- 建议做法：先对生产只读库看单用户最大会话数和单会话消息数，再定分页或硬顶。
- 风险等级：中

### 生产草稿逐张查任务

- 位置：`apps/bff/src/lib/agent/production-generation.ts:236-253`
- 问题：每个带 `taskId` 的候选单独 `SELECT ... limit 1`。
- 为什么没直接修：可以收成一次 `inArray`，但这里没有数据库测试环境（本机没有 `TEST_DATABASE_URL`），不宜在没跑集成测试时改查询。
- 建议做法：收集 task id 后一次查回，用现有 production generation 测试锁住状态和产物顺序。
- 风险等级：中

### 补终帧时逐轮查 `agent_turns`

- 位置：`apps/bff/src/lib/agent/events.ts:348-366`
- 问题：`writeSeals` 在循环里按 turn 查页脚，没有页脚时还会动态 import 并调用 `recoverInterruptedTurn`。
- 为什么没直接修：循环里有恢复副作用，不能只把 SELECT 合并就当完成。
- 建议做法：页脚用一次 `inArray` 取回；恢复仍按轮串行。
- 风险等级：中

### 轮事件落库失败只记 warn，且日志没有 conversationId

- 位置：`apps/bff/src/lib/agent/events.ts:157-170`
- 问题：`writes.catch(() => {})` 让下一次写入继续。失败已经 `log.warn`（`agent.event_persist_failed`，带 `turnId` 和 `err`），但没有 `conversationId`。流式事件可能已经发给客户端，库里却没有对应的 `agent_turn_events`。
- 为什么没直接修：设计是落库失败不要打断这一轮。改成向客户端报错会改协议。
- 建议做法：保留不中断和现有 warn，补上 `conversationId`。
- 风险等级：中

### 密码重置把所有异常都报成邮件失败

- 位置：`apps/bff/src/routes/auth.ts:129-133`
- 问题：`requestPasswordReset` 的任何错误都变成 `503 email_delivery_failed`。数据库或配置错误和发信失败在接口上无法区分。
- 为什么没直接修：收窄错误码会改变客户端看到的状态，要先看 `requestPasswordReset` 抛出的类型，避免把内部细节回给用户。
- 建议做法：只把发信失败映射为 503，其它记日志并返回 500。
- 风险等级：中

### 产物封面补全失败时静默退回原文

- 位置：`apps/bff/src/lib/agent/conversations.ts:436-473`
- 问题：`withArtifactMedia` 的空 `catch` 在数据库失败时返回原始消息，不打日志。注释说这是为了读历史不被封面查询拖垮。
- 为什么没直接修：加日志是安全的，但失败频率未知，先打日志可能刷屏；改返回体会让客户端以为封面丢了。
- 建议做法：保留降级，补一条 warn。
- 风险等级：中

### 已登录用户可以读、取消匿名队列任务

- 位置：`apps/bff/src/lib/task-access.ts:13-18`
- 问题：`userId` 非空时条件是 `user_id IS NULL OR user_id = 当前用户`。知道匿名任务 id 的登录用户能读状态、取结果、取消。文件注释写明匿名行保持公开。
- 为什么没直接修：这是写明的所有权规则。收紧会让匿名任务在登录后无法轮询或取消。
- 建议做法：确认任务 id 不可猜测、不会出现在可分享的页面。若会泄露，再改成仅创建该任务的浏览器会话可访问。
- 风险等级：中

### `test` 分支一次推送跑两套流水线

- 位置：`.github/workflows/web.yml:11-14` 与 `.github/workflows/deploy-test.yml:7-8`
- 问题：push `test` 同时触发 Web checks 和 Deploy test。两边都会 lint、typecheck、构建。Deploy test 的 web vitest 是 2 片，web.yml 是 3 片，bff 也是 web.yml 才分 3 片。注释已在文档 PR 里改成如实描述，流水线本身没动。
- 为什么没直接修：合并或删掉 job 会改变发布门禁，不属于无行为风险。
- 建议做法：Deploy test 改为 `workflow_run` 依赖已绿的 Web checks，或显式接受双跑并在发布手册写清原因。
- 风险等级：中

## 低

### 失败状态在 status 与 result 上不一致

- 位置：`apps/bff/src/routes/status.ts:76-80`；对照 `apps/bff/src/routes/result.ts:76-85`
- 问题：`error_message` 为空时 status 不带 `error`，result 仍带 `publicTaskErrorMessage(... ?? 'unknown')`。前端 `queueClient.ts:403-408` 在缺 `error` 时用本地化文案。
- 为什么没直接修：若 status 改成总是发送 `'unknown'`，界面会从本地化失败文案变成服务端英文字符串。
- 建议做法：空消息时 status 也带 `type: 'unknown'`，但 `message` 留空，让前端继续用本地文案。
- 风险等级：低

### 澄清工具抛普通 Error

- 位置：`apps/bff/src/lib/agent/clarification.ts:31-32`；包装之外见 `apps/bff/src/lib/agent/tools/index.ts:255`；`apps/bff/src/lib/agent/turn.ts:755-765`
- 问题：`askClarification` 不在注册表包装里，校验失败抛 `Error` 而不是 `AgentToolError`。`streaks.failed` 只包注册工具。澄清的 `tool_execution_end` 在没有结果块时直接 return，不会记成 `unknown`，也不会触发连续失败熔断。错误文本回到模型。
- 为什么没直接修：改错误类型会改模型看到的失败文本。
- 建议做法：若要和注册工具一致，改成 `AgentToolError('invalid_params', ...)`，并补一条工具失败测试。不是熔断漏洞。
- 风险等级：低

### 工具 schema 允许的张数大于运行时上限

- 位置：`apps/bff/src/lib/agent/tools/queueParams.ts:12-18`；运行时收口在 `queueTask.ts:243-245`
- 问题：schema 的 `maximum` 是 `AGENT_IMAGE_MAX_N`（10）。Lite 模型运行时收成 4，并在回执里加 `capNote`。模型仍可能「要 10 张」。
- 为什么没直接修：schema 是全体模型共用的，按最严模型收紧会让其它模型无法要 5–10 张。
- 建议做法：保持运行时收口和 `capNote`，除非工具声明能按当前模型动态收紧。
- 风险等级：低

### 概览重做后留下的指挥台组件没有引用

- 位置：`apps/admin/src/components/overview/` 下 `HealthStrip.tsx`、`AttentionList.tsx`、`OpsHealthCard.tsx`、`TodayErrorsCard.tsx`、`AgentCacheCard.tsx`、`Sparkline.tsx`、`OverviewTrendChart.tsx`、`LazyOverviewTrendChart.tsx`。路由只用 `OverviewActivity`（`apps/admin/src/routes/_authed.overview.tsx:6`）。`useTodayErrors` 只被 `TodayErrorsCard` 引用。`overview-signals.ts` 仍有测试。
- 问题：2026-11-05 的概览重做（`#1673`、`#1693`）之后，这些组件没有任何 import。
- 为什么没直接修：重做才几天，`overview-signals` 的测试还在描述指挥台规则。删组件会留下只被测试引用的库，删库又必须删测试。
- 建议做法：确认指挥台不再回来后，删组件、`useTodayErrors`，并决定 `overview-signals` 是留下还是连测试一起退役。
- 风险等级：低

### Admin 未使用的依赖

- 位置：`apps/admin/package.json` 的 `@hookform/resolvers`（源码无 import；`form.tsx` 只用 `react-hook-form`）、`@radix-ui/react-scroll-area`（`scroll-area.tsx` 已在死代码 PR 删除，包还在）
- 问题：依赖还在 lockfile 里。
- 为什么没直接修：公开 `pnpm-lock.yaml` 含 `private/apps/*` 三个 importer。没有 `private/` 时重装 lockfile 会删掉它们，muvloom 的 `--frozen-lockfile` 会失败。
- 建议做法：在带 overlay 的检出里删依赖并更新 lockfile。
- 风险等级：低

### `ui/` 原语的 import 风格不统一

- 位置：`apps/web/src/components/ui/button.tsx:5`、`input.tsx`、`tooltip.tsx` 用相对路径 `../../lib/utils`；同目录 `checkbox.tsx`、`label.tsx` 等用 `@/lib/utils`。Admin 里同名文件必须逐字节一致（`apps/web/src/__tests__/components/ui/parity.test.ts`）。
- 问题：`apps/web/AGENTS.md` 写 `ui/` 沿用 `@/`。两端相对路径彼此一致，能编译。
- 为什么没直接修：只为风格改共享原语，parity 测试要求两端一起改，收益小。
- 建议做法：若要统一，两端同一批文件一起改成 `@/lib/utils`。
- 风险等级：低

### 根目录 `vercel.json` 与当前发布路径不符

- 位置：仓库根 `vercel.json`。生产是 Pages + VPS（`AGENTS.md`、`docs/deploy/image-release.md`），workflow 不部署 Vercel。
- 问题：文件仍描述一套 Vercel 构建。
- 为什么没直接修：可能还有人手动用它预览，删除前需要确认没有外部项目指向它。
- 建议做法：确认没有 Vercel 项目后删除，或在文件头注明已停用。
- 风险等级：低

### 一次性脚本没有引用

- 位置：`scripts/prepare-postgres-cutover.ts`（仓库内无引用）；`scripts/generate-canvas-upload-legacy-fixtures.py`（只出现在它生成的夹具头注释里）
- 问题：不像现行发布或 CI 的一部分。
- 为什么没直接修：运维脚本可能只在手工割接时用，删了就没有入口。
- 建议做法：确认割接已结束后再删，或在 `docs/deploy/` 写明仍要保留。
- 风险等级：低

### 旧调研和现行产品叙述不一致

- 位置：`docs/research/conversational-video-production-2026-10-01.md:26-27` 仍写创作类型是 image / video，并讨论独立视频入口；`docs/ROADMAP.md` 与 `CONTEXT.md` 写明旧视频工作台已被统一节点画布取代，新项目不再选图片/视频类型。
- 问题：调研文档没有作废标记，和现行术语冲突。
- 为什么没直接修：改调研正文容易改写当时的结论。应加归档说明，而不是重写。
- 建议做法：文首加「已被 #1136 取代」的归档注，指向 ROADMAP / CONTEXT。
- 风险等级：低

### 云端测试文档和 workflow 触发条件不一致

- 位置：`docs/agents/cloud-tests.md` 与 `.github/workflows/cloud-tests.yml`
- 问题：文档容易读成「改了测试就会跑云端测试」。workflow 的 `pull_request.paths` 只覆盖 cloud-test 相关脚本和该 workflow。文档也没有写 CI 里的 `TEST_DATABASE_URL` 与 workflow 的 `CLOUD_TEST_DATABASE_URL` 是两个名字。
- 为什么没直接修：没把文档和 workflow 逐段对完，避免改错运行说明。
- 建议做法：按 workflow 的 `on.pull_request.paths` 改文档，并写明两个数据库 URL 谁注入给测试进程。
- 风险等级：低

### 直接访问未知地址走静态 404，不走官网 React

- 位置：`apps/web/public/404.html`；说明见 `docs/deploy/image-release.md` 关于顶层 `404.html` 关闭 SPA 回退
- 问题：Pages 和容器对未知路径返回这份静态页（`lang="zh-CN"`，正文已经是「页面不存在 / Page not found」）。官网 `notFoundComponent` 只在开发服务器，或已打开的官网页面里再进未知地址时出现。两套文案不一致。
- 为什么没直接修：静态页已经中英并列，改它会影响工作台和资源路径的全部缺失页，不只是官网。本轮只改了官网路由里的那一套。
- 建议做法：若希望 `/en/*` 的直接 404 也是纯英文，在 `404.html` 里按路径换文案，并保持 `pagesRelease` 测试仍能看到 `Page not found`。
- 风险等级：低

### 模型目录的 family 字段前端还没读

- 位置：`packages/shared/src/model-catalog/index.ts:12`
- 问题：注释写 BFF 在渠道图片模型上附带 `family` 与 `image`，前端暂时不读。启停和单价仍在价目表。
- 为什么没直接修：这是未完成的产品接线，不是死字段。接上会改变模型展示。
- 建议做法：要么前端开始读，要么在注释里写明保留给谁。
- 风险等级：低

## 核对后不算缺陷

- `RETIRED_CAPABILITIES` 里的 `canvas:*` 仍在 `/api/capabilities` 里固定为 `true`。`apps/bff/src/lib/operator-config.ts:415` 写明旧前端还用这四个字段，新前端不再读。测试 `capabilities.test.ts` 锁着这个形状。
- `apps/web/src/dev/designEntry.tsx` 由 `apps/web/design.html` 引用，不是死入口。
- `apps/bff/scripts/inspiration-add.ts` 与 `inspiration-repoint.ts` 写在 `docs/deploy/inspiration-maintenance.md`，是手工入口。
- 匿名队列任务的公开访问见上文「中」，注释已说明意图。
