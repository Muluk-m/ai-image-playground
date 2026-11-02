# 画布节点 + Agent 生成体验研究与目标架构

日期：2026-10-18。状态：研究完成；以下结论把仓库事实、竞品原文事实、推断和建议分开。访问日期均为 2026-10-18。

## 执行摘要

**[FACT]** 仓库已经有两条生成路径：画布本地/节点批次路径会在目标节点写入 `CanvasNodeJob`，因此可以在节点卡片内显示 pending；Agent 的 `runNodes` 只返回一个等待二次确认的 `canvasRun` 提案，不启动任务。确认时，浏览器通过 bridge 读取实时节点并打开 `NodeBatchDialog`。通用 Agent 批次则返回 `batchId`，由对话中的 `AgentBatchPlanCard` 负责整个批次的生命周期。

**[FACT]** 截图出现“通用批次卡而不是节点 loading”的精确原因是 `AgentToolCard` 的顶层分支：只要消息存在 `batchId`，先渲染 `AgentBatchPlanCard`；只有不满足该条件时才进入 `StandardAgentToolCard`，其中才检查 `message.canvasRun` 并渲染 `AgentNodeRunCard`（`apps/web/src/features/agent/components/AgentToolCard.tsx:1431-1445`、`:673-678`）。通用 Agent 批次协议只有 `batchId`，不保证含有目标节点 ID；即使同一消息误带两种详情，`batchId` 也会抢先。此时不会创建节点 job，画布自然没有 loading。

**[RECOMMENDATION]** 将“生成意图属于哪个对象”提升为一等协议：每次 Agent 生成必须明确 `runId`、`projectId`、`targets[]`（节点 ID、目标版本/输入指纹）和每个 target 的状态。节点目标的提案/执行卡和节点本身共同显示状态；通用批次继续使用 `batchId`，但不得伪装成节点运行。确认只提交冻结的 target 集合；任务状态按 target 可部分成功，结果用 `runId + targetId + attempt` 幂等写回节点。整理只改坐标，不改边集合，并在提交前后校验 graph revision。

## 1. 研究边界与证据标记

- **[FACT]**：直接读取仓库代码/ADR，或竞品官方文档、官方帮助中心、官方产品/新闻稿。
- **[INFERENCE]**：由事实推导的解释，不是竞品或仓库明确承诺。
- **[RECOMMENDATION]**：针对本仓库的设计建议。
- 竞品没有公开某字段、进度事件或图序列化时，明确写“官方资料未说明”，不把缺失当作“不存在”。

## 2. 当前仓库端到端路径

### 2.1 画布节点的身份、图和语义

**[FACT]** 画布快照是 `CanvasSnapshot`：节点、分组、标注和有向边；边只有稳定 `id/source/target`，直接上游作为下游上下文（`packages/shared/src/canvas-document.ts:109-121`）。节点稳定身份是 `CanvasNode.id`；图片/视频数据可带 `meta.nodeKind`、`assetKind`、`pending`（`:51-63`）。

**[FACT]** 节点卡已经按语义资产类型选择图标：人物 `character`、地点 `location`、产品 `product`、道具 `toolbox`，其它资产 `layers`；普通文本/视频/图片也有对应图标（`apps/web/src/features/canvas/components/NodeCanvas.tsx:165-176`）。因此“语义图标”基础设施已存在，缺口主要是生成中的目标归属和状态可见性，而不是重新发明节点类型。

### 2.2 用户从画布运行节点

**[FACT]** `buildNodeBatch` 只把选中的图片/视频生成器变成 jobs；节点 prompt 或入边上下文决定是否进入批次，入边引用形成 `dependencies`，并按依赖拓扑排序，循环报错（`apps/web/src/features/canvas/lib/nodeBatch.ts:104-119`、`:224-249`）。引用来自当前 `snapshot.edges`（`:90-103`），所以节点生成确实消费图关系。

