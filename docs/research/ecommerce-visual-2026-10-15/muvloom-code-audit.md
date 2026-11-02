# Muvloom 电商视觉现有能力只读审计

审计日期：2026-10-15。当前代码 HEAD：`2bcbd06126e79792c025ad84da1b025d473dda8c`；开始时 `git status --short` 无输出（干净）。只读检查公开代码、技能和测试定义，未运行测试、未生成图片、未验证生产能力开关或视觉质量。本文件为主报告的源码证据附件。

**核心结论：已有基础图片处理、局部编辑、素材/效果模板、AI 批次管理；不能将这些概括成“缺批量、缺导出、缺套图”。真正缺口是可靠抠图与商品保真、确定性文字/Logo 合成、结构化商品事实与成套交付、跨 SKU 的易用前端与品牌约束。** 其中部分需要修整已有路径和质量证明，不需要另建一套底座。

## 状态图例

- **入口+实现**：找到用户界面及实现代码；不代表部署已启用或质量达标。
- **技能+通用执行**：有场景入口/技能文本，调用通用生图/改图；不能视为专用且稳定的业务工作流。
- **底层接口**：实现存在，未找到对应普通用户入口。
- **部分**：可完成子步骤，但缺完整交付或具有关键限制。
- **未找到**：本次检索相关目录未找到，不能推断所有私有部署绝无该能力。
- 全部 AI 产出标注**质量未验证**。本次未检查 private overlay 内容；公开能力开关不能证明线上开启。

## 逐行能力矩阵

