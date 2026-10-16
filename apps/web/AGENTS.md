# apps/web

前端工作台内部约定。仓库级约定见[根 AGENTS.md](../../AGENTS.md)。

## 按需读取

- **新增或修改界面**：先读 [`DESIGN.md`](./DESIGN.md)，再从其「目录 / 入口」读取组件选型、配方与图标文档。
  视觉、文案、tooltip 与设计门禁规则统一在那里维护；本文件只规定开发流程与工程边界。
- **修改文案、语言切换、主题或相关测试**：先读[语言与主题](./docs/agents/display-settings.md)，
  包括语料注册、响应式翻译、存储格式、首帧初始化与测试约定。
- **修改公共官网或指南渲染**：先读 [`apps/website/AGENTS.md`](../website/AGENTS.md)；本文件末尾说明与工作台的边界。
- 测试执行位置、提交检查与发布流程沿用[根 AGENTS.md](../../AGENTS.md)，不在此维护另一套命令。

## 组件检索与复用

新增或修改 UI 时，按以下顺序完成选型，再开始实现：

1. **检索候选**：先查设计系统的「我要做 X → 用哪个」，再用 `rg --files` / `rg` 按用途与行为
   搜索 `src/components/`、相关 `src/features/`；通用交互同时查 `src/hooks/`、`src/lib/` 与 store。
   例如查确认删除、复制、空态或上传状态，不能只搜拟新增的组件名。阅读候选的实现、props、
   实际调用与相关测试，确认已有能力和限制；外部组件检索不能代替这一步。
2. **优先复用完整能力**：先使用已有业务封装，再评估 props、插槽、组合或兼容扩展；确实不适用
   时再组合 `patterns/` 与 `ui/`。只用了 `Button` 或 `Dialog`，不等于复用了确认流程、复制反馈、
   焦点管理和加载状态。具体入口以设计系统速查表与当前源码为准，不在此复制组件清单。
3. **说明新增理由**：只有复用、组合或兼容扩展仍不能满足需求时才新增通用实现。在变更说明或 PR
   中记录检索过的候选路径、具体能力缺口与不能扩展的原因；无候选时记录检索范围。
   文案、图标、颜色、尺寸或页面不同不构成重复实现的理由。
4. **确定归属**：分层与依赖方向按设计系统的三层约定。feature 组件承载业务数据、权限、事件与内容，
   通用 UI 和交互继续复用；不向公共组件塞入单页业务，也不为少量相似代码预建通用框架。
   新增组件按设计系统 README 的流程补用法和陈列页；扩展现有组件须保持已有调用行为。

完成选型时，应能指出本次复用的入口；新增通用实现还须有可审查的缺口说明。

## UI 验收

1. **复用复核**：检查 diff 中新增的组件、基础组件导入与手写交互，确认没有绕过可用的业务封装；
   新增理由与最终实现一致。涉及公共组件时，检查受影响的现有调用点。
2. **行为回归**：新增交互、修复缺陷或改变状态行为时，新增或更新保护本次行为的回归测试；
   缺陷先用可重复的用例或浏览器步骤复现。按影响范围覆盖成功路径及相关边界，例如异步失败、
   禁用、空态、长文本、键盘操作、焦点恢复、语言切换与可访问名称，不机械扩展到无关场景。
   断言用户可见结果、可访问状态或对外契约，避免内部 state、完整 class 快照或仅断言能渲染。
   纯文档、静态样式等低影响修改不为凑数新增单测；布局与视觉问题在真实浏览器验证。
3. **页面验收**：UI 修改先在开发环境的实际页面操作本次路径，检查桌面与窄屏、浅色与深色；
   验证相关弹层、滚动、遮挡和焦点行为。涉及设计系统组件时同时检查 `/design.html`，
   陈列页不能替代实际页面。窄屏模拟仅证明响应式布局，不能报告为真机验收。
4. **记录证据**：PR 或交付说明列出复用入口、新增理由（如有）、实际运行的检查与结果，
   UI 改动附关键页面截图或复现步骤，并注明未验证范围。lint / typecheck 通过不能替代复用复核
   与浏览器验收；合并后的发布与线上核验继续按根约定执行。

测 Radix 组件时复用 [`helpers/radix.ts`](./src/__tests__/helpers/radix.ts)，处理 pointer capture、
`ResizeObserver` 与 `pointerType: 'mouse'`；现成调用见
[`agentComposerMode.test.tsx`](./src/__tests__/features/agent/components/agentComposerMode.test.tsx)。
通过角色查找 checkbox，portal 内容从 `document` 查找；等待明确状态，不用固定 sleep。

## 样式与共享原语

- `ui/` 中与 `apps/admin` 同名的文件必须逐字节一致；以
  [`parity.test.ts`](./src/__tests__/components/ui/parity.test.ts) 动态发现的共享文件为准。
  优先在调用点或组合层扩展行为；确需改共享原语时同步两端并验证受影响调用。
- `ui/` 原语沿用 `@/` 别名，业务与组合层沿用相对路径。依赖和 lockfile 修改按根约定处理。
- 作用域 CSS 使用低 specificity 的 `:where(.panel) button` 等写法，让 utility 可以覆盖。
  `.panel button` 这类选择器会压过组件自身的高度、间距等 utility，破坏复用组件布局。