**[FACT]** `NodeBatchDialog` 初始状态为 `ready`，用户确认后才执行；执行逐 job 顺序提交，回调显示已完成数和当前 `id`（`apps/web/src/features/canvas/components/NodeBatchDialog.tsx:41-77`）。批次改变签名、节点忙、媒体/模型/额度等会阻止或中断；AbortController 负责关闭/停止（`:46-69`）。

**[FACT]** 每个节点 job 由 `setCanvasNodeJob` 写入共享 Y.Doc，字段包括 `id`、`nodeId`、创建时间、`loading/error/stale`、prompt、`clientRequestId`、可选 BFF request ID、输入指纹和首个结果 ID（`packages/shared/src/canvas-jobs.ts:5-24`）。`canvasPendingJob` 优先返回 loading job，因而节点卡可从共享文档推导 loading（`:46-51`）。

**[FACT]** 图片生成 sink 在打开任务时记录目标 `primaryId`、输入指纹和首个结果，接受队列请求时保存 `bffRequestId`；送达后以 `nodeId` 记录结果并选择主结果，失败把该 job 标成 error（`apps/web/src/features/canvas/lib/nodeCanvasGenerate.ts:148-207`、`:209-268`）。刷新时可按 BFF request ID 恢复；无法恢复的任务标记 stale，避免永久转圈（`:344-415`）。

### 2.3 Agent `runNodes` 路径

**[FACT]** BFF 工具名为 `runNodes`，说明明确写“只给出运行建议”，用户需在对话卡检查预估并在画布二次确认；工具本身不生成、不扣费（`apps/bff/src/lib/agent/tools/nodeCanvas.ts:322-332`）。

**[FACT]** BFF 读取服务端 Y.Doc，验证 `nodeIds` 都是节点或分组，然后返回 `{ projectId, nodeIds }` 的 `canvasRun`；响应 `submitted:false`，不会创建 task 或修改画布（`:347-369`）。共享类型目前只有 `projectId` 和 `nodeIds`（`packages/shared/src/agent.ts:678-682`）。

**[FACT]** 云画布挂载时，`useAgentNodeRun` 注册 bridge。它校验 proposal 项目归属及节点 ID 存在，再用 `currentNodeBatch` 计算实时计划；review callback 选中目标、聚焦视口、保存计划并设置 `batchIds`，但仍未提交任务（`apps/web/src/features/canvas/lib/useAgentNodeRun.ts:32-53`；`apps/web/src/features/canvas/components/NodeCanvas.tsx:1107-1129`）。

**[FACT]** 对话提案卡 `AgentNodeRunCard` 调用 bridge quote 显示同一份 `NodeBatchJobs` 和估算费用；“允许一次”才调用 bridge review（`apps/web/src/features/agent/components/AgentNodeRunCard.tsx:12-56`）。画布 review 后打开 `NodeBatchDialog`，初始 plan 来自 Agent 卡并重新校验签名（`apps/web/src/features/canvas/components/NodeCanvas.tsx:2068-2080`；`apps/web/src/features/canvas/components/NodeBatchDialog.tsx:41-56`）。

### 2.4 为什么截图会是通用批次卡

**[FACT]** `AgentToolCard` 的导出组件先测试 `props.message.batchId`，存在即渲染 `AgentBatchPlanCard`；只有没有 `batchId` 才进入标准卡（`apps/web/src/features/agent/components/AgentToolCard.tsx:1431-1445`）。标准卡内部才测试 `message.canvasRun` 并显示 `AgentNodeRunCard`（`:673-678`）。

**[FACT]** 通用批次卡通过 `batchId` 拉取完整的 `AgentBatchPage`，按批次状态（running/paused 等）显示 item progress、执行状态、取消、重试和版本冲突（`apps/web/src/features/agent/components/AgentBatchPlanCard.tsx:63-73`、`:180-228`、`:390-443`）。它的 item key 是通用 batch key，并非画布 `nodeId`。

**[INFERENCE]** 当 Agent 走通用 `proposeBatchGeneration`/通用图片生成时，消息只带 `batchId`（仓库通用协议也把 `batchId` 单独定义为可选字段：`packages/shared/src/agent.ts:684-702`），没有可靠 target node IDs；UI 无法安全地把结果归入某一节点，所以只能显示通用批次卡并在完成后提供“放入画布”等通用操作。若截图对应这种消息，节点 loading 不会出现，因为只有实际节点 submit 才调用 `setCanvasNodeJob`。若消息同时含 `batchId` 与 `canvasRun`，当前分支优先级仍会错误地选通用批次卡。