| # | 电商任务/能力 | 我方现状 | 边界与缺口 | 证据 |
|---|---|---|---|---|
| 1 | 精细抠图、真实透明 Alpha | 部分，存在入口+实现 | 创作参数透明输出、画布批量抠图走生成纯色背景再本地去背；单张画布快捷抠图走 Agent 指令，未见同样后处理接线。不能承诺原商品像素不变或毛发/玻璃质量 | E1,E2 |
| 2 | 白底主图 | 技能+通用执行；透明图转 JPG 可确定铺白 | `product-main-image` 默认白底、居中、保商品，但商品可能被模型重绘。已透明图导出 JPG 会铺白，不能反推可靠分割 | E3,E7 |
| 3 | 普通缩放、尺寸、倍率导出 | 入口+实现 | 原尺寸/宽/高/百分比、独立宽高、多格式倍率；只是重采样，不是 AI 超分 | E7 |
| 4 | AI 超分、细节修复 | 未找到专用入口/工具 | 通用改图可以被要求提高清晰度，不计专门超分；工具箱 `upscaled` 是尺寸放大提示 | E7,E8 |
| 5 | 图片压缩、目标文件体积 | 入口+实现 | 本地压缩，有 overTarget/keptOriginal 等反馈 | E8 |
| 6 | 格式转换 | 入口+实现 | JPG/PNG/WebP/AVIF；WebP/AVIF 有 wasm 编码补齐，不包含可编辑 PSD | E7,E8 |
| 7 | 裁切、旋转、翻转 | 入口+实现 | 工具箱确定性本地处理；画布单张裁切会把裁切结果送 Agent，需避免把两个路径混为纯本地交付 | E8,E2 |
| 8 | AI 扩图、画幅重构 | 入口+实现 | 画布扩图携真实 mask，模型要支持原生遮罩；换比例是生成式重新构图，会重画商品 | E2,E4 |
| 9 | 局部消除、局部重绘 | 入口+实现 | 用户选区/笔刷、参考区域、模型门禁；Agent 局部改图有服务端选区外像素保护及对齐拒绝机制 | E4 |
| 10 | 局部改稿不伤其他部分 | 部分且较强底座 | `protectMaskedOutput` 把保护区原像素保留，但它不证明选区内的商品/文字正确；未验证全部入口走同一保护链 | E4 |
| 11 | 图片网格拼图 | 入口+实现 | 工具箱 collage，列数/间距/背景；是位图拼接，不是可编辑商业版式 | E8 |
| 12 | 长图拼接、切图 | 入口+实现 | stitch、slice，可作为详情图交付加工步骤，不是详情页策划/字段模板 | E8 |
| 13 | 精确可编辑文字/价格/日期 | 缺完整交付 | 画布 text 元素可改文字/字号/颜色；节点有 Quill 富文本。但都是标注/文字节点，图片导出只导 image 元素，不能把它们等同商品海报文字图层 | E9 |
| 14 | 商品/背景/Logo/文字分层合成 | 未找到完整实现 | 可在画布摆多个独立图片，但导出是各自图片，不是带分层的成品合成；未找到 PSD、固定画板多层导出 | E9 |
| 15 | 场景背景生成/替换 | 技能+通用执行 | scene-swap 明确主体机位保留；底层通用 editImage，不是自动分割+锁主体的专用场景合成 | E5 |
| 16 | 投影、光影、反射处理 | 技能/通用改图 | 产品主图/换款提示有光影约束；未找到独立可控阴影/反射参数入口 | E3,E5 |
| 17 | 商品替换、相同场景换款 | 技能+通用执行 | product-restyle 引用原图+目标图，支持选区；无稳定身份保真保证 | E5 |
| 18 | 商品换色/材质、SKU 变体 | 技能+通用执行 | 有逐项保留要求；尚无结构化 SKU 色号与结果绑定、颜色量化核对 | E5 |
| 19 | 商品角度、多视角参考 | 技能+通用执行；素材多视图已有 | 主图技能支持逐张改变机位；素材带正侧背/来源标签。生成不可见角度可能虚构结构 | E3,E10 |
| 20 | 同款成套主图/卖点/场景/细节图 | 技能+通用执行 | product-image-set 默认6张分工、逐张 editImage，不是只做同 prompt 的 n 个变体。但还没有强制完整性/一致性/真参数验收 | E6 |
| 21 | 完整可编辑详情页 | 部分素材能力 | 套图技能+拼长图可辅助；无字段驱动的详情模块编辑/确定文字层/统一版式交付 | E6,E8,E9 |
| 22 | Amazon A+ 模块化内容 | 未找到专用实现 | 有 Amazon 图片采集和正方形尺寸预设，不能算 A+ 模块/规范/发布 | E8,E15 |
| 23 | 营销海报、活动主视觉 | 技能+通用执行 | poster 技能和起手句已有；文字依赖像素生成，不是确定可编辑文本 | E5,E9 |
| 24 | 商品规格事实、卖点字段库 | 部分素材描述 | AssetRecord 有名字/描述/多视图，没有 SKU、价格、单位、规格等专用字段。套图参数靠正文且提示人工核验 | E6,E10 |
| 25 | 素材库、商品多视图 | 入口+实现 | 产品/人物/地点/道具，命名/描述、背景、视角来源；可用于参考复用 | E10 |
| 26 | 提示词保存、效果模板复用 | 入口+实现 | Prompt 模板与 Look 效果模板分开；Look 固定模型/尺寸/素材位/参考，前端真实组装提交 | E10,E11 |
| 27 | 品牌套件（Logo/字体/颜色/规范） | 未找到专门结构 | 可当普通素材/参考保存，缺结构化强制规范、品牌字体、锁定区域 | E10,E9 |
| 28 | 多商品一键套用同一 Look | 底层接口已有，用户前端缺口 | BFF `/api/looks/batch` 单槽模板逐商品建任务；公开 web 搜不到该路由调用。普通 `submitWithLook` 是一次按素材位组装，不等于批量 SKU 清单 | E11 |
| 29 | AI 批量图片生成/编辑 | 入口+实现，受部署开关控制 | AgentBatchPlanCard+planImageBatch 支持最多100计划项、依赖、报价、暂停/续跑/取消/选择重试、结果导出；不是“只有后端批量” | E12 |
| 30 | AI 批量分析/对比 | 入口+实现，受部署开关控制 | 同批次工具有 inspection/joint_comparison 与 analysis/generation 分阶段；是通用视觉分析，未形成电商保真标准评分 | E12 |
| 31 | 画布选中多图统一操作 | 入口+实现 | 至少选2张可批量抠图、整图编辑、换比例；逐张提交，不等于跨 SKU 套图任务管理 | E1,E12 |
| 32 | 纯本地批量图片处理 | 入口+实现 | 工具箱 EachTool 对各张应用设置，失败逐张显示；转换/压缩/裁切/旋转独立设置 | E8 |
| 33 | CSV/Excel 字段批量排版 | 未找到 | AI 批次里的 prompt/items/dependencies 不等于数据表映射文字与商品图层 | E9,E12 |
| 34 | 打包下载、多格式/多倍率 | 入口+实现 | 工具箱/画布/Agent批次均有导出；多张ZIP且防重名；统一导出多行倍率格式。无需另造“批量下载” | E7,E8,E12 |
| 35 | 平台尺寸与交付规则 | 部分入口+实现 | 工具箱预设淘宝800²、Amazon2000²、小红书1242x1660、抖音1080x1920、公众号封面；只是代码内尺寸预设，未证明当前平台全部规范/白底/占比/禁文检查 | E8 |
| 36 | 图片翻译、跨境本地化 | 技能+通用执行 | image-localize 重绘文字、列原文译文核对；明确价格日期等不要模型重画。未找到 OCR→可编辑文本→确定重排的专用管线 | E13 |
| 37 | 模特换装、平铺上身 | 未找到专用技能/界面 | 可能通过通用编辑尝试；没有服装专用保版型/花纹/尺码工作流，不能计成熟支持 | E5,E16 |
| 38 | 电商商品视频 | 技能+通用执行且有视频底座 | product-main-video 提供首帧→generateVideo；画布时间线和成片导出存在。特定技能仍声明不承诺音频字幕；与通用成片系统能力需区分 | E14 |
| 39 | 项目、云同步、历史 | 入口+实现 | 项目/对话、素材同步、节点结果历史与撤销；受 accounts/sync、node canvas 等开关控制；不等于客户审批或多人协作 | E17 |
| 40 | 团队共享品牌/审批/评论/权限 | 未找到产品实现 | 同账号云同步、Yjs文档不自动等于多人实时协作产品；未核 private overlay，报告标本次未找到 | E17 |
| 41 | 电商商品链接取图 | Agent 专门工具已有 | fetchListingImages 支持 Amazon dp/gp/product，默认4最多8张，验证码会失败；别的平台仅一般网页读取+单图抓取 | E15 |
| 42 | 店铺连接、商品目录同步、直接上架 | 未找到 | 没有 Shopify/WooCommerce/店铺OAuth/目录回写；不要将 Amazon 参考图采集算平台集成 | E15 |
| 43 | 商品保真/文字/规范自动QA | 部分底座 | 选区外像素保护、Agent复核、批量视觉分析与技能验证框架已有；没有按SKU事实+OCR+平台约束的统一上线门禁 | E4,E12,E18 |
| 44 | 电商模板真实效果验证 | 机制已有，完成证据不足 | poster/scene-swap/look 等有 cases.json；本次列到的 verification 文件只有用例，未见 record.json；meta无 verified。不能把用例文件当已跑图验收 | E18 |

