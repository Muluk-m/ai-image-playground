# React Flow 迁移遗留问题修复方案

日期：2026-10-18

状态：方案已确认，尚未实施。本文记录用户最终修正，取代此前关于失败占位保留、重试待确认、“完全不可见才平移”及云端同步桥按 `isLocalPlaceholder` 过滤的判断。

## 实施基线与范围

- 必须基于最新 `origin/main` 开分支，包含 #1349 新增的 `nodeCanvasFocus`，不能在缺少该入口的旧分支上实施。
- 按第 1 → 第 2 → 第 3 条顺序实施，每条独立验证、独立 commit。
- 保留 Konva 分支与仍有消费者的旧编辑器投影，不进行整体旧链路清理。
- 本文中的行号仅用于定位审查时的代码；实施时以最新 main 的符号和调用链为准。

## 1. P2：生成占位的自动定位仍在操作旧镜头

### 问题

`agentCanvasSink.ts` 的 `reserve()` 和 `markFailed()` 补建失败占位路径仍调用 `editor.scrollToElements()`。#1349 只给 `focus` 和 `focusPending` 接入了 React Flow 定位。

`markFailed()` 的补建分支只处理 `deferred` 中的请求，而 `deferred` 只在云端项目的图片调用时写入，所以该路径只出现在云端项目，由第 3 条整体删除，本条不处理。

`placeholderShapeOps.ts` 中的结果放置路径还使用旧编辑器的 `getViewportPageBounds()` 判断结果是否在视口外。在节点画布下，旧镜头不是实际显示视口，该判断不能继续用于 React Flow。

### 修改

在 `nodeCanvasFocus.ts` 增加与 `focusNodeCanvas` 并列注册的入口：

```ts
revealNodeCanvas(editor, ids): boolean
```

约定：

- 只移动视口，不改变选择，不改变 zoom。
- 复用 NodeCanvas 现有 `revealNode` 的平移算法，并支持多个节点的包围盒。
- 只要目标没有完整落入 React Flow 可用区域，就做最小平移；不能使用“完全无交集才平移”的规则。
- 包围盒大于可用区域时，超宽轴按左侧对齐，超高轴按顶部对齐；两轴都超出时按左上角对齐。
- 可用区域需考虑 composer、导航和工具等遮挡。
- 返回值表示是否已由节点画布接管，而不是是否发生移动。目标已经可见时也返回 `true`，防止误走旧镜头兜底。
- NodeCanvas 未挂载时返回 `false`。

调用点：

1. `agentCanvasSink.reserve()`：先尝试 `revealNodeCanvas`，未接管时才调用 `editor.scrollToElements()`。覆盖本机项目的图片 / 视频占位，以及云端项目的视频占位。
2. `placeImagesIntoTargets` 中结果放置后的可见性判断：先交给 `revealNodeCanvas`；只有返回 `false` 才进入旧 `getViewportPageBounds()` 判断和滚动分支。

不把 `focusNodeCanvas` 用于这些自动定位路径。它会选择节点并通过 `showFrame` 缩放，而 Composer 和 `turnSubmission` 会从 `nodeCanvasSelection` 读取参考节点。生成开始时改选择会替换用户原本选中的参考图。

### 同步时机

`reserve()` 建出的占位需先经同步桥写入 Y.Doc，NodeCanvas 才能找到它：本机项目走 `localNodeCanvas`，云端项目的视频占位走 `cloudNodeProjects` 的 legacy 同步订阅。

- 两条桥都要核实：`reserve()` 调用 reveal 时，占位是否已进入 Y.Doc。
- 如果尚未进入，使用 `requestAnimationFrame` 延后一帧处理，不无条件增加延迟。
- 延迟处理须绑定原编辑器及注册实例；切换项目或卸载后不得移动其他画布。

### 验证与验收