**[RECOMMENDATION]** 路由规则应显式判别：`targets.length > 0` 的 node-targeted run 优先走节点运行卡；`batchId` 且没有 targets 的 generic batch 才走 `AgentBatchPlanCard`；两者同时存在应在协议校验层拒绝，而不是静默选择。

### 2.5 自动整理与连接线

**[FACT]** `arrangeNodes` 从快照边建立 incoming/outgoing，按拓扑 rank、连通 cluster 和分组 hull 计算新位置；边只用于布局计算，没有被删除或重写（`apps/web/src/features/canvas/lib/arrangeNodes.ts:26-67`、`:104-142`）。预览的 `arrangementKey` 还把边的 `id/source/target` 纳入 key，因此拓扑改变会使预览失效（`:145-151`）。

**[FACT]** Agent 的 `arrangeNodes` 工具读取并校验节点，然后只调用 `moveCanvasNodes` 写入 `x/y`（`apps/bff/src/lib/agent/tools/nodeCanvas.ts:287-319`）。画布“保留整理前位置”的预览提交也只移动节点/分组，且不触碰 edges（`apps/web/src/features/canvas/components/NodeCanvas.tsx:1147-1182`）。

**[INFERENCE]** 当前实现对“自动整理不能破坏连接线”已有数据层优势；主要风险是未来为了生成结果插入新节点、替换整份文档或用旧快照恢复时误覆盖边。推荐把“坐标 patch 与 edge 集合不变”作为明确不变量和测试验收项。

### 2.6 历史、同步和已有幂等基础

**[FACT]** ADR-0023 规定项目画布以 Y.Doc 为准，Agent 与浏览器对同一 CRDT 合并，生成结果不把位图塞进文档，只存生成记录引用/主结果（`docs/adr/0023-canvas-document-on-yjs.md:9-15`、`:22-32`）。

**[FACT]** ADR 同时规定 Agent 画布命令在项目、轮次、tool-call ID 下幂等，保存增量并可整体撤销；撤销会在当前文档上重建逆操作，避免旧 JSON 覆盖后来编辑（`:67-82`）。

**[RECOMMENDATION]** 新 run 协议应复用 Yjs 和这些幂等/撤销原则，不另建第二份“生成中的画布快照”。任务记录可存于节点 job/服务端 task，节点只保留稳定引用和状态投影。

## 3. 官方竞品证据矩阵