## 最重要的代码证据

路径均相对 `/Users/qiqian/Projects/Self/ai-image-playground/`，行号对应上述 HEAD。

- **E1 真实透明输出但路径分歧**：`apps/web/src/components/ParamControls.tsx:396` 透明开关；`apps/web/src/store.ts:167` 处理返回图，181-192 绿幕键除失败保留原图；`apps/web/src/features/canvas/components/CanvasBatchBar.tsx:57` 两张以上显示批量条，93-99 抠图入口，162-165 调 submitCanvasCutout；`apps/web/src/features/canvas/lib/canvasImageEdits.ts:87` 指令换绿幕/品红，105-125 强制PNG并 editKind=cutout；`apps/web/src/features/canvas/lib/canvasGenerationSink.ts:206` 以 editKind 触发本地键除；`apps/web/src/lib/transparentImage.ts:52` 本地算法。旧注释对上游普遍“不产alpha”的断言仅是代码注释，不作为外部模型事实。
- **E2 单张快捷编辑**：`apps/web/src/features/canvas/components/CanvasImageToolbar.tsx:241` cutout仅一句透明背景指令，259送 Agent；`apps/web/src/features/canvas/lib/sendImageEditToAgent.ts:21` 明确快捷操作只组织Agent输入，43检查mask能力、76本地裁切、92扩图mask、130提交Agent。此路径未见 cutout 后处理字段。
- **E3 主图**：`apps/bff/skills/image/product-main-image/SKILL.md:16` 真商品必须用参考改图；35白底、55默认不生成文字、65多角度、90仅候选不等于可上架。
- **E4 局部像素保护**：`apps/bff/src/lib/agent/tools/editImage.ts:13` 参数支持选区/参考/融合；184-192服务端指令及mask、local强制复核；`apps/bff/src/lib/agent/masked-output.ts:18` 保护输出，67对齐检查、81从源像素复制、93 amount=0继续保留；前端 `apps/web/src/features/canvas/components/CanvasImageToolbar.tsx:180`、`apps/web/src/features/canvas/lib/sendImageEditToAgent.ts:58` 真实mask输入。
- **E5 商品视觉技能**：`apps/bff/skills/image/scene-swap/SKILL.md`；`apps/bff/skills/image/product-restyle/SKILL.md:24` 替换、43换色、54选区、67人工验收；`apps/bff/skills/image/poster/SKILL.md`；`apps/bff/skills/image/image-remix/SKILL.md`。注册通用工具见 `apps/bff/src/lib/agent/tools/index.ts:76`，没有专用超分/服装分割/文本图层工具。
- **E6 套图**：`apps/bff/skills/image/product-image-set/SKILL.md:37` 默认6张、43每类型一次editImage、46-59图型分工、67默认不写字、78人工核验。技能是真实可加载场景流程，但执行约束在文本。
- **E7 导出**：`apps/web/src/features/image-export/export.ts:14` 尺寸模式、20独立尺寸、21多行倍率格式、50逐图从原件导出；`apps/web/src/features/toolbox/lib/encode.ts:5` JPG/PNG/WebP/AVIF，48实际字节校验与wasm；`apps/web/src/features/toolbox/lib/render.ts:13` JPEG铺白；这些是确定性重采样，不能写成AI高清修复。
- **E8 工具箱完整入口**：`apps/web/src/App.tsx:142` ToolboxPage；`apps/web/src/features/toolbox/lib/registry.ts:14` 导出/压缩/转换/裁切/旋转/拼图/长图/切图；`apps/web/src/features/toolbox/tools/crop.tsx:9` 平台与比例预设；`apps/web/src/features/toolbox/components/ToolView.tsx:10` 多图统一处理与结果；`apps/web/src/features/toolbox/lib/deliver.ts:25` ZIP；`apps/web/src/features/toolbox/tools/collage.tsx:15` 拼图实现，`apps/web/src/features/toolbox/tools/stitch.tsx` 长图。
- **E9 文字/合成的真实边界**：`apps/web/src/features/canvas/lib/canvasDoc.ts:56` TextEl仅文字/字号/色/位置；`apps/web/src/features/canvas/components/CanvasToolbar.tsx:16` 文字工具；`apps/web/src/features/canvas/components/StylePanel.tsx:73` 可改色/字号；`apps/web/src/features/canvas/lib/rasterizeSelection.ts:36` 文字抽成annotationText、不画进生成输入；`apps/web/src/features/canvas/lib/exportImages.ts:54` 标注不导出，58-67只选image；`apps/web/src/features/image-export/sources.ts:40` 继续用这份过滤；`apps/web/src/features/canvas/components/NodeTextEditor.tsx:85` QuillBinding为文本节点；`apps/web/src/features/canvas/lib/nodeImageEdit.ts:128` 有笔刷直接绘入位图（draw），不是文字/Logo商业排版。
- **E10 素材与模板数据**：`apps/web/src/features/library/types.ts:30` AssetRecord（名字/描述/多视图），68 Prompt模板，88 LookRecord（purpose/body/model/size/slotCount/referenceImageIds）。未见价格/规格/SKU/品牌字体约束字段。
- **E11 Look前端与批量底层**：`apps/web/src/features/library/lib/lookSubmit.ts:111` submitWithLook，134按当前素材位组装、177普通提交；`apps/bff/src/routes/looks.ts:157` /api/looks/batch，188单槽逐商品、多槽整体；在 web src 搜不到 `/api/looks/batch` 或等价专门客户端。不要把这个接口直接算用户已经有批量套模板入口。
- **E12 四种批量必须区分**：`apps/bff/src/lib/agent/tools/planImageBatch.ts:7` 草稿工具、20-34最多100项analysis/generation/依赖；`apps/bff/src/lib/agent/batch-plans.ts:32` 登录+能力开关；`apps/bff/src/lib/agent/batch-execution.ts:44` 执行与quota门禁；`apps/web/src/features/agent/components/AgentToolCard.tsx:1203` 卡片实际渲染；`apps/web/src/features/agent/components/AgentBatchPlanCard.tsx:328` 修改计划、764导出、1083重试、1094确认、1113暂停、1134恢复、1147取消。与画布 `apps/web/src/features/canvas/components/CanvasBatchBar.tsx:73` runEach 和工具箱本地批处理不同。
- **E13 图片翻译**：`apps/bff/skills/image/image-localize/SKILL.md:19` editImage逐张；52价格日期认证不得重画；60列译文人工核对；62承认错字/缺笔/字距风险。
- **E14 视频**：`apps/bff/skills/video/product-main-video/SKILL.md:44` 首帧，58 generateVideo、78-81不承诺文字配音；`apps/web/src/features/canvas/lib/exportFilm.ts:48` 真正成片合成，67原片音轨处理，85单片ZIP；不能把通用剪辑与商品演示稳定质量混为一谈。
- **E15 商品链接**：`apps/bff/src/lib/agent/tools/fetchListingImages.ts:33` 限Amazon、40最多8、59工具注册、75需登录、95反爬失败；这是采集参考图，非店铺同步和上架。
- **E16 未找到项的检索范围**：`apps/web/src`、`packages/shared/src`、`apps/bff/src`、`apps/bff/skills`，检索 upscale/enhance、brand kit/profile、shopify/woocommerce、team/workspace member、SKU/CSV/批量排版/字体上传/PSD 等，并看工具注册及功能目录。未对 private 做完整审计。
- **E17 项目和历史**：`apps/web/src/features/canvas/lib/cloudProjects.ts:41` 同步状态；`apps/web/src/features/canvas/lib/nodeCanvasHistory.ts:37` 本地与durable命令统一撤销历史；`apps/web/src/features/canvas/lib/nodeCanvasGate.ts:2` 节点画布由能力开关控制；`apps/web/src/features/canvas/components/CanvasMode.tsx:39` 与 `64` 条件加载NodeCanvas。因此旧画布与节点入口必须按部署核验，源码并存不代表同一用户都可见。
- **E18 验证机制**：`apps/bff/src/lib/skill-verification/record.ts:7` 记录约定、141判据、172主体保真最低分；本次 `rg --files apps/bff/skills | rg 'verification/.+json$'` 只返回7个 cases.json（poster、scene-swap、reverse-prompt、4个look）；poster/scene-swap meta.json无verified。不存在记录不代表从未线下验收，但不足以声称已验证。

