# 魔因漫创：真实交互结构证据

核验时间：2026-10-01。范围：官方仓库 README、工作流文档、当前 main 对应源码。固定提交 `7e5c5655de94d49885e13c369f0a71212893a0aa`。没有安装运行、没有生成任务，不把源码存在等同线上可用。

## 结论

魔因不是围绕一条对话串组织全部制作，而是各工种面板承接结构化数据。剧本与角色均为三栏编辑器；导演当前默认分镜编辑是逐镜卡片列表。不能把一个通用聊天框、四张镜头网格、五步向导称为复现魔因交互。

## 截图证据边界

README 第 66 行包含一张官方附件图片：

https://github.com/user-attachments/assets/582ee70f-f0dc-433b-9d5c-2ddb8f463450

主 Agent 已通过 ego 真浏览器目视核验：它是「剧本→角色→场景→导演→S级」宣传流程图，**不是 UI 截图，不能证明界面布局**。下述布局为 JSX 结构证据。浏览器留存截图：`/Users/qiqian/.codex/visualizations/2026/10/01/01a0f632-91cf-7790-8eb1-1c8c9ddccda4/moyin-official-evidence.png`。`docs/images/` 只有联系与捐赠二维码，不是界面截图。不能拿自绘页面冒充官方界面。

## 按用户实际动作拆解

| 环节 | 实际控件和空间结构 | 证据 |
|---|---|---|
| 开始剧本 | 左栏有「导入 / 创作」双 tab。导入为完整剧本 textarea，支持集标记、场景头、人物与对白；导入成功提示用户点集名生成分镜。不是先开启一串聊天。 | [script-input.tsx L232-L276](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/script/script-input.tsx#L232-L276) |
| 看与改剧本 | 横向可调整三栏，默认 30% 输入、40% 集/场景/角色/分镜树、30% 选中对象属性。中栏选对象，右栏按对象类型展示编辑入口，并有去角色库、去场景库、进入导演等动作。 | [script/index.tsx L2365-L2500](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/script/index.tsx#L2365-L2500) |
| 改上游结构 | 重新解析已有集时弹「覆盖现有场景结构？」说明会替换场景并清理对应分镜；不是静默全部重跑。 | [script/index.tsx L2507-L2522](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/script/index.tsx#L2507-L2522) |
| 角色工作区 | 左 25% 生成控制台，中 45% 角色库（文件夹/卡片），右 30% 所选角色详情；不是只放三张视角图片。 | [characters/index.tsx L43-L75](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/characters/index.tsx#L43-L75) |
| 三视图入口 | 角色生成的「生成内容」checkbox 中包含三视图、表情设定、比例设定、动作设定；前两个默认开启。视觉风格、参考图片与可编辑视觉提示词在同一控制台，点击「生成设定图」。这是一张设定图的内容配置，不是强制流程阶段。 | [generation-panel.tsx L69-L76](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/characters/generation-panel.tsx#L69-L76)、[L856-L985](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/characters/generation-panel.tsx#L856-L985) |
| 进入导演 | 官方工作流说明右边栏「加载剧本分镜」，再到左边栏微调首帧/尾帧/视频提示词、镜头运动、时长、风格。角色/场景预生成被明确标为可选。 | [WORKFLOW_GUIDE.md](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/docs/WORKFLOW_GUIDE.md) |
| 导演当前默认面板 | `idle` 和 `editing` 都进入 SplitScenes。分镜编辑上方为全局视觉风格、摄影风格、比例、分辨率和单图/合并生成方式，下方为纵向 SceneCard 列表，末尾添加空白分镜。 | [director/index.tsx L304-L334](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/director/index.tsx#L304-L334)、[split-scenes.tsx L3648-L3985](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/director/split-scenes.tsx#L3648-L3985) |
| 合并生图 | 选合并生成后出现第二行：仅首帧/仅尾帧/首+尾、参考图策略、范例锚图开关、执行合并生成；生成中可停止。不是仅一个「批量生成」按钮。 | [split-scenes.tsx L3803-L3880](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/director/split-scenes.tsx#L3803-L3880) |
| 每镜操作 | SceneCard 接收单镜生图/生视频/尾帧生成/图片上传、角色与角色变体、景别/时长/情绪/环境音/音效、首尾场景参考、抽取视频尾帧等 callbacks。细节属于源码入口证据，本次未运行点击验证。 | [split-scenes.tsx L3900-L3933](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/director/split-scenes.tsx#L3900-L3933) |
| 生视频门槛 | 底部按钮显示待生成数/总数；无分镜图时禁用，提示先生成图片；批量只统计已有图且视频 idle/failed 的镜头。 | [split-scenes.tsx L3951-L3985](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/director/split-scenes.tsx#L3951-L3985) |
| 交接 | 成片与导出页展示图/视频就绪数，主操作「选择文件夹导出」「逐个下载素材」。目录写入 images、videos、manifest.json，导演导出另支持尾帧。**不能据此说已实现 ZIP 下载或剪映草稿。** | [export/index.tsx L315-L375](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/export/index.tsx#L315-L375)、[export-service.ts L304-L360](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/lib/script/export-service.ts#L304-L360)、[L505-L578](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/lib/script/export-service.ts#L505-L578) |

## 防止误读源码的两点

1. 存在 `shot-grid-view.tsx`，但本次追到的导演默认分支实际返回 SplitScenes；不能因为有网格组件就声称默认是镜头网格。
2. 导出配置类型里虽然出现 `format: 'folder' | 'zip'`，当前读到的真实按钮和 handler 是文件夹/逐个下载；Share Project 和 Render Logs 卡片也未绑定动作。不可把 UI 文案或类型枚举当成完成的能力。[源码](https://github.com/MemeCalculate/moyin-creator/blob/7e5c5655de94d49885e13c369f0a71212893a0aa/src/components/panels/export/index.tsx#L380-L421)

## 对我们下一版的具体约束（设计推导，不是竞品事实）

- 对话可以作为我们自己的入口，但产物应落成可选中的剧本树、角色资产与镜头记录。借鉴的是对象结构与改动作用域，不是假装竞品也采用同样的聊天布局。
- 三视图是角色设定生成的选项，需同时容纳角色参考、表情/服装变体等；不应把所有用户锁进三视图必经关。
- 分镜至少区分镜头文本、首帧、尾帧、视频；生图和生视频拥有不同准备条件及任务状态。
- 如做 ZIP，应明确是我们在文件夹素材交接之上的实现选择；不宣称魔因提供了 ZIP 或剪映工程。