| 产品/官方来源 | 结果放置与目标身份（官方事实） | 进度、生命周期、图/连接证据边界 | 对本仓库的启发 |
| --- | --- | --- | --- |
| [Adobe Firefly Boards：Generate image variations](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/generate-image-variations.html) | 先在画布选择已有图片，再用 More like this/Keep style/Keep subject/Custom vary 生成；结果先在 variation filmstrip，用户选择后可拖到画布。官方还说明可 Load 恢复原 prompt、比例、模型等设置，并可继续编辑、重排。 | Boards 文档没有公开 per-job 进度事件、取消协议、结果 ID 与源元素外键，也没有说明生成后是否保留持久 source→result 边。 | 明确区分“生成结果可用”和“插入/归属目标”；同时保存 generation settings 便于重试。来源访问：2026-10-18。 |
| [Adobe Firefly Creative Production：Add and connect nodes](https://helpx.adobe.com/firefly/web/work-with-enterprise-features/creative-production/build-custom-workflows.html) | 官方工作流使用 input、processing、output 节点；用户拖节点到画布，在连接点连接；多个 connection points 可分别接 Text Prompt/Reference Image；Assistant 可创建工作流。 | 官方明确“先连接，再用 sample inputs 测试并调整”；没有公开运行时事件协议。 | 连接点/边是工作流的一等结构；自动布局必须只改几何，不可替换连接。来源访问：2026-10-18。 |
| [Canva Magic Studio](https://www.canva.com/en_in/newsroom/news/magic-studio/) | Magic Design 接收文字 prompt 或上传媒体，快速生成 curated editable designs；Magic Media 生成图/视频后“add it to your design”；Magic Edit 先选择要改的位置再生成。 | 官方新闻稿描述秒级结果和编辑，但没有公开节点 ID、per-object progress、取消/重试或图边协议。 | 对“结果属于当前设计/所选区域”的直接心智模型有帮助；本仓库应比 Canva 更严格地保留 node target，因为节点图不是普通页面。 |
| [Canva AI launches / Visual Suite](https://www.canva.com/newsroom/news/canva-ai-launches/) | Canva AI 从首页以单 prompt 生成 personalized design drafts、Docs、visuals；官方写明 Design for me 生成 editable designs，并可在 Visual Suite 中协作迭代；Create an image 支持上传 style references。 | 没有公开运行状态机或对象外键。 | 生成入口可以跨产品，但结果仍应以可编辑对象回到工作面；“editable”比只给对话缩略图更接近目标。 |
| [Canva Magic Layers](https://www.canva.com/newsroom/news/magic-layers/) | 将 flat/static image 还原成 Canva editor 内 fully editable multi-layered design；识别文本、独立对象、背景并保留 layout relationships。 | 官方未公开重建过程的进度/幂等或层关系 API。 | 结果落地后仍保留结构关系；本仓库结果应写入目标节点候选并保留已有边，而非把结果降级成无归属图片。 |
| [Canva AI Whiteboards](https://www.canva.com/newsroom/news/canva-ai-whiteboards/) | Whiteboards 是 infinite canvas；官方描述从 Presentation expand to Whiteboard，元素、stickies、shapes、lines 在同一空间；Sort 一键按颜色、作者、反应或主题整理 sticky notes。 | 公开资料强调实时协作/排序，但未给图 ID、连线保留算法或生成任务事件。 | 整理是对已有对象的可逆空间操作，不能改变用户建立的语义关系；排序/布局应产生单独历史步。 |
| [Figma：Make boards and diagrams with FigJam AI](https://help.figma.com/hc/en-us/articles/18706554628119-Make-boards-and-diagrams-with-FigJam-AI) | 用户在 FigJam Actions 选择 Make templates and diagrams，输入 prompt 后 Make；官方写明可生成 boards、flow charts、mind maps、Gantt/org charts，结果是 board/diagram 的一部分，用户可调整 prompt 再生成新的 visual。 | 未公开逐节点进度、目标 ID、取消/重试协议。 | 生成结构化 board/diagram 后应留在 board，而不只留对话；但本仓库要补充稳定 target identity。 |
| [Figma：Generate and edit images with Figma AI](https://help.figma.com/hc/en-us/articles/24004542669463-Generate-and-edit-images-with-Figma-AI) | 先选择要放入的位置：选 layer 填充现有 layer，或取消选择创建新 image layer；也可选择一个或多个图片同时执行；官方称可在切换 frame/继续设计时运行。 | 官方公开“同时运行 AI image tasks”，但没有公开 job ID、progress event 或 graph edges。 | Figma 的关键做法是生成前先确定 insertion target；本仓库应把 target node 在 proposal 阶段冻结。 |
| [Midjourney Editor](https://docs.midjourney.com/hc/en-us/articles/32764383466893-Editor) | 官方 Editor 文档（该页面抓取受 403 限制，仍为官方 owning URL）描述提交编辑后 Results panel 出现四个结果，可继续编辑或导出；V8.x/Edit Model 结果自动出现在 Create/Organize，V7 及更早版本需 upscale 才进入。 | 官方资料未形成公开的画布节点/连线协议；该 workflow 强调结果面板、upscale/进入 gallery 的生命周期。 | 结果可能经历“预览→正式归档/可见”的阶段；本仓库应区分 candidate 与 selected main result，不能把 preview 当完成。 |
| [Midjourney Style Reference](https://docs.midjourney.com/hc/en-us/articles/32180011136653-Style-Reference) | 官方说明 `--sref` 可接一个或多个 image URL 或 style code，Web 端上传/选择 image 放入 Style Reference；`--sw` 控制影响强度。 | 仅描述引用如何影响生成，没有公开结果与引用的持久边关系或进度。 | 引用应是有角色的 dependency/reference，而不是把所有上游都塞成无序 prompt 文本；仓库已有 reference order/roles，可继续显式化。 |
| [Krea Realtime](https://www.krea.ai/docs/user-guide/features/realtime) | Krea 把 canvas 作为 active creative surface：左侧输入画布（draw、shape、upload、generated elements），右侧 live output；每次笔画、颜色、prompt 改变都即时反映。Generate image 工具可把 AI image 直接放在画布作为后续 reference layer；Seed 产生当前输入的 variation。 | 官方明确“no queue, no waiting, no render button”，是连续反馈而非离散 queued job；未公开结果 ID、取消/重试、图边持久化。 | 实时预览适合快速探索，但本仓库的付费离散生成仍需 durable run/job 状态；节点内显示目标状态，避免把连续预览误当已提交结果。 |

**[INFERENCE]** 竞品共同趋势不是“把所有生成塞到对话卡”：Firefly Boards、Canva、Figma 将结果放回可编辑工作面；Krea 让画布成为实时输入；Midjourney 把结果面板与正式归档阶段分开。它们公开资料普遍不提供完整的节点级后台协议，因此不能照搬视觉表面，必须在本仓库补足身份、幂等和图一致性。

## 4. 第一性原理分析

### 4.1 身份与所有权

- 一个生成请求至少有三种身份：**run**（用户意图/一次确认）、**target**（画布节点，决定归属）、**attempt**（同一 target 的一次提交/重试）。只用 `batchId` 把三者压扁，必然出现通用卡无法回答“哪张节点正在转”。
- 目标节点可能在请求期间被重命名、移动或删除；名称和坐标不是身份，稳定 `nodeId` 才是。proposal 应携带 `projectId + nodeId + expectedNodeRevision/inputFingerprint`。
- 一个结果的 ownership 应由 `result.nodeId` 与 `runId/attempt` 明确建立；“对话里出现过”不能证明“属于该节点”。

### 4.2 生命周期、幂等、取消与重试

- 推荐状态：`proposed → awaiting_confirmation → accepted → queued → running → (succeeded | partial | failed | cancelled | stale)`；target 级状态允许同一 run 中不同节点分别结束。
- 提案不是任务：在 `awaiting_confirmation` 期间不扣费、不写 node job；确认后原子创建 run/attempt，节点立即显示 queued/running。
- 幂等键：`runId + targetNodeId + attempt`，服务端提交和客户端回放都不得重复扣费或重复写候选。重试创建新 attempt，但保留 `retryOf` 和原失败结果，不能覆盖已选主结果。
- 取消要区分“尚未提交的计划取消”和“已提交 provider task 的撤销”；provider 不支持撤销时，UI 显示 cancellation requested，迟到结果仍按 run/attempt 关联，默认不覆盖用户期间选定的新主结果。

### 4.3 依赖图、部分失败和放置

- 生成 target 的输入是直接 incoming edges 和引用角色；执行顺序按依赖拓扑。上游失败时，下游应为 `blocked`/`dependency_failed`，而不是泛化成“批次失败”。
- 结果默认写入预先存在的 target node 的 candidate history，保持 `x/y/width/height` 和所有 edges；只有用户明确选择“新节点”才创建新 node，并由 placement service 在目标旁放置。
- 发生部分失败时成功节点可选主结果，失败节点保留错误和 Retry；run 总体状态为 `partial`，而不是让用户无法判断哪些完成。
- 整理是坐标变换：输入/输出边集合和 node IDs 必须不变；预览提交应记录一条可撤销历史。节点被删/改拓扑时，布局预览失效并要求重算。

### 4.4 历史、协作与用户心智模型

- 用户问的是“这个人物节点是否正在生成”，不是“某个聊天批次第 3 项是否 in_progress”。节点必须是状态第一归属，聊天卡是控制面/摘要面。
- Agent 卡可以保留审批、估价、取消和失败总览；它必须显示目标节点标签和“在画布查看”入口，并能聚焦对应节点。
- Yjs 合并意味着状态投影也必须可合并：每个 job 独立记录，不能用整份旧 snapshot 覆盖用户新边/位置。用户在生成期间移动节点，应保留该移动；完成时只写结果引用和 job terminal state。

## 5. 推荐目标架构

### 5.1 统一但可判别的协议

**[RECOMMENDATION]** 扩展 `AgentCanvasRunProposal`（名称可调整）为：

```ts
interface AgentCanvasRunProposal {
  projectId: string
  runId: string                 // proposal/approval/run stable identity
  source: 'agent' | 'canvas'
  operation: 'generate' | 'edit' | 'video'
  graphRevision: string         // Y.Doc snapshot/fingerprint at quote time
  targets: readonly {
    nodeId: string
    nodeType: 'image' | 'video'
    label?: string
    inputFingerprint: string
    dependencies: readonly string[]
    expectedNodeRevision?: string
  }[]
  status: 'awaiting_confirmation'
}
```

执行/状态事件应使用：

```ts
interface CanvasRunTargetState {
  runId: string
  targetNodeId: string
  attempt: number
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale' | 'blocked'
  progress?: { completed?: number; total?: number; message?: string }
  taskId?: string
  resultIds?: readonly string[]
  errorCode?: string
  retryOf?: { runId: string; attempt: number }
}
```

保留 generic batch 协议：`batchId` 仅表示没有节点 target 的通用 Agent 批次。禁止同时发送 `batchId` 和 `canvasRun.targets`；兼容期若必须同时发送，前端显式以 `targets` 路由节点卡，并记录 telemetry/警告，不能静默走 generic branch。

### 5.2 服务端与客户端职责

1. **BFF proposal**：读取 Y.Doc，验证项目、目标类型、节点存在、依赖闭包和 graph revision；返回冻结 targets、报价、runId，不创建 provider task。
2. **对话审批卡**：显示目标节点语义图标/名称、每个 target 的估价与依赖摘要；确认后调用 node-run confirm，而不是通用 batch confirm。
3. **画布 bridge**：确认前实时重 quote；若 graph revision、目标输入指纹或节点已删除，拒绝并要求刷新。确认后批量创建 target jobs，按拓扑启动。
4. **节点渲染**：读取 `canvasNodeJobs(node.id)`/run projection；卡片内显示 queued/running spinner、target label、进度、错误、Retry/Cancel。对话卡只做摘要并提供“聚焦节点”。
5. **结果 sink**：以 `runId + nodeId + attempt` 幂等；候选结果先落 `canvasResults`，只在“该节点仍无更新主结果/用户未选择其它候选”时自动选择；成功/失败状态写 terminal job。
6. **generic batch**：无 targets 时维持 `AgentBatchPlanCard` 的分页、版本冲突、通用取消/重试和资产库归档；生成结果只能在用户明确选择后放入画布，并使用 `anchorObjectId` 或新的 placement action，不猜目标。
7. **arrange**：输入完整 edge set，输出仅 `{nodeId,x,y}`；提交前断言 node IDs、edge IDs/source/target、组成员不变，历史中作为单步可撤销操作。

### 5.3 状态与错误语义

| 层级 | 状态/错误 | UI 行为 |
| --- | --- | --- |
| run | awaiting_confirmation | 对话审批；节点显示 proposed/不转圈 |
| target | queued/running | 节点内 loading；对话显示“人物、地点…”目标列表和总进度 |
| target | succeeded | 候选计数/缩略图出现在目标节点；保持位置/边 |
| target | failed | 节点错误徽标 + Retry target；其它成功 target 不回滚 |
| target | blocked | 显示具体 dependency_failed/graph_invalid；修复依赖后可重 quote |
| target | cancelled | 停止继续提交；provider 已提交的任务按真实终局收敛 |
| run | stale | 节点或输入指纹不再匹配；不把迟到结果覆盖新主结果 |
| graph | changed/conflict | 提交前重新读取并重新报价，不能用旧计划强行覆盖 |

## 6. 分阶段迁移计划

1. **协议与路由（低风险）**：新增 `runId/targets/graphRevision`，保留当前 `nodeIds` 反序列化兼容；修正 `AgentToolCard` 分支，使 node-targeted payload 优先并拒绝混合 payload。为截图场景增加回归测试：generic batch 无 node loading；node run 显示 `AgentNodeRunCard`。
2. **目标级状态投影**：把现有 `CanvasNodeJob` 的 `clientRequestId` 关联到 `runId/attempt`，补 target 状态/错误分类；现有刷新恢复逻辑继续复用 BFF request ID。
3. **节点内反馈**：在 Image/Video node card 中显示 job status、目标语义图标、阶段文案和 Retry/Cancel；Agent 卡增加“在画布查看”并聚焦 target IDs。
4. **部分成功与幂等**：按 target 拆分 `runNodeBatch` 的 terminal handling；成功保留候选，失败可单 target retry；服务端和客户端以 run/target/attempt 去重。
5. **图完整性验收**：为 generation completion、retry、arrange、并发移动、删除节点、刷新恢复编写测试，断言 edge 集合不变、位置不被旧快照覆盖、迟到结果不覆盖新主结果。
6. **generic batch 归属边界**：继续支持通用批次；只有用户点击“放入画布”且选择 anchor/目标节点时才执行 placement。禁止根据 prompt、名称、最近节点猜归属。

## 7. 被否决的替代方案

- **只把 generic `batchId` 重命名成 node loading**：否决。batch item 没有可靠 node identity，无法处理删除、重试、部分失败和迟到结果。
- **只在对话卡加“正在生成”文案**：否决。不能满足用户在画布上看到目标节点状态的心智模型，也无法解决节点与结果 ownership。
- **完成后总是创建新节点**：否决。会破坏已有节点的稳定 identity、引用边和用户位置；默认应写目标节点 candidate。
- **把整份画布快照作为生成提交/恢复载荷**：否决。与 ADR-0023 的 Yjs 合并和后来用户编辑保护相冲突，可能丢连接线。
- **把所有生成统一迁移到通用 batch API**：否决。通用批次的分页/版本控制有价值，但无法替代节点级依赖、边、目标 job 和节点内 pending。
- **照搬 Krea 的连续实时预览作为付费任务模型**：否决。实时 preview 可作为未来探索模式，但离散生成仍需 durable queue、取消、幂等和账单边界。

## 8. 开放风险

- **服务端版本/协议兼容**：旧 Agent 历史只有 `nodeIds` 或 `batchId`；需要明确迁移/反序列化策略和混合版本客户端行为。
- **节点版本定义**：当前文档没有统一 node revision 字段；可先用 `canvasInputFingerprint` + graph fingerprint，长期应有节点数据版本/删除 tombstone。
- **provider 迟到结果**：取消或重试后旧任务仍可能回调；必须用 attempt/输入指纹门控主结果选择。
- **视频与多输出**：视频任务耗时、候选和 `quantity` 与图片不同；target-level progress 不能假定一个统一百分比。
- **跨设备恢复**：Y.Doc job 能同步，但本地 BYOK 请求不能总能恢复；应明确 stale/cancelled 文案，不让节点无限 loading。
- **布局密度与用户手动位置**：自动整理应保持语义 cluster，但不能隐式移动用户未选中的节点；已有预览方式可延续。
- **竞品证据缺口**：竞品公开资料多数没有后台协议；矩阵只说明可观察产品行为，不证明其内部实现或可靠性。

## 9. 来源清单（均访问于 2026-10-18）

### 仓库来源

- `apps/web/src/features/canvas/components/NodeCanvas.tsx`（节点图标、Agent bridge、整理与 NodeBatchDialog 路径）。
- `apps/web/src/features/canvas/lib/useAgentNodeRun.ts`（proposal quote/review bridge）。
- `apps/web/src/features/canvas/lib/nodeBatch.ts`（依赖、计划签名、顺序提交、取消/部分执行边界）。
- `apps/web/src/features/canvas/lib/nodeCanvasGenerate.ts`（node job sink、结果写回、刷新恢复）。
- `apps/web/src/features/canvas/lib/arrangeNodes.ts`（使用 edges 的布局、只返回坐标、拓扑 key）。
- `apps/web/src/features/canvas/components/NodeBatchDialog.tsx`、`NodeBatchJobs.tsx`（确认/运行/进度 UI）。
- `apps/web/src/features/agent/components/AgentToolCard.tsx`、`AgentNodeRunCard.tsx`、`AgentBatchPlanCard.tsx`（通用批次与 node proposal 路由/生命周期）。
- `apps/bff/src/lib/agent/tools/nodeCanvas.ts`（`runNodes` proposal-only 协议）。
- `packages/shared/src/agent.ts`、`canvas-document.ts`、`canvas-jobs.ts`（共享 proposal、节点、边和 job schema）。
- [ADR-0022：节点画布换成 React Flow](../adr/0022-node-canvas-on-react-flow.md)。
- [ADR-0023：画布文档以 Yjs 为准](../adr/0023-canvas-document-on-yjs.md)。

### 官方竞品来源

- Adobe Help： [Firefly Boards—Generate image variations](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/generate-image-variations.html)。
- Adobe Help： [Firefly Boards—Create boards](https://helpx.adobe.com/in/firefly/web/create-mood-boards/firefly-boards/create-mood-boards.html)。
- Adobe Help： [Firefly Creative Production—Add and connect nodes](https://helpx.adobe.com/firefly/web/work-with-enterprise-features/creative-production/build-custom-workflows.html)。
- Canva Newsroom： [Introducing Magic Studio](https://www.canva.com/en_in/newsroom/news/magic-studio/)。
- Canva Newsroom： [Design, code, and create with our biggest AI launches](https://www.canva.com/newsroom/news/canva-ai-launches/)。
- Canva Newsroom： [Introducing Magic Layers](https://www.canva.com/newsroom/news/magic-layers/)。
- Canva Newsroom： [Canva AI Whiteboards](https://www.canva.com/newsroom/news/canva-ai-whiteboards/)。
- Figma Learn： [Make boards and diagrams with FigJam AI](https://help.figma.com/hc/en-us/articles/18706554628119-Make-boards-and-diagrams-with-FigJam-AI)。
- Figma Learn： [Generate and edit images with Figma AI](https://help.figma.com/hc/en-us/articles/24004542669463-Generate-and-edit-images-with-Figma-AI)。
- Midjourney Docs： [Editor](https://docs.midjourney.com/hc/en-us/articles/32764383466893-Editor)（官方页面在本次文本抓取中返回 403；URL 为 owning source，未将抓取失败当作功能不存在）。
- Midjourney Docs： [Style Reference](https://docs.midjourney.com/hc/en-us/articles/32180011136653-Style-Reference)（同上）。
- Krea Docs： [Realtime](https://www.krea.ai/docs/user-guide/features/realtime)。

## 10. 可直接转成实现 issue/spec 的行动结论

**[RECOMMENDATION]** 建立“Node-targeted Agent Run v2”实施 issue：扩展 `AgentCanvasRunProposal` 为带 `runId + targets + graphRevision + inputFingerprint` 的 proposal；禁止 node targets 与 generic `batchId` 混用；修正 `AgentToolCard` 路由优先级；确认后按 target 写入现有 Yjs `CanvasNodeJob`；节点卡显示 queued/running/partial/error/retry/cancel，Agent 卡仅作审批和聚焦摘要；结果以 `runId/nodeId/attempt` 幂等写入目标节点候选；整理/完成/重试均断言 edge IDs/source/target 不变；generic batch 保留现有 `AgentBatchPlanCard`，只有用户明确选择 anchor 才放入画布。该 issue 的完成标准是：截图场景中目标节点在提交后立即有 loading，generic batch 仍不冒充节点运行，刷新/迟到结果/部分失败/自动整理都不丢连接线或覆盖用户的新主结果。