## 已有测试定义，未执行

- `apps/web/src/__tests__/lib/transparentImage.test.ts`：纯色背景键除算法测试。
- `apps/web/src/__tests__/features/canvas/components/canvasBatchBar.test.tsx`：批量条接线（含mock，不证明产图质量）。
- `apps/web/src/__tests__/features/image-export/export.test.ts`、`ExportForm.test.tsx`、`sources.test.ts`：导出尺寸/界面/来源。
- `apps/web/src/__tests__/features/toolbox/lib/geometry.test.ts`、`canvasLimits.test.ts`、`tools/compress.test.ts`：本地几何/容量/压缩。
- `apps/bff/src/__tests__/lib/agent/masked-output.test.ts`、`workers/task-runner-masked-edit.test.ts:171`：受保护区域像素与恢复候选，不能替代真实商品视觉验收。
- `apps/bff/src/__tests__/routes/looks-batch.test.ts`：批量Look接口，不能证明前端入口。
- `apps/bff/src/__tests__/routes/agent-batch-execution.test.ts`、`agent-batch-100.test.ts`、`agent-batch-retry.test.ts`、`agent-batch-comparison.test.ts`：AI批量执行/恢复/分析等。
- `apps/bff/src/__tests__/lib/skill-verification/record.test.ts`：验证规则测试，不等于技能效果通过。