- 使用真实 sink 验证 `reserve()` 后占位进入节点文档，自动定位走 reveal。
- 选择保持不变，zoom 保持不变；不能只用函数调用次数证明行为正确。
- 目标已完整可见时不移动，也不触发旧镜头兜底。
- 部分越界时最小平移；多个占位形成超大包围盒时按上述规则对齐。
- NodeCanvas 未挂载时旧画布定位仍可用。
- 云端项目生成视频时，占位同样自动进入视口。
- 浏览器实测：本机项目选中参考节点，将镜头平移到远处后生成；占位进入视口，原参考节点仍选中。

## 2. P2：创作记录仍读取旧选中态

### 问题

`AgentCreations.tsx` 订阅旧 `doc.version`，通过 `doc.selection` 决定作品高亮和批注的 `aria-current`。React Flow 的选择只写入 `nodeCanvasSelection`，所以画布选择和创作记录高亮脱节。

### 修改

参照 `AgentComposer.tsx` 已有模式：

- 显式向 `AgentCreations` 传入与 `doc` 对应的 `editor`，更新全部调用方。
- 额外订阅 `subscribeNodeCanvasSelection` / `nodeCanvasSelectionRevision`。
- 选中集合使用：

```ts
const selected = new Set(nodeCanvasSelection(editor) ?? doc.selection)
```

- NodeCanvas 激活时，即使选择为空数组，也必须使用节点选择，不能回退旧选择。
- 未激活节点画布时才使用 `doc.selection`。
- 作品卡和批注统一使用该集合判断高亮。

元素 ID 与节点 ID 一致，`toNode` 保留原 ID，不需要新增 ID 映射。

### 验证与验收

- 调用 `setNodeCanvasSelection` 后，对应记录的 `aria-current="true"`。
- 取消选择后高亮消失，不被旧 `doc.selection` 恢复。
- 节点画布卸载后，旧画布选择回退正常。
- 浏览器实测：画布选中图片，对应创作记录高亮；点击记录后，画布定位且列表高亮跟随。

## 3. P2：云端项目不再补建提交前拒绝的失败占位

### 已确认的判断

#### 仅过滤不能保留本机占位

`cloudNodeProjects.ts` 的 `projectToEditor()` 在 Y.Doc 更新后执行 `editor.doc.restore(scene.elements, …)`，用节点文档的投影整体覆盖旧编辑器。

如果只阻止本机占位进入 Y.Doc，节点画布本来就不会显示它，后续投影还会将其从旧编辑器清掉。因此不采用“过滤后继续在本机保留”的方案，必须从源头停止云端补建。

#### 去掉补建不影响批量重试

提交前拒绝错误码：

- `insufficient_credits`
- `quota_exceeded`
- `authentication_required`
- `invalid_params`
- `model_unavailable`

`AGENT_RETRYABLE_ERROR_CODES`：

- `upstream_error`
- `timeout`
- `no_output`

两组没有重叠。这类拒绝本来就不进入 `RetryRemaining` / `retryRemaining`，不再将重试兼容列为待确认项。

#### 对话已有处理入口

`AgentToolCard.tsx` 的 `FailureAction` 按错误码提供登录、充值或“让助手重新处理”，不依赖画布占位。旧画布中补建占位用于提供另一个处理入口，节点画布不再沿用这条路径。

### 修改

#### 源头：`agentCanvasSink.markFailed()`

- 云端图片的 `deferred` 请求提交前被拒时，只清理 `deferred`，不补建占位。
- 保留既有占位的错误状态更新，包括本机项目及云端视频：视频在 `reserve()` 时已有占位，失败时仍转为错误状态。
- 删除不再使用的 `REFUSED_BEFORE_SUBMISSION` 常量，以及顶部和相关位置关于“本机补失败占位”的过时说明。
- 已受理任务的服务端失败状态处理保持不变。
- 本机项目的已有失败占位和错误状态更新保持不变。

#### 不在云端同步桥按 `isLocalPlaceholder` 过滤