## 服务商架构

前端 dispatch 入口在 [`src/lib/api.ts`](./src/lib/api.ts) 的 `callImageApi`。唯一路径是平台渠道：[`queueClient.ts`](./src/lib/channels/queueClient.ts)，浏览器 → BFF queue（`submit / poll / fetch`）。用户不配置 API key 或自定义端点。旧 localStorage 里的 `user-byok` 档案在 `normalizeSettings` 时丢掉，活动配置落到当前渠道列表的第一个。

上游协议与凭据由 BFF 处理，前端不直接构造服务商鉴权 header。

**提交路径一律经 [`src/lib/generationJob.ts`](./src/lib/generationJob.ts)**，不要在调用方自己拼
生命周期。`startGeneration(spec, sink)` / `resumeGeneration(input, handle, report)` 里收着
提交门禁（账号 + 计费）、扇出规则（计费整批一条 / 原生 `n` / 按份拆）、幂等键、受理回填、
overlay 的受理 / 出错 / 结算通知，以及失败按错误码映射成人话（ADR-0006：按码判，不糊上游原文）。
宿主只实现 `GenerationSink`：工作台是任务行（`store.ts`），画布是占位框
（`features/canvas/lib/canvasGenerationSink.ts`）。画布视频走自己的队列协议，
复用 `admitGeneration` 与 `superviseGeneration`（文档化的第三个调用方）。

## 登录与匿名访客

**开着 `accounts:login` 的部署照常挂载工作台**：`/api/auth/me` 答 401 时 `AuthGate`
保持匿名 scope，只有需要账号的动作才弹 [`LoginDialog`](./src/auth/LoginDialog.tsx)。
成功登录仍 reload 当前地址：重启时先 `adoptAnonymousStorage()`，再挂工作台与恢复待发请求。
退出登录也保留当前路径、查询串与 hash，带一次性的 `login=1` 重启；会话解析完成后
匿名用户打开登录框，已登录用户只消费参数不弹框。这样重建模块级账号 store 时不会短暂展示旧账号数据。
官网「开始创作」在官网原页弹出登录框，登录成功后进入工作台首页 `/image`。
工作台内 OAuth 发起时携带相对地址 `return_to`；BFF 校验并绑定到本次 state，
回调直接回原工作台地址；官网发起、未提供或无效的目标落到 `/image`，不经官网首页中转。

- [`loginPrompt.ts`](./src/auth/loginPrompt.ts) 是统一弹框接缝。需要账号的动作在发请求前走
  `requireAccount()`；单次动作默认停下，不落任务行或 toast。生成提交与首屏画布发送例外：
  先用 [`pendingSubmission.ts`](./src/auth/pendingSubmission.ts) 在 IndexedDB 保存本次原始输入
  （包括附图），用 sessionStorage 限定发起的标签页，再叫出登录框。登录成功重启且初始化完成后
  消费一次并发送；关闭弹框丢弃，OAuth 失败返回时继续显示登录框。
- 被动请求（启动拉取、轮询、云端历史）**不准**调 `requireAccount()`：页面自己弹登录框是 bug。
- `authenticatedBffFetch` 的 401 只在 `isSignedIn()` 为真时才算「会话失效」，那条路走
  [`SessionExpiredCard`](./src/auth/SessionExpiredCard.tsx)（非模态，工作台不卸载）。访客的 401 是
  正常权限边界，不发任何全局事件。
- 私有 overlay 的积分门禁对匿名访客没有意义（它只会报「读不到积分」并禁用生成按钮），
  所以 `usePrivateSubmissionGuard` / `getPrivateSubmissionGuard` 在 `accountRequired()` 为真时
  直接返回不拦截，把那一次点击让给登录框。
- `/api/channels` 是公开端点：匿名工作台要靠它渲染模型选择器，返回的清单不含任何凭据面字段。

## 其它要点

- 用户优先看到「模型名」（TaskCard、模型选择器）
- 平台渠道的模型可在选择器里切换；选中的 `selectedModelId` 写在 settings 的 builtin profile 里，随本地持久化保存。渠道清单里已经没有的模型会回到该渠道的第一个模型
- `channelStore` 是全量 channel；`publicChannels` 是它的**图片视图**（滤掉 `media: 'video'` 的模型），图片侧一律走后者，视频侧直接读 store
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN

## 使用指南与 SEO

- 公共官网和指南由 `apps/website` 的 TanStack Start 在构建期预渲染，详情见该目录的 AGENTS.md。
- 指南纯数据保留在 `src/features/guide/content/{zh-CN,en}.ts`，两份结构必须一致。章节与锚点保持兼容；
  新增章节只需修改两份内容，不再创建 HTML 占位文件。渲染与站内链接回归在 `apps/website/src/__tests__/`。
- 截图在 `public/guide-assets/<zh|en>/`，使用 WebP。界面文案修改时也同步指南里的 `[[标签]]`。
- Web 构建先输出工作台，再调用官网构建并合并为 `dist`。`index.html` 是官网，`workbench.html` 是工作台。
  Pages、BFF、nginx 仅为明确的工作台路径回退到后者，缺失页面和资源必须返回 404。
- `PUBLIC_ORIGIN` 与 `SEARCH_INDEXING` 继续由 Pages 发布脚本按版本传入，内部站/测试站禁止收录。