## 补齐建议（供竞品矩阵合并，不代替用户需求验证）

### P0：把已有基础能力变成可信、可交付

1. **统一抠图/透明结果语义并验证商品不变**：至少创作参数、单张快捷、批量三条路径做到同一结果契约；透明像素、边缘、Logo、颜色的测试样例及失败反馈。优先研究专用分割/alpha修边与保主体合成，而非继续加长提示词。验收：真Alpha下载、白底正确、主体关键细节保留，失败不冒充成功。
2. **最小确定性文字/Logo/背景/商品合成与扁平导出**：准确改价格/规格/日期，字号/对齐/换行/字体可控，商品图层可保留。已有文字标注与拼图不能覆盖这一交付能力；无需第一步做完整PSD编辑器。
3. **统一电商交付检查与现有工具可发现性**：使用现有裁切/平台尺寸/导出/压缩/ZIP，补入口衔接与真实效果验收，而非重做这些功能。检查平台尺寸只是一部分，需分清规范维护和自动检测。

### P1：形成完整电商工作流，重点借鉴

4. **结构化商品事实 + 套图清单**：事实字段、每图用途、已确认/待修状态、风格参考、完整性检查；让现有 product-image-set 与AI batch服务于这份结构，避免套图只是一轮文字指令。
5. **多SKU套模板前端**：复用已有Look组装与正式支持的批次执行路径；先核对旧/api/looks/batch接口的生命周期，给逐商品映射/预览/报价/失败续做/导出命名。先统一产品路径，不盲目再建第三套批量系统。
6. **品牌约束与可复用详情模块**：Logo/色/字体及锁定区域、小量常用卖点/规格/对比模块；建立在P0确定排版上。
7. **专用超分/修复入口**：如果实际用户高频遇到低分辨率素材，明确选择保真放大而不是重画；与普通倍率导出隔离。