`reserve()` 只把云端项目的**图片**交给服务端预留（`cloud?.enabled() && media !== 'video'`）；云端项目的**视频**仍由 `createPlaceholders` 建本机占位，它不带 `cloudGeneration`，`isLocalPlaceholder` 判为 true。该占位正是经 `cloudNodeProjects` 的同步订阅写入 Y.Doc，才在节点画布上显示「生成中」，并在 `projectToEditor()` 的 `restore` 后继续留在旧编辑器里供交付替换。

若在同步桥按 `isLocalPlaceholder` 过滤：

- 云端项目生成视频时，节点画布看不到占位。
- 下一次投影覆盖旧编辑器时占位被清掉，视频交付找不到占位，退回找空位放置。

因此不加该过滤。源头不再补建后，提交前被拒的失败占位已无产生入口。

- 不修改 `cloudNodeProjects.ts` 的同步订阅、shared 的 `toNode` / `synchronizeLegacyElements`。
- 不修改 `nodeCanvasSlice.ts` 和 `nodeVideoTools.ts` 的调用点：元素未变化时会跳过，不构成泄漏入口。
- 不提供按错误码的替代过滤：`markFailed()` 会把收到的错误码写入已有占位，云端视频遇到 `insufficient_credits` 等码时同样带上提交前被拒错误码。将来若确需过滤，必须能区分「deferred 拒绝后补建的图片占位」和「正常预留的视频占位」，不能只靠错误码或 `isLocalPlaceholder`。
- 云端项目的视频占位进入 Y.Doc 并跨设备同步，是现有行为，与「仅本机」语义无关，本次不改。

### 历史残留

从源头停止补建不会删除已经写入 Y.Doc 的历史失败节点。这类节点（`pending.type === 'placeholder'`、错误状态、没有真实任务 ID）与正常失败的云端视频占位在数据上无法可靠区分，也不宜自动清理。

本次选择用户手动删除：

- 不添加打开文档时的自动清理逻辑。
- 不自动删除历史节点。
- 交付说明明确：停止新增补建，不声称已清理存量。

### 验证与验收

- 使用真实 sink 执行云端图片 `reserve()`，再制造 `invalid_params` 拒绝：旧编辑器和 Y.Doc 均未新增占位。
- 云端视频的已有占位遇到拒绝时仍能转为错误状态。
- 对话卡片仍显示“让助手重新处理”按钮。
- 回归：云端项目生成视频时，占位进入 Y.Doc 并显示在节点画布上，交付后替换为视频节点。
- 本机项目的同样拒绝场景，失败占位仍存在并显示错误状态。
- 不为验证向生产制造拒绝任务；用本地受控运行环境验证该路径。

## 排除项

- `CanvasMode.tsx` 的 `onFitContent` 只在旧画布分支，不影响节点项目，本次不改。
- `workspaces.ts` 的 `fitInitialView` 虽然对所有项目执行，但只改旧镜头；NodeCanvas 有自己的初始取景。这是节点项目下的无效调用，不是本次行为故障，留待旧链路清理。
- 不整体删除 `CanvasDoc`、`CanvasEditor` 或 Konva 实现。
- 不增加历史失败节点的自动迁移或清理。

## 提交与交付顺序

1. 基于最新 `origin/main` 创建分支，确认已有 #1349 的焦点桥接。
2. 第 1 条：实现 reveal 与调用点迁移，相关单文件测试和浏览器 smoke 通过后单独 commit。
3. 第 2 条：实现创作记录选择同步，相关单文件测试和浏览器 smoke 通过后单独 commit。
4. 第 3 条：取消云端拒绝占位补建，相关单文件测试和受控场景验证通过后单独 commit。
5. 按本次用户指定，本机只跑相关单文件测试；lint、typecheck、完整测试交云端或 CI。
6. 创建 PR，所有要求的 CI 检查通过后合并 `main`。
7. 由部署 workflow 自动发布，不手动发布；跟进 workflow，并验收线上版本及本次可观察行为后交付。

本次文档落盘不代表上述实现、测试、提交或部署已经完成。