### P2：取决于真实客群

8. 图片本地化做到 OCR/文字块审阅/确定排版，跨境用户有持续需求时提前。
9. 服饰试穿/模特、自动商品目录/平台发布、团队审批、视频广告可列专项，暂不因为竞品有就全做。

### 验证优先于新增的部分

场景图、换款、换色、套图、海报、局部编辑、视频已有技能和通用路径；先做同一SKU及难例实测，量化首轮采用率、整套采用率、文字/颜色/Logo错误、修一次影响范围、操作时间、总成本，再决定补专用能力。当前没有证据足以断言产品保真、跨图一致性或“超分”达标。

## 对2026-10-01旧报告的纠偏

- 旧报告把 `/api/looks/batch` 作为多素材批量用户能力，应改为“接口有、直接用户入口未找到”；与此同时不能遗漏新AI批次卡、画布批量操作与工具箱本地批处理。
- “精确排版不足”结论仍成立，但不能说完全没有文字编辑/拼图：有文字标注、节点富文本、直接笔刷绘图、确定性拼图/长图，只是它们没有组成可编辑商业物料交付。
- 平台尺寸、JPG/PNG/WebP/AVIF、倍率、压缩、ZIP已有，不要当待从零补功能。
- 抠图真alpha既不能全打勾也不能全打叉：算法与部分入口都已存在，当前单图Agent路径与批量/参数路径分离，需要运行态核验与一致化。
- QA不是完全没有：有保护区像素合成、对齐校验、局部编辑复核、批量分析与效果验证框架；缺的是电商商品事实与可重复质量标准。
