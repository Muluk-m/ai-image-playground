# 主流 AI 视频产品形态拆解：布局、交互、流程

调研日期 **2026-09-17**。全部为当天现场抓取。

**目的**：给「用 Agent 模式替换现有导演台」这件事提供可直接开工的原型输入。所以这份报告只谈**产品形态、功能、交互、布局**，不谈模型质量、价格表、API 参数。API 层的结论已经在 `docs/research/agent-native-video-mode.md`（仓库内，origin/main）里写完了，本文不重复，只在需要时引用。

**证据分级**（每条事实都标注）：

- 🟢 **实测** — 我在真实浏览器里看到并截图
- 🔵 **官方文档** — 厂商自己的帮助中心 / 更新公告 / 使用指南原文
- 🟡 **官方素材** — 厂商自己发布的产品截图（登录墙后功能的唯一可信来源）
- ⚪ **未能核实** — 登录墙后、官方未说明；一律写明，不推断

**未登录**：即梦、可灵、Runway、海螺、Lovart 全程未登录（按约束）。**Flow 例外**：owner 的 Chromium 本来就是登录态，因此 Flow 一节大量为实测；期间只浏览，未提交任何生成、未订阅、未勾选任何营销选项。

---

## 一、一页结论

**1. 四家全部走同一个骨架：一个大输入框 + 一个"东西落在哪里"的工作面 + 一份可回看的资产库。** 表单没了，但不是被聊天取代，而是被 **「对话（窄）+ 工作面（宽）」** 取代。工作面是无限画布（即梦、可灵、海螺、Lovart）、资产网格（Flow）或多标签工作台（Runway：节点图 / 网格 / 时间线）。没有一家把结果只留在聊天流里。

**2. 参数没有消失，而是降级成"偏好"，默认全部是「自动」。** 即梦「生成偏好」popover 顶上一个 `自动` 开关（默认开）；可灵「选择模型」popover 顶上一个 `自动` 开关 + 模型**多选允许集**；Runway 一颗 `Auto • Quality` 药丸；Flow「智能体设置」；海螺 `自动` / `自动比例`。**统一形状：一个不显眼的小控件，打开是「比例 / 数量 / 模型」三件，其余交给 Agent。四家都没有在 Agent 模式下暴露「镜数」和「总时长」。** 我们现在的「镜数 2–5 / 总时长 10-15s 下拉」在 2026 年的同类产品里已经找不到对应物了。

**3. 「生成前先问我」是一个一等设置项，不是一个提示。** Runway：`When generating media [Ask | Auto]`，Ask 模式下 Agent 会把**模型、prompt、预估积分**摆出来等你点头（🔵）。Flow：`生成前先确认 [始终 | 永不]`，**默认「始终」**（🟢）。**两家默认值相反**（Runway 默认 Auto，Flow 默认 Ask）——这是我们要自己拍的一个板。

**4. 角色一致性四家全有，且形状高度一致：一个具名实体 + 多张多角度参考图（+ 音色），在 prompt 里用 `@名字` 指代。** 可灵 Element Library：1 主图 + 1–3 补充图，可绑音色，可从视频创建，视频生成最多引 7 个角色（🔵）；Flow 角色：1–2 张图 + 名字 + 音色 + 简介，`@角色名` / `@me` / `@Voice: Andrew`（🔵）；Runway References：上传自动编号 `Image 1`，**命名后即成为可跨会话复用的 saved reference**，`@` 插入 `@[Image 1]`（🔵）；即梦「主体」是一级导航（🟢，内容登录墙后）。**这是我们缺得最狠的一块**——宿主今天没有「角色/主体」这个概念。

**5. 分镜的表示法出现了真正的分歧，这是产品裁决而不是抄袭题。** 三种并存：(a) **写在 prompt 里的镜头清单**（可灵 `镜头1，3s，…@主体…` 一次生成多镜，配 `Multi-Shot` 开关 + `自定义分镜` 面板，🔵）；(b) **画布上的一组节点**（即梦作品实例：参考图节点 → 连线 → `part 02-9` 视频节点，每条 15s，🟢；可灵灵动画布输出一整排分镜图，🟡）；(c) **时间线上的一串 clip**（Runway Final Cut 拼出 3 分 07 秒成片，🟡；Flow Scenebuilder，🔵）。**Runway 是唯一三种都做的：Workflows 节点图 / Generations 网格 / Final Cut 时间线，三个 tab 并列在同一个会话里。**

**6. 技能 `/` 已经是行业标配，而且是可发布、可分享的一等对象。** 即梦有**技能市场**（作者署名、赞数、使用次数、「添加」按钮、11 个分类，🟢）；Runway 有 9 个内置技能 + `Create Skill` 弹窗（Name / Description / Instructions ≤5000 字符 / Private 或 Share with workspace，🟡）；Lovart 有 7 个 `/` 技能（🟢）。**技能描述的写法和 Agent Skills 的 `SKILL.md` 一模一样**（「当用户……时调用；不处理……」）——这正是 ADR 0003 结尾预留的那条路，外部已经验证它跑得通，而且跑成了一个内容生态。

**额外一条给 owner 的提醒**：Runway 的 **Characters 不是**角色一致性功能，它是实时对话数字人（🟢，runway.com/product/characters）。简报里「Runway Characters」这条假设需要更正：Runway 的角色一致性靠 **saved References**。

---

## 二、逐家拆解

---

## 2.1 即梦 Jimeng（字节）

来源：`https://jimeng.jianying.com/ai-tool/home`、`/ai-tool/explore`、作品只读画布 `/ai-tool/work-detail/7682233986071973144`，均 2026-09-17 实测（未登录）。

### (1) 产品形态

**Agent 对话与无限画布双主面，由首页一个分段控件切换。** 首页中央是 `[生成 | 画布]` 两个 tab：`生成` 进入 Agent 对话流，`画布` 进入画布项目（新建 / 从「视频创作」「图像创作」两个模板起步）。左侧全局导航里，`对话` 与 `画布` 是两条**并列的历史列表**——即梦把「一次对话」和「一块画布」当成两种平级的作品容器。🟢 `jimeng-home.png` / `jimeng-canvas-toggle.png`

Agent 不是一个可选开关，而是**默认的创作类型**：输入框左下的 `Agent 模式 ⌄` 展开是一个叫「创作类型」的菜单，`Agent 模式` 打勾在最上，下面才是 `图片生成 / 视频生成 / 音乐生成 / 音频生成 / 数字人 / 动作模仿` 这些传统表单入口。🟢 `jimeng-agent-mode-dropdown.png`

### (2) 信息架构与布局

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [促销倒计时条 ────────────────────────────────────────────────────── ×]  │
├──────────┬───────────────────────────────────────────────────────────────┤
│ 即梦AI ⊡ │                                              ○  [ 登录 ]      │
│          │                                                               │
│ ◆ 创作   │                 你好，今天想要创作什么?                        │
│ ◎ 探索   │                                                               │
│ ▤ 资产   │              ┌────────────┬────────────┐                      │
│ ▣ 主体   │              │   生成 ●   │    画布    │   ← 主面切换         │
│          │              └────────────┴────────────┘                      │
│ 对话     │  ┌─────────────────────────────────────────────────────────┐  │
│  请先登录│  │ ┌────┐  输入想法、剧本或上传参考，支持 / 使用技能，      │  │
│          │  │ │ +  │  添加主体，和 Agent 一起创作                     │  │
│ 画布     │  │ └────┘                          (tiptap 富文本，@/ chip)│  │
│  请先登录│  │                                                          │  │
│          │  │ [⚡Agent 模式 ⌄] [⚙自动] [✨技能]         [🎤]   [ ↑ ]  │  │
│          │  └─────────────────────────────────────────────────────────┘  │
│          │   (/电影级长镜头运镜ᴺ)(/创作分镜ᴺ)(/名导风格大师ᴺ)            │
│          │   (/叙事短片导演分镜ᴴᵒᵗ)  (更多技能 >)                        │
│          │                                                               │
│          │   最近上新  [████ 精选作品 ][████ 插件 ][████ Seedance 2.5 ]  │
│          │   ┌─精选─┬广告营销┬影视作品┬平面设计┬电商┬动画动漫─────────┐  │
│          │   │ 作品瀑布流：封面 / 时长 00:50 / 标题 / 作者 /           │  │
│          │   │ 「查看创作过程」                                        │  │
│          │   └─────────────────────────────────────────────────────────┘  │
└──────────┴───────────────────────────────────────────────────────────────┘
```
🟢 `jimeng-home.png`

**只读画布（作品的「查看创作过程」）**，这是我们能直接看到的即梦专业工作流实况：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 香水–Elle fait naître le soleil     当前为只读模式，如需创作请点击 [复制项目] × │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   ▣ 场景资产2 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ (命名 frame，可框选一组)     │
│   ┌────────────────────────────────────┐                                 │
│   │  ▣ 图片 5                          │      ▶ part 02-9                │
│   │  ┌────────────────┐ ┌────┐         │      ┌──────────────────┐       │
│   │  │ [AI生成]  12 ⌄ │ │    │  ─────╲ │      │ [AI生成]         │       │
│   │  │   (缩略图)     │ │    │        ╲│─────▶│   ▶ 00:14/00:15  │       │
│   │  └────────────────┘ └────┘        ╱│      └──────────────────┘       │
│   │  ygtheatermanoBa..._a0ad8765ed.png │      ▶ part 02-10 …02-14        │
│   └────────────────────────────────────┘                                 │
│                          ↑ 上传/生成的参考图    ↑ 连线    ↑ 逐镜视频节点  │
│                                                                          │
│ ┌──────────────────┐                                                     │
│ │   (缩略地图)     │                                                     │
│ └──────────────────┘                                                     │
│ [▷][▥ 缩略图][⤴ 分享]  [ 8% ]   ← 缩放菜单：放大/缩小/适配画布⇧1/       │
└──────────────────────────────────────  缩放至选中项⇧2/50%/100%⌘1/200% ──┘
```
🟢 `jimeng-canvas-fit.png` / `jimeng-canvas-zoomin.png` / `jimeng-canvas-node-detail.png` / `jimeng-canvas-tool2.png`

值得注意的三件事：

- 这块画布在 8% 缩放下才装得下，**几百个节点**。真实专业项目就是这个规模。
- 节点分两类：**图片节点**（标题是文件名，带 `AI生成` 徽标和一个**变体计数下拉 `12 ⌄`**——一个节点承载 12 个候选）与**视频节点**（标题是用户自己起的 `part 02-9`…`02-14`，内联播放器，`00:15`）。
- **有连线**。参考图节点 → 视频节点是显式的边。即梦画布不是纯自由摆放，它记录了「谁生成自谁」。

### (3) 创作入口与输入区

输入框底层是 **tiptap / ProseMirror**（🟢，DOM 实测），所以它能装内联 chip。三个触发：

| 触发 | 作用 | 证据 |
| --- | --- | --- |
| `/` | 技能 | 🟢 placeholder 原文 + 技能 chips |
| `@` | 添加主体 | 🟢 画布 tab 下 placeholder 显式写 `@ 添加主体` |
| `+` | 上传参考（图 / 剧本） | 🟢 输入框左侧大按钮 |

右下角还有 **🎤 语音输入**。🟢

**参数暴露面（关键）**：`自动` 按钮展开的 popover 叫「生成偏好」：

```
┌─────────────────────────────────────────┐
│ 生成偏好                     自动 [●━]  │  ← 总开关，默认开
├─────────────────────────────────────────┤
│ ┌───────────────┬───────────────┐       │
│ │     图片      │     视频      │       │
│ └───────────────┴───────────────┘       │
│ 选择比例                                 │
│ [智能][21:9][16:9][4:3][1:1][3:4][9:16] │  ← 图片多两档 2:3/3:2
│ 其他设置                                 │
│ [ 即梦 Seedance 1.5 Pro          ⌄ ]    │
└─────────────────────────────────────────┘
```
🟢 `jimeng-auto-dropdown.png` / `jimeng-genpref-video.png`

**只有比例和模型。没有时长、没有镜数、没有分辨率、没有出图张数。** 比例的第一档叫「智能」并且是默认选中。

### (4) Agent 交互流程

Agent 会话本身在登录墙后（⚪ 未能直接观察）。但即梦的技能市场描述是官方发布的一手文本，它把流程写得很具体（🟢，`jimeng-skills-gallery.png` 与列表原文）：

- 官方技能「短视频爆款带货」：「上传商品图或描述需求，即可提炼卖点、编写自然口播、设计逐镜分镜并生成视频……**生成前统一预览分镜和完整方案，确认后出片**」
- 社区技能「剧本资产视频一条龙创作」（477 赞 / 7889 次）：「标准剧本转换、视觉资产提取、设定图生成、分镜运镜设计、资产匹配到最终视频成片，**支持每个环节用户确认调整**」
- 社区技能「一图成片-电影广告全能导演」（669 赞 / 1.2 万次）：「视觉基因解构 → 视频类别选择 → 视频结构规划 → 对话/旁白/字幕配置 → 视觉扩展边界 → 短片方案 → **高密度分镜表** → multi_modal2video 全能参考分段生成 → **video_editor 最终拼接**」
- 社区技能「叙事短片导演分镜」（1106 赞 / 1.9 万次，首页 Hot）：「导演意图书、**九列分镜表**、**4~15s Clip 表**与逐 Clip 提示词，直至成片」

**可以安全地读出来的流程共识：一句话 → 方案/分镜表 → 用户确认 → 逐镜出图 → 逐镜出片 → 拼接成片，且「确认」是分镜表这一步。**

成本确认：⚪ 未找到官方说明（未登录看不到）。

### (5) 分镜 / 多镜头

- **在画布上**：一个视频节点 = 一镜，用户自己命名 `part 02-9`，每条 15s，用连线挂回它的参考图。🟢
- **在技能里**：分镜是一张**表**（九列 / 高密度分镜表 / 4–15s Clip 表）。🟢
- 首页作品时长从 00:32 到 **19:37**（《机魂觉醒》粤语机甲动画），说明这套东西真的被用来做长片。🟢

### (6) 角色 / 主体一致性

`主体` 是左侧**一级导航**（与 创作 / 探索 / 资产 同级），且输入框 `@` 的语义就是「添加主体」。🟢
主体的创建与管理界面 ⚪ 登录墙后，未能直接观察。

### (7) 成片与时间线

即梦自己的 UI 里 ⚪ 没看到时间线。但技能描述里出现了工具名 `video_editor`「最终拼接」（🟢 技能原文），说明拼接是一个 **Agent 工具**，不是一个用户界面。这是一条很重要的设计暗示：**成片可以不给时间线，只给一个"拼起来"的工具调用。**

### (8) 进度、结果与历史

- 左侧 `对话` 与 `画布` 两条历史列表并列。🟢
- 生成物落画布节点，带 `AI生成` 徽标 + 变体计数下拉。🟢
- 作品可发布到探索流，并带 **「查看创作过程」→ 只读画布 + 「复制项目」**。🟢 这是一个很强的增长设计：**别人的完整工程可以一键 fork 成你自己的起点。**

### (9) 技能 / 模板 / 预设

**这是即梦最值得抄的一块。** 🟢 `jimeng-skills-gallery.png`

- 入口：输入框下 4 个热门 chip（带 `New` / `Hot` 角标）+ `更多技能 >` → 跳 `探索 > 技能` 页
- 技能页有 11 个分类：热门推荐 / 影视短片 / 电商 / 商业广告 / 通用创作 / 平面设计 / 社媒营销 / 娱乐 / 动漫游戏 / 大师风格复刻 / 专业运镜
- 卡片 = 封面图 + 技能名 + **`添加` 按钮** + `@作者 · N 赞 · N 次使用` + 完整描述
- 作者既有 `@即梦AI` 官方，也有 `@森海荧光` `@渊静-中意` `@娜乌斯嘉` `@慕影-中意` 等创作者
- 描述格式与 Agent Skills 的 `SKILL.md` frontmatter 完全同构，例：
  > 「以森海荧光导演分镜方法论产出叙事短片……**当用户要做剧情/影视向 AI 短片，需要按森海风格做分镜、镜头设计与运镜提示词时调用；不处理电商带货、产品展示、纯图片风格化及单镜头快速生图。**」

另有：画布 tab 下的两个**画布模板**（视频创作 / 图像创作）。🟢

### 附：即梦官方在登录弹窗里放的两张产品图（🟡，`jimeng-login-carousel-3.png` / `-4.png`）

- **Seedance 2.5 智能视频编辑**：一条工具栏 `[矩形][套索笔刷][箭头][文字 T][橡皮][定位][撤销][重做]` + 输入 `🎞 00:10 视频帧标注` + 发送。图里在视频画面上**套索圈出了一个人物轮廓**。文案：「从画面调整到内容重塑，用自然指令精准编辑视频」
- **Seedream 5.0 Pro**：在图片上**手写批注 + 箭头**（「眨眼!」「来点微笑」「蓝灰色发型」「金属搭扣」），一次提交多处修改

**含义：在某一帧上画一笔 + 说一句话 = 一次编辑，这是即梦给"改一镜"的答案。** 我们宿主已经有遮罩 interject（`turn.ts:458-498`），距离这个形态只差一个「按时间戳取帧」。

### 即梦：登录墙后未能观察
⚪ Agent 会话界面本身（消息卡长什么样、计划怎么展示、澄清怎么问、进度怎么显示）；主体的创建与管理；可编辑画布的工具箱与右键菜单；资产库；技能详情页；成本确认。


---

## 2.2 可灵 Kling（快手）

来源：`https://klingai.com/app/`、`/canvas/home`、`/app/omni/new`（登录墙）、官方更新公告 `/release-note/release-history` 与三篇官方使用指南 `/quickstart/*`，均 2026-09-17。

### (1) 产品形态

**可灵是"多个独立工具 + 一个 Agent 画布"的并列结构，而不是一个统一入口。** 左侧 rail 六项：`创意圈 / 资产 / Omni / 生成 / 灵动画布[Agent] / 全部工具`，首页正文还有一排工具卡：`Omni 多模态创作工具`、`图片生成`、`视频生成`、`动作控制`、`灵动画布[Agent]`、`数字人 2.0`。🟢 `kling-app-home.png`

三种形态同时在线：

- **表单**：图片生成 / 视频生成 / 动作控制（⚪ 登录墙后）
- **多模态编辑器**：Omni（⚪ 硬登录墙）
- **Agent 画布**：灵动画布（🟢 首页可见，项目内部登录墙后）

首页 banner 还有第四条路：**「让 Agent 调度可灵，灵感批量出片 — 可灵 MCP & CLI 正式上线」**。🟢 也就是说可灵把自己同时做成了别人 Agent 的工具。

### (2) 信息架构与布局

**app 首页**：

```
┌──┬───────────────────────────────────────────────────────────────────────┐
│◎ │ [ 横幅轮播：让Agent调度可灵… / 可灵MCP & CLI 正式上线 ]              │
│创│                                                                       │
│意│ ┌──────────────┬──────┬──────┬──────┬───────────┬──────────┐          │
│圈│ │Omni 多模态   │图片  │视频  │动作  │灵动画布   │数字人2.0 │          │
│▤ │ │创作工具      │生成→ │生成→ │控制→ │  [Agent]→ │  [推荐]→ │          │
│资│ │  [立即体验]  │      │      │      │           │          │          │
│产│ └──────────────┴──────┴──────┴──────┴───────────┴──────────┘          │
│◉ │                                                                       │
│Om│ ┌推荐┬关注┬活动┐  [ 🔍 搜索 ]                      [ 发布作品 ]      │
│ni│ 发现 短片 4K 3.0模型 动作控制 首尾帧 赛博科幻 壁纸海报 动漫动画 …    │
│▣ │ ┌─────────┬─────────┬─────────┬─────────┬─────────┐                  │
│生│ │  作品瀑布流（封面 / 作者 / ♥数）                 │                  │
│成│ └─────────┴─────────┴─────────┴─────────┴─────────┘                  │
│▦ │                                                                       │
│灵│                                                                       │
│动│                                                                       │
│画│                                                                       │
│布│                                                                       │
│▥ │                                                                       │
│全│                                                                       │
│部│                                                                       │
│工│                                                                       │
│具│                                                                       │
│──│                                                                       │
│MCP                                                                       │
│API                                                                       │
│[登录]                                                                    │
└──┴───────────────────────────────────────────────────────────────────────┘
```
🟢 `kling-app-home.png`

**灵动画布首页**（浅色主题，与 app 的深色形成刻意反差）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⊘                                                    [ 登录领取灵感值 ]  │
│                                                                          │
│                      欢迎进入灵动画布                                     │
│        ┌────────────────────────────────────────────────────┐            │
│        │ ⚠ 灵动画布即将焕新升级！您的项目将迁移至新版本中  × │            │
│        └────────────────────────────────────────────────────┘            │
│        ┌────────────────────────────────────────────────────┐            │
│  ┌──┐  │ 输入你的创意，例如：生成一个 1 分钟的赛博朋克      │            │
│  │▣ │  │ 风格故事分镜...                                    │            │
│  │▤ │  │                                                    │            │
│  └──┘  │ [ + ]  [ ⬡ 模型 ]                          [ 🌿 ] │            │
│  左侧   └────────────────────────────────────────────────────┘            │
│  迷你    (▣故事分镜⌄)(▣多视角分镜⌄)(▣电商素材⌄)(▣营销视频⌄)(▣海报设计⌄) │
│  rail                                                                    │
│        我的项目                                                          │
│        ┌────────────┐                                                    │
│        │  ▤▤▤ 预览  │                                                    │
│        │ [ 立即创建 ]│                                                    │
│        └────────────┘                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```
🟢 `kling-canvas-home.png`

### (3) 创作入口与输入区

**模板 chip 是下拉，不是按钮。** 点 `故事分镜` 展开三个**具名样例**（《竹海听涛》《重生之御厨的小饭馆》《猫的黑帮交易》）+ `更多故事分镜`。🟢 `kling-canvas-template-story.png`

点一个样例，输入框被填入一份完整 brief，参考图以 chip `图 1` `图 2` **内嵌在文本开头**。🟢 `kling-canvas-sample-filled.png`。原文结构（完整实测文本）：

```
[图1][图2] 参考以下内容，生成一组可视化分镜
风格: 经典武侠电影质感，参考《卧虎藏龙》和黑泽明的电影美学。
角色:
  一位白发剑客，蒙着眼（盲人），衣着朴素，武器是一根竹杖。
  一位年轻气盛的挑战者，锦衣华服，手持一把削铁如泥的宝剑。
故事:
  开场 (分镜1-3): 大远景，清晨的竹海，雾气缭绕。…
  对峙 (分镜4-6): 盲眼剑客背对着他，仿佛在聆听风声。…
  交手 (分镜7-12): …镜头要快速切换…大量使用过肩镜头和跟拍镜头。
  终局 (分镜13-15): …只留下一句"你的剑，太吵了"。
```

**这就是可灵给用户示范的「分镜 brief」写法：风格 / 角色 / 故事三段，故事按幕分，每幕标注它占哪几个分镜号。** 15 个分镜、四幕、两个角色——全部用自然语言，没有任何表单字段。这是一个可以直接抄进我们「示例 prompt」的模板。

**模型 popover**（`⬡` 按钮）：

```
┌────────────────────────────────┐
│ ⊙ 选择模型        自动 [●━]    │  ← 自动开关，默认开
├────────────────────────────────┤
│ ┌───────────┬───────────┐      │
│ │   图片    │   视频    │      │
│ └───────────┴───────────┘      │
│  视频 3.0 Omni            ✅   │  ← 多选！不是单选
│  视频 3.0                 ✅   │
│  视频 3.0 Turbo           ✅   │
│  视频 O1                  ✅   │
│  视频 2.6         [VIP]   ○    │  ← 权益不足，灰掉
│  视频 2.5 Turbo           ✅   │
└────────────────────────────────┘
```
🟢 `kling-canvas-composer-hex.png` / `kling-canvas-model-video.png`

**这是四家里唯一把模型做成「允许集合」的**：用户不是选一个模型，而是**划定 Agent 可以在其中挑的范围**，并且权益（VIP）直接编码在这个列表里。比 Runway 的 Speed/Cost/Quality 更具体，比 Flow 的单选下拉更放权。

### (4) Agent 交互流程

官方更新公告 2026-01-29《灵动画布-Agent 模式重磅上线！一键分镜，轻松出片》(🔵) 把流程分了三个场景加两个通用能力：

**场景 1 — 故事分镜**（原文：「您上传简单的故事梗概/复杂的剧本/详尽的分镜头描述，Agent 都可以将其扩展为完整故事分镜描述脚本」）分三步，每步有官方配图：

```
输入（一句话 + 角色参考图）
  ↓
[步骤 1] 生成主体和场景   → 角色白底立绘一排 + 道具 + 空场景板一排
  ↓
[步骤 2] 生成分镜图       → 4~5 列 × N 行的分镜图网格（实例 16 镜 / 20 镜）
  ↓
[步骤 3] 分镜视频
```
🟡 `kling-official-subject-scene-assets.png` / `kling-official-cast-and-sets.png` / `kling-official-character-turnarounds.png` / `kling-official-storyboard-grid-16shots.png` / `kling-official-storyboard-grid-20shots.png`

**这是全部四家里最清晰的一条"一致性工程"流程：先造班底（角色三视图 turnaround + 空场景板），再让每一镜引用班底。** 官方配图里角色是**标准三视图**（正 / 侧 / 背），场景是**无人空板**。

**场景 2 — 多视角分镜**：输入「请基于这个镜头扩展一批多角度分镜」+ 一张图 → 输出同一场戏的 9 个景别/机位。🔵🟡 `kling-official-multiview-9angles.png`

**场景 3 — 电商组图**：一张商品图 → 「主图 + 模特图 + 场景图」。🔵

**通用 1 — 多轮对话智能编辑**：官方原文「Agent 会根据输入输出的上下文为您的新请求给出准确的输出」，公告里列的序列是 `文生图 → 图像编辑 → 图像编辑 → 批量图生图`，并标注「Agent 结合上下文识别意图」「Agent 分步输出」。🔵

**通用 2 — 批量生成**：官方原文「Agent 可以处理您一次性输入的多个提示词，**并行同步生成所有结果并展示在画布上**，您还可以**批量框选**您需要的素材进行**批量下载**」。示例输入是「生成一组图片，比例都是1:1」后面跟 1.–5. 五段编号 prompt。🔵

> ⚠️ 这条与我们的现状直接冲突：宿主是 `toolExecution: 'sequential'` + 一会话一轮（`turn.ts:258-259`、`runningTurns.ts:23-26`）。可灵把**并行**当卖点写进公告。

公告结尾的小标题是 **「输出（对话+画布）」**——明确了结果同时出现在对话与画布两处。🔵

**成本确认**：⚪ 未找到官方说明。

### (5) 分镜 / 多镜头

可灵有**两套并存**的分镜机制，必须分开看：

**(a) 模型级「智能分镜」——一次生成里就有多镜。** 官方 VIDEO 3.0 使用指南（🔵 `klingai.com/quickstart/klingai-video-3-model-user-guide`）：

> 「multi-shot video generation can be triggered through two modes: **"Multi-Shot"** and **"Custom Multi-Shot"**. When "Multi-Shot" is enabled, the model automatically plans the shot transitions, and **this switch is a prerequisite for enabling "Custom Multi-Shot"**. When "Multi-Shot" is disabled, the model will default to generating a single-shot video.」
>
> 「If you wish to set specific details for each shot, click "Custom Multi-Shot" to flexibly **configure the number of shots and their durations**.」

也就是说输入区有一个 `Multi-Shot` 开关，打开后旁边才亮起 `Custom Multi-Shot`，点开是一个可配置镜数与逐镜时长的面板（官方称「视频 3.0 自定义分镜面板」🔵）。

prompt 写法（官方示例原文，🔵）：

```
镜头 1，3s，脱口秀开放麦舞台中近景 @参考图，背面是大大的复古霓虹灯大字"KLING"，
       暖金侧逆光勾边，中景，镜头跟随演员，走到麦克风前，手指轻扶麦架，略微调整高度
镜头 2，4s，半身中景特写 @小小书童，开口说"我居然输给了 Kid，他上过几天班呀…"
镜头 3，4s，@小小书童 表情克制轻微嘲笑、停顿自然，"你听听，花 5 分钟，论证了这么个伪命题"
镜头 4，2s，切换到观众哈哈大笑
```

英文指南里同样的写法是 `Shot 1, ... Shot 2, ...`。**格式 = `镜号，时长，景别 + 机位 + 主体(@) + 动作 + 台词`，纯文本，一次 15s 出全。**

**(b) Agent 级分镜——画布上的一组图/视频节点。** 见 (4) 场景 1，输出是分镜图网格。

**这两套是可以叠的**：Agent 规划出 15 个分镜，每 3–4 个交给一次 Multi-Shot 生成。

### (6) 角色 / 主体一致性 — Element Library（元素库）

官方《Kling Element Library User Guide》（🔵 `/quickstart/klingai-element-library-3-user-guide`，Feb 5 2026）是四家里写得最细的一份：

| 事实 | 原文 |
| --- | --- |
| 定义 | 「upload multi-angle reference images, and AI will remember your **characters, items, and scenes**. Create once, use consistently」 |
| 多图元素构成 | 「Each element must contain **at least 2 reference images (1 main + 1 additional)** and can include **up to 4** (1 main + 3 supplementary)」 |
| 视频元素 | 「3.0 Omni supports **recording or uploading a character video**. The model automatically extracts the character's **appearance and native voice**」 |
| 音色绑定 | 「character elements also support binding **voice tones**……ensuring the voice follows the character consistently」 |
| 引用上限 | 「Video generation supports up to **7 reference characters**, while image generation supports up to **10**」 |
| 首尾帧绑定 | 「supports binding up to **3 elements** in start frame/start and end frames generation」 |
| AI 代建 | 「the Element Library integrates the latest Kling O1 Image model, which can **automatically generate additional views from a single main reference image**. It also supports **AI-generated element descriptions**……Just upload one main reference image and provide a name」 |
| 类型 | Characters / Animals / Props / **Costumes & Accessories** / **Scenes** / **Special Effects** / Others |

prompt 语法（官方示例原文）：
```
[Shot 1] The camera follows as [@Banana Cat] strolls through the streets of Tokyo,
         encounters [@Korean Girl], and leaps into her arms.
[Shot 2] [@Korean Girl] sits on the sofa from [@Image1] reading a book. …
```
**`[@元素名]` 与 `[@Image1]`（临时参考图）在同一条 prompt 里混用**——具名资产和匿名参考共用一套指代语法。

### (7) 成片与时间线

可灵自己 ⚪ 没有时间线 UI（未找到官方说明）。它的做法是**把"长"推给模型**：单次 15s、Multi-Shot 一次出多镜、Omni 编辑 3–15s 进 / 最长 15s 出、4K 进 4K 出（🔵 2026-06-17 公告）。官方 2026-01-31 公告原话：「**Say goodbye to fragmented assembly**」——它在公开表态"不拼"。

（拼接与续接的 API 事实见仓库内 `agent-native-video-mode.md` §5.2，此处不重复。）

### (8) 进度、结果与历史

- 灵动画布首页有 `我的项目` 卡片区。🟢
- 公告明确输出落「对话 + 画布」，并支持**批量框选、批量下载**。🔵
- 资产是全局一级导航 `资产`。🟢
- ⚪ 生成中的占位/进度形态未能观察。

### (9) 技能 / 模板 / 预设

**可灵没有 `/` 技能系统。** 它用的是**模板 chip + 具名样例 brief**（5 个模板 × 每个 3 个样例 + 更多）。🟢

这是一个更轻的选择：**模板不改变 Agent 的行为，只改变输入框里的初始文本。** 成本几乎为零，但也没有沉淀（没有作者、没有分享、没有"添加到我的"）。对比即梦的技能市场，这是两端。

### 可灵：登录墙后未能观察
⚪ 灵动画布项目内部（对话面板与画布如何并置、节点长什么样、Agent 消息卡形态、进度、成本确认）；Omni 工作台；视频生成表单与 `Multi-Shot` / `自定义分镜` 面板的实际控件；元素库管理界面；资产库。**这一块是四家里缺口最大的，如果 owner 愿意登录一次，收益最高的就是可灵灵动画布。**


---

## 2.3 Runway

来源：`runway.com/product/agent`、`runway.com/product/characters`（🟢 实测），Runway Help Center 五篇文章与其中的官方产品截图（🔵🟡），均 2026-09-17。Help Center 用浏览器可正常访问（此前 curl 403 的问题不复现）。

### (1) 产品形态

**Agent 是一个独立的、以营销为卖点的一等产品，形态是"聊天 + 多标签工作台 + 内置时间线"。** 官方定义（🔵《Creating with Runway Agent》）：

> 「Runway Agent is a **chat-based collaborative agent** that analyzes what you give it……Instead of generating a single asset in isolation, Agent can **plan, produce, and scale entire creative projects while picking the best model for the job at each step**. **A built-in timeline editor** lets you cut, reorder, and upload additional assets.」

产品页定位是营销：「Make marketing that drives revenue. **In one conversation.**」🟢

### (2) 信息架构与布局

**全局左侧导航**（🔵《Navigating Runway》原文顺序）：
`New Session / Home / Agent / Tool / Apps / Workflows / Recents / Projects / Assets / Favorited`，右上角是 credits 余额、成员邀请、支持。

**Agent 首页**：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Hi Daniel, what do you want to create?                  │
│                                                                          │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │ ┌────┐┌────┐┌────┐                                        ↺   │    │
│   │ │附件││附件││附件│                                            │    │
│   │ └────┘└────┘└────┘                                            │    │
│   │ /Commercial for launching my new soda flavor                   │    │
│   │  ↑ skill token（彩色内联）                                     │    │
│   │ [ + ] [▤]                                  [ Ask • Quality ] [→]│    │
│   └────────────────────────────────────────────────────────────────┘    │
│      (▤ Edit in Timeline)(◆ Seedance 2.5)(▤ Mood Board)   [≡]           │
│                                                                          │
│      Marketing campaigns   Movies   Social   Educational   Other        │
│      ┌──────────┬──────────┬──────────┬──────────┬──────────┐          │
│      │ Preset 示例卡（可左右翻）                             │          │
│      └──────────┴──────────┴──────────┴──────────┴──────────┘          │
│                                                                          │
│      ┌──────────┬──────────────────┬──────────────────┐                 │
│      │    +     │ E-Course         │  Mood Board      │  ← 最近会话     │
│      │New timeline│ Thumbnail…     │                  │                 │
│      │Edit existing│ 1d ago         │  2d ago          │                 │
│      │  footage  │                  │                  │                 │
│      └──────────┴──────────────────┴──────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────┘
```
🟡 `runway-agent-home-settings-popover.png` / `runway-agent-skills-picker.png` / `runway-agent-custom-preferences.png`

placeholder 有两个版本（🟡，说明近期在迭代）：早期 `Start with a product, an idea, an image. Or type / for Agent Skills.`；新版 **`Start with your idea. Type @ for References or / for Agent Skills.`**

**Agent 会话（最重要的一张）**：

```
┌──────────────────────────────────────────────────────┬───────────────────┐
│ ← 🔒Private / D&D Session Recap Workflow ··· ✎       │ 83,398 credits    │
│                                                       │ [+Invite][?][···] │
├──────────────────────────────────────────────────────┼───────────────────┤
│        ⟨ Workflows │ ▦ Generations │ ▤ Cuts │ ··· ⟩   │  Here's a plain-  │
│  ┌────────────────────────────────────────────────┐  │  language break-  │
│  │ ▤ DnD Session Recap Video …                    │  │  down of what the │
│  │                                                 │  │  workflow does.   │
│  │  ┌───────────┐                    ┌──────────┐ │  │                   │
│  │  │LLM System │                    │▶ Shot 1  │ │  │  ## What it does  │
│  │  │  Prompt   │──╮                 │  ▣       │ │  │                   │
│  │  ├───────────┤  │  ┌───────────┐  ├──────────┤ │  │  ### What you put │
│  │  │Session    │──┼─▶│ Recap     │─▶│▶ Shot 2  │ │  │  in (3 inputs)    │
│  │  │Transcript │  │  │ Script +  │  ├──────────┤ │  │  • Session        │
│  │  ├───────────┤  │  │ Shot List │─▶│▶ Shot 3  │ │  │    Transcript —…  │
│  │  │Character  │──┤  │ Generator │  ├──────────┤ │  │  • Character      │
│  │  │References │  │  └───────────┘─▶│▶ Shot 4-6│ │  │    References —…  │
│  │  ├───────────┤  │                 ├──────────┤ │  │  • Environment    │
│  │  │Environment│──╯                 │Narrator  │ │  │    References —…  │
│  │  │References │    ┌──────────┐    │Voiceover │ │  │                   │
│  │  └───────────┘    │Music     │───▶│Epic      │ │  │  ### Stage 1:     │
│  │                   │Prompt    │    │Orchestral│ │  │  Script + Shot    │
│  │                   └──────────┘    └──────────┘ │  │  List (AI writing)│
│  │                                                 │  ├───────────────────┤
│  │     [🔍-][🔍+][⤢]  [Edit ↗] [Ask Agent ⌄] [▶ Run]│  │┌─────────────────┐│
│  └────────────────────────────────────────────────┘  ││┌──┐┌──┐┌──┐     ││
│                                                       ││└──┘└──┘└──┘     ││
│                                                       ││ Send a message… ││
│                                                       ││[+][▤]  Auto•Qua ││
│                                                       ││              [→]││
│                                                       │└─────────────────┘│
└──────────────────────────────────────────────────────┴───────────────────┘
       ←──────────── 工作面（约 1110px） ────────────→  ←── 聊天 ~390px ──→
```
🟡 `runway-agent-session-workflow-layout.png`

**注意方向：Runway 把聊天放在右边、工作面放在左边**，与我们宿主（聊天左、画布右）相反；Lovart、Flow 也各站一边（Lovart 聊天左，Flow 聊天右）。这不是共识，是各家自选。

**Generations tab**（同一顶栏，工作面换成瀑布网格）：

```
├──────────────────────────────────────────────────────┼───────────────────┤
│   ⟨ ⚙Workflows │ ▦ Generations ●│ ▤ Cuts │ ··· ⟩  [≡][▦]│ …blended into a │
│  ┌────┬────┬────┬──────┐                              │  single busy    │
│  │ ▣  │ ▣  │ ▣  │  ▣   │  ← 瀑布 masonry，按时间序    │  forest…        │
│  ├────┼────┼────┼──────┤     可按类型 / 收藏过滤       │                 │
│  │ ▣  │ ▣  │ ▣  │  ▣   │     可切网格 / 列表           │  The pattern is │
│  └────┴────┴────┴──────┘                              │  clear now — …  │
```
🟡 `runway-agent-session-generations-tab.png`

**Final Cut tab**（时间线）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ⋮⋮ Coastal Battle ⌄                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                    ⟨ ▦ Generations │ ▤ Final Cut ● ⟩                     │
│                    ┌──────────────────────────────┐                      │
│                    │                              │                      │
│                    │       ▶  预览播放器          │                      │
│                    │                              │                      │
│                    └──────────────────────────────┘                      │
├──────────────────────────────────────────────────────────────────────────┤
│ [↺][↻] [⧎ Split]        ▶  00:44 / 03:07     [🔍-][🔍+][Fit][⌨][⬇ Download]│
│  28  30  32  34  36  38  40  42  44  46  48  50  52  54  56  58 1:00     │
│ ▤ │▣▣▣▣│▣▣▣▣│▣▣▣▣│▣▣▣[···]│▣▣▣▣│▣▣▣▣│▣▣▣▣│▣▣▣▣│  ← 视频轨  [+]         │
│ 🔊│a sack of food scraps for the ca.mp3 ∿∿∿∿∿∿∿∿∿∿∿∿∿∿∿│ ← 音频轨 [+]    │
│ [+] 加轨道                                    ↑ 播放头                    │
└──────────────────────────────────────────────────────────────────────────┘
```
🟡 `runway-agent-final-cut-timeline.png` / `runway-agent-timeline-annotated.png` / `runway-agent-timeline-tracks.png`

**成片长度 03:07。** 这是本次调研看到的唯一一个由 Agent 组装出的分钟级成片实例。轨道能力（官方标注）：Undo & Redo / Split / **Adjust track volume** / **Add media to track** / **Add track**。

### (3) 创作入口与输入区

- 输入接受：文本、图片、视频、音频、**PDF**（🔵 有专门文章《Creating from PDFs with Runway Agent》）
- `@` = References，`/` = Agent Skills（🔵 placeholder 与《Navigating Runway》原文）
- 参数暴露面：**一颗药丸 `Ask • Quality`**（或 `Auto • Quality`），点开：

```
┌──────────────────────────────────────────┐
│ When generating media                    │
│ ┌──────────────┬──────────────┐          │
│ │     Ask      │     Auto     │          │
│ └──────────────┴──────────────┘          │
│ Optimize generations                     │
│ ┌────────┬────────┬────────┬────────┐   │
│ │Quality │ Speed  │  Cost  │ Custom │   │
│ └────────┴────────┴────────┴────────┘   │
│ ┌──────────────────────────────────────┐ │
│ │ Give instructions to the Agent or    │ │
│ │ start with some examples:            │ │
│ │  ( Use @Gen-4 Image for video )      │ │
│ │  ( Think like a social media         │ │
│ │    director )                        │ │
│ │ [ @ Add ]                            │ │
│ └──────────────────────────────────────┘ │
│ FAQs                    [ Set as default ]│
└──────────────────────────────────────────┘
```
🟡 `runway-agent-custom-preferences.png` / `runway-agent-home-settings-popover.png`

官方对每一档的定义（🔵）：

| 档 | 原文 |
| --- | --- |
| Ask before generating media | 「Agent shows you its plan for each step — **including the model, prompt, and estimated credit cost** — and waits for your go-ahead」 |
| Automatically generate（**默认**） | 「Agent generates immediately after planning each step, without waiting for confirmation」 |
| Speed / Cost / Quality | 「how Agent picks models」，desktop 默认 **Quality**，mobile 默认 **Speed** |
| Custom | 自然语言偏好，「Select **@ Add** or type @ to reference a specific **model, resolution or aspect ratio**」 |
| 兜底 | 「Agent weighs this preference……but **will always choose a model capable of fulfilling your request** — if only one model can do the job, Agent uses it regardless」 |

官方给的 Custom 写法示例（🔵）：`Always prefer 1080p and 16:9` / `Use GPT Image 2 for images` / `For long videos, prefer Seedance 2.5`。

**「Set as default for new sessions」**：偏好可以只作用于本会话，也可以升格成全局默认。🟡

### (4) Agent 交互流程

官方四步（🔵 原文小标题）：

```
Step 1 – Starting an Agent chat
   入口四个：侧栏 Agent / app.runwayml.com/agent / 从资产 "Ask Agent" / 项目内（Enterprise）
   两种起手：New chat  |  New timeline ("Edit existing footage")
   回访默认落在上次会话；双击侧栏 Agent 或点会话名 → Start New Chat
       ↓
Step 2 – Prompting Agent
   「a single, simple sentence works well in most cases, as Agent will ask for
     more details as needed to ensure alignment before generating」
   可打 / 触发 skill；skill 与自由文本可同一条消息
       ↓
Step 3 – Reviewing and Refining
   「Agent analyzes your request to build a plan and may ask questions」
   用户二选一：Proceed with generating  |  Refine and workshop the concept
   「If changes are needed……you can provide feedback directly through the chat」
       ↓
Step 4 – Touching up videos
   「If Agent creates a multi-shot video, it will automatically combine your
     clips and audio in the Final Cut tab」
   小改动用 Final Cut 里的工具；也可以直接在聊天里让 Agent 改
```

**三个特别值得记的点**：

1. 官方明确写了免责边界：「Agent's plan describes its **intent, not a guaranteed outcome**」。🔵 这句话应该原样进我们的计划卡片文案。
2. **Workflows 有两个独立审批点**（🔵）：「**Creating a workflow**: Agent confirms before saving a new workflow to your workspace. Building a workflow doesn't consume credits on its own.」/「**Running a workflow**: with Ask before generating media enabled, Agent shows the models, prompts, and estimated credit cost……」并补一句忠告：「consider Ask before generating media for workflows with several generation nodes」。
3. **从评论里改**（🔵）：「**Edit from comments** — tag Agent in a comment on any asset and it posts the result back into the thread.」

### (5) 分镜 / 多镜头

Runway 把三种表示法并列成三个 tab：

| tab | 表示 | 用途 |
| --- | --- | --- |
| **Workflows** | 节点图（输入节点 → LLM 节点 → N 个 Shot 节点 + 配音节点 + 音乐节点） | 可复用的流水线，Agent 可建可跑；`Edit ↗` 进编辑器、`Ask Agent ⌄`、`▶ Run` |
| **Generations** | 瀑布网格，按时间序 | 翻找与挑选 |
| **Cuts / Final Cut** | 时间线，视频轨 + 音频轨 | 成片 |

官方能力清单里明确有（🔵）：「single shots or **multi-shot sequences**」、「**Build and render timelines (multi-clip cuts)**」、「Generate **reference sheets, storyboards, mood boards, and character sheets**」、「Write scripts and narrative structure」。

上面那张 Workflow 截图本身就是一份分镜：`Recap Script + Shot List Generator`（一个 Claude 节点）→ 6 个 `Shot N` 节点。右侧聊天里 Agent 用 Markdown 讲解自己造的流水线（`## What it does` / `### What you put in (3 inputs)` / `### Stage 1: Script + Shot List (AI writing)`，并写明「A narrator recap script — 150–200 words……built to last 60–90 seconds when read aloud」「A **6-shot visual breakdown** — one cinematic scene description per major moment」）。🟡

### (6) 角色 / 主体一致性 — References

**Runway 没有"角色"这个名词，它把"命名一个 reference"当成角色。** 官方《Using reference media to guide your generations》（🔵）：

- 上传后自动编号：`Image 1, Image 2…` / `Video 1…` / `Audio 1…`
- prompt 里打 `@` 弹列表，插入形如 `The product in @[Image 1] rotating slowly with the music from @[Audio 1]`
- **默认是临时的**：「uploaded references are temporary — they exist only for the current session」
- **命名 = 升格为可复用**：悬停 → Reference details → 输入名字回车 →「Saved references will appear in future sessions without needing to be re-uploaded」
- 可 **Share with Workspace**
- 官方给的取舍表原文：「Brand asset, **character**, or style you'll reuse → Save and optionally share with workspace」
- 用例第一条：「Generating **consistent characters** across different scenes, lighting, and styles from a single image」

**⚠️ 更正一条**：`runway.com/product/characters` 的 **Runway Characters 是实时对话视频数字人**（「Real-time conversational video agents, made from a single image」「responds in seconds and stream video at 24fps」「37ms effective model time per frame」「1.75s server-side turnaround」，🟢 实测），带 Vision / Custom voice / Tool calling，用于教育、客服、培训、游戏 NPC。**与分镜角色一致性无关**，不要当成参考对象。

### (7) 成片与时间线

**Runway 是四家里唯一把时间线做进 Agent 的。** Final Cut tab：
- Agent 自动组装：「If Agent creates a multi-shot video, it will **automatically combine your clips and audio** in the Final Cut tab」🔵
- 人工微调：Split / Trim / Adjust track volume / Add a new media track / Undo & Redo 🔵
- 也可以「ask Agent to make edits for you through chat」🔵
- 顶上有 `⬇ Download`
- 音频能力齐全：音效、氛围、foley、对白场景、音乐（独立器乐）、**配音（"using a catalog of cast voices"）** 🔵

另有一条独立入口：首页第一张卡 **`New timeline / Edit existing footage`**——不生成、直接进时间线剪已有素材。🟡

### (8) 进度、结果与历史

- **Session 是组织单位**。官方：「Sessions are where you create generations, and also serve as an **organization structure**……think of Sessions as a folder or group of generations you create at a given time」🔵
- 排列方向官方写死：「the interface organizes content **chronologically on the right-hand pane**, with your **latest generations appearing at the bottom**, and the oldest at the top」🔵
- Generations tab 是会话内全部产物的总览，可按类型/收藏过滤 🔵🟡
- 顶栏常驻 credits 余额（截图里 `83,398 credits` / `12,500 credits`）🟡
- 会话可重命名、可标 Private、可 Invite 协作 🟡
- 全局有 Recents / Projects / Assets / Favorited 四条回看路径 🔵
- ⚪ 生成中的占位/进度条形态未找到官方截图

### (9) 技能 / 模板 / 预设 — Agent Skills

官方《Using Agent Skills》（🔵）：

> 「Agent Skills are **guided workflows** for common creative tasks……Trigger a skill by typing `/` in the Agent composer, and **Agent follows that skill's workflow while you steer the details**.」

内置九项（🔵 原文）：

| Skill | 官方描述 |
| --- | --- |
| `/Ad Campaign` | build a campaign, from concept to finished video and image assets for all platforms |
| `/Commercial` | produce a commercial with a hook, proof and call to action |
| `/Mood Board` | generate a set of images to shape the look of your project |
| `/Motion Graphic` | animate text, charts and infographics into a video |
| `/Resize Image` | reframe an image to a new aspect ratio |
| `/Social Thumbnail` | design an engaging social thumbnail with a headline and subtext |
| `/UGC Video` | create an influencer video where a person talks to the camera |
| `/Workflow` | create, edit and run node-based Workflows |
| `New Skill` | create and teach Agent a task so you can reuse it |

**调用方式**（🔵）：
- 打 `/` 选名字，「The skill appears **inline in your message**」，然后继续写自由文本
- 也可以点 `+` 旁边的 skills 图标开完整菜单，或点首页 composer 下方的 chip
- 「A skill and a regular prompt can **share the same message**」，例：`/Motion Graphic` + `let's plan one for my YouTube channel`
- 「Once sent, **the chat labels your message with the skill that was triggered**, so you always know which workflow Agent is following」

**skills 面板形态**（🟡 `runway-agent-skills-picker.png`）：一个浮层，顶部 tab `🔥 Starters | ▣ Media`，里面一个 `Skills` 区块带搜索图标，下面是**带封面图的卡片网格**，每张卡 = 缩略图 + `/Name` + 一行描述。

**技能怎么影响会话**（🔵 原文，这段最有价值）：

> 「Each skill **breaks its task into steps and checks in with you along the way**. Some skills begin with **exploration before producing final assets**. **Ad Campaign, for example, starts by generating a mood board of different visual directions. Pick the direction you like, or ask for another round**, and Agent then generates the campaign's individual assets in that style.」
>
> 「Skills are **starting points, not scripts**. You can redirect Agent, change formats or ask for variations at any step.」

**自建技能**（🔵🟡 `runway-agent-create-skill-empty.png` / `-filled.png`）：

```
┌──────────────────────────────────────────────┐
│ ▤ Create Skill                            ×  │
│ Give the Agent a set of instructions it can  │
│ follow anytime.                              │
│ Name                                         │
│ [ e.g. Social Media Ad Generator          ]  │
│ Description                                  │
│ [ e.g. Build a campaign from concept to … ]  │
│ Instructions                                 │
│ ┌──────────────────────────────────────────┐ │
│ │ Write the workflow the agent should      │ │
│ │ follow, or see an example.               │ │
│ │                          (等宽字体)      │ │
│ │                            0 / 5,000     │ │
│ └──────────────────────────────────────────┘ │
│ Sharing                                      │
│ [ 👤 Private                            ⌄ ]  │
│     👤 Private          Only you             │
│     👥 Share with workspace  Everyone …      │
│              [ Cancel ]  [ Create ]          │
└──────────────────────────────────────────────┘
```

官方写作建议（🔵）：「Clear, specific instructions work best. **Describe the steps in order, name the output you expect** and include any style guidance Agent should apply every time.」

另有 **Brand Kits**（🔵 有专文《Using Brand Kits with Agent》）：「Applied kits inform Agent's plan for each generation: the assets it references, the styles…」


---

## 2.4 Google Flow

来源：`https://flow.google.com/`（🟢 **登录态实测**，owner 的浏览器本就已登录；全程只浏览、未生成、未订阅、两个营销勾选框保持未勾）与 `support.google.com/flow`（🔵）。

### (1) 产品形态

**Flow 是"项目 + 资产库 + 右侧 Agent 面板"，Agent 是可开可关的一层。** 官方原文（🔵）：

> 「To turn the Agent on, in the prompt box, click **Agent**……To turn the Agent off, click Agent again.」
> 「**The Google Flow prompt box changes when the Agent is on.** When you turn the Agent off, you'll return to the **standard Google Flow prompt box**.」

**同一个输入框，两个人格。** 这和即梦 `创作类型` 下拉是同一个设计意图：Agent 是默认，但表单随时可以回来。

关键的计费口径（🔵）：
> 「**Agent queries do not currently cost Google Flow credits.** However, there is a **daily quota** on the number of Agent queries.」
> 「**All media generated by the Agent is automatically saved to the project you currently have open.**」

### (2) 信息架构与布局

**Flow 首页**（🟢 `flow-home.png`）：顶栏 `Google Flow | Flow Music | Flow TV | Discord IG X | ? | ⋮ | avatar`；下面是宣传轮播；再下面是项目网格（空账号只有一张 `+ 新建项目`）。

**项目工作台**（🟢 `flow-project.png`，这是 Flow 的主屏）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🏠 │ 9月17 - 15:40 ⋮ │   [ 🔍 搜索        ] [⚟]   │ [+][?][⚙][⋮][avatar]│
├───────────────┬──────────────────────────────────┬───────────────────────┤
│ ▦ 所有媒体    │                                  │ ≡  未命名的会话  ✎  × │
│ ⟟ 角色        │                                  │                       │
│ ▤ 场景        │                                  │                       │
│ ───────────   │              ✽                   │      Nain，您好！     │
│ ⁙ 工具        │       开始创建或拖放媒体          │   您想创作什么内容？  │
│               │                                  │                       │
│               │        （资产网格 / 空态）        │  ┌──────────────────┐ │
│               │                                  │  │📖 告诉我你能做什么│ │
│               │                                  │  ├──────────────────┤ │
│               │                                  │  │🌱 如何开始?      │ │
│               │                                  │  ├──────────────────┤ │
│               │                                  │  │🎞 制作视觉情绪板 │ │
│               │                                  │  └──────────────────┘ │
│               │                                  │  ┌──────────────────┐ │
│ 🗑 回收站      │                                  │  │ 您希望创作什么？ │ │
│ ⊟ 收起        │                                  │  │ [+]   [▤][⚙] [→]│ │
└───────────────┴──────────────────────────────────┴──└──────────────────┘─┘
  ←─ 232px ──→   ←────────── 资产网格 ──────────→   ←── Agent ~355px ──→
```

左侧 rail 只有四项 + 回收站：**所有媒体 / 角色 / 场景 / ─── / 工具**。`角色` 和 `场景` 是**一级资产类型**，与"所有媒体"同级——这是 Flow 最明确的立场：**角色和场景不是标签，是实体。**

建议卡是**动态的**（多次刷新观察到不同组合）：`告诉我你能做什么` / `如何开始?` / `制作视觉情绪板` / `了解生成费用` / `编辑图片` / `制作分镜画面` / `为图片创建多个版本` / `重命名我的资源` / `将概念转化为提示`。🟢
注意里面有 **`了解生成费用`** 和 **`制作分镜画面`**——Flow 把"问清楚要花多少钱"当成一个首屏建议。

### (3) 创作入口与输入区

composer 四个控件（🟢）：`[+ 附件]` 左下；右下 `[▤ 智能体指令] [⚙ 智能体设置] [→ 发送]`。

**`@` 与 `+` 打开同一个全屏资源选择器**（🟢 `flow-composer-at.png`）：

```
┌─────────────────────────────────────────────────────────────┐
│  ⟳       [ 🔍 搜索资源                        ]   [最近 ⌄]  │
├──────────────┬──────────────────────────────────────────────┤
│ ▦ 全部       │                                              │
│ ▣ 图片       │                    ✽                         │
│ ▶ 视频       │              未找到资源。                     │
│ ♪ 语音       │                                              │
│ ⟟ 角色       │                                              │
│ ☺ 虚拟形象   │                                              │
│ ⊞ 上传的内容 │                                              │
│              │                                              │
│ ⬆ 上传媒体内容│                                              │
└──────────────┴──────────────────────────────────────────────┘
```

类别包括 **语音** 和 **虚拟形象**（avatar）——引用面比其他三家更宽。

**智能体设置**（🟢 `flow-composer-tune.png` / `flow-video-models.png`）：

```
┌─────────────────────────────────────────┐
│ ← 智能体设置                          × │
│ 生成前先确认                             │
│  ◉ 始终                                  │
│    智能体将在生成媒体内容之前征求确认。  │
│  ○ 永不                                  │
│    智能体将自动生成媒体内容并消耗点数。  │
│                                          │
│ 图片生成默认设置                         │
│ [▭16:9][▭4:3][▫1:1][▯3:4][▯9:16]        │
│ [ x1 ][ x2 ●][ x3 ][ x4 ]               │
│ [ 🍌 Nano Banana 2 Lite            ⌄ ]  │
│                                          │
│ 视频生成默认设置                         │
│ [▭ 16:9 ●][▯ 9:16]                      │
│ [ x1 ●][ x2 ][ x3 ][ x4 ]               │
│ [ Omni 1.1 Flash                   ⌄ ]  │
│     Omni 1.1 Flash ●                     │
│     Veo 3.1 - Lite                       │
│     Veo 3.1 - Fast                       │
│     Veo 3.1 - Quality                    │
│                     [      保存       ]  │
└─────────────────────────────────────────┘
```

**默认「始终」确认**（🟢 实测选中态 + 🔵 官方原文「By default, the Agent asks for your permission before taking any actions that use your AI credits」）。**与 Runway 默认 Auto 正好相反。**

参数面：比例 / 数量 / 模型，图片与视频各一套。**同样没有时长、没有镜数。**（⚠️ 标准非 Agent 提示框里**有** `Generation length`，🔵——即"时长"只在关掉 Agent 的表单里出现。这是一条很强的信号：**时长在 Agent 模式下是 Agent 的事。**）

**智能体指令**（🟢 `flow-composer-article.png` / `flow-agent-instructions.png`，这是 Flow 独有的一块）：

```
┌─────────────────────────────────────────┐
│ ← 智能体指令                          × │
│ ┌─────────────────────────────────────┐ │
│ │ [●━] 指令标题                    🗑 │ │  ← 每条可开可关、可删
│ │ ┌────┐ ┌─────────────────────────┐ │ │
│ │ │ +  │ │ 创建智能体指南          │ │ │
│ │ │参考│ │                         │ │ │  ← 每条指令可挂参考图！
│ │ └────┘ └─────────────────────────┘ │ │
│ └─────────────────────────────────────┘ │
│ [           + 添加指令               ]  │
│                                          │
│                     [      完成       ]  │
└─────────────────────────────────────────┘
```

官方（🔵）：「To improve consistency in the Agent's behavior **across your entire project**, add instructions for it……**Add a reference image** and enter your guidelines for the Agent.」

**一条指令 = 标题 + 开关 + 参考图 + 正文，可叠多条。** 这比 Runway 的纯文本 Custom preferences 强一档：它能挂图。等于一个轻量的、项目级的风格圣经。

### (4) Agent 交互流程

官方能力清单（🔵 原文）：

- **Brainstorm and plan**: 「outline **storyboards**, develop visual **mood boards**, and turn high-level concepts into actionable prompts」
- **Generate new media**: 「Ask the Agent to generate videos or images and **select the best model to generate with**」
- **Edit assets directly**: 「Ask the Agent to edit **selected media** from your project」
- **Batch generate**: 「create **multiple variations** of an asset at once」
- **Organize your assets**: 「**rename** specific files, **group selected media into a new Collection**, or **delete** unused assets」
- **Add context & references**: 「**Drag media into the Agent prompt box** from your device or project. You can also **select multiple assets and let the agent know which media you are referring to**」

最后一条很重要：**在资产网格里框选几个，然后在聊天里说「把这几个……」**——选择态是 Agent 的隐式上下文。这是画布/网格 + 聊天并置才做得到的交互，纯聊天做不到。

流程骨架（🔵 官方步骤合成）：
```
在项目里打开 Agent → 输入（可拖素材进框）→ 若「生成前先确认=始终」，Agent 先请示
  → 生成 → 媒体自动落进当前项目的资产网格
  → 编辑：把要改的素材拖进输入框（可多选）+ 一句话 → 「Edits are automatically
     saved to the asset's stack」
```

**成本确认**：🔵 明确 —— 默认在花积分前请示；Agent 的对话查询本身不花积分（有每日配额）。

### (5) 分镜 / 多镜头 — Scenebuilder

官方（🔵《Edit videos & build scenes in Google Flow》）：

> 「You can use Google Flow's **Scenebuilder** to: **Arrange multiple clips in a sequence / Rearrange the order of your clips / Trim the beginning and end of each clip with the handles / Preview the whole sequence / Download a scene.**」

加入方式：素材卡 `More ⋮ → Add to Scene`；排序：`Drag your clips in the order you want`。🔵

也就是说 **Flow 的分镜就是「场景 = 一串 clip」**，而 `场景` 是左侧一级资产类型（🟢）。多镜头叙事靠：单条生成 + Extend + 拼进 Scene。

Agent 侧建议卡里直接有 **`制作分镜画面`**（🟢），并且官方能力写着 Agent 能 outline storyboards（🔵）。

### (6) 角色 / 主体一致性 — 角色 + `@`

**创建界面**（🟢 `flow-characters.png`）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← 新角色                                                                 │
│                                                                          │
│              创建并重复使用角色，制作风格一致的视频。                     │
│              使用下面的示例提示，或从头开始创建。                         │
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │▣ 古灵精怪    │ │▣ 精英人士    │ │▣ 百变角色    │                     │
│  │  过目难忘的  │ │  干净利落、  │ │  不局限于人  │                     │
│  │  怪趣人物…   │ │  谈吐得体…   │ │  类，万物…   │                     │
│  └──────────────┘ └──────────────┘ └──────────────┘                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │▣ 邻家面孔    │ │▣ 邪恶反派    │ │▣ 幻境之灵    │                     │
│  └──────────────┘ └──────────────┘ └──────────────┘                     │
│                                                                          │
│              ┌────────────────────────────────────────┐                 │
│              │ 描述您的角色…                          │                 │
│              │ [+] [⟟格式]    [🍌Nano Banana 2 Lite ⌄][→]│              │
│              └────────────────────────────────────────┘                 │
│              [   ⬆ 上传   ]  [   + 从项目中添加   ]                      │
└──────────────────────────────────────────────────────────────────────────┘
```

**三条创建路径并列：生成 / 上传 / 从项目素材里挑。** 6 张原型预设卡（古灵精怪 / 精英人士 / 百变角色 / 邻家面孔 / 邪恶反派 / 幻境之灵）不是风格，而是**人物原型**——降低"我该描述什么"的门槛。

**角色的构成**（🔵 官方步骤）：
1. 生成或上传 **1–2 张**展示外观的图（「A character must contain at least one image to be used」）
2. 起名字
3. **选音色**（可 `Create New Voice`：基础音色 + 名字 + 「Voice Performance」自然语言描述 + 示例台词试听 8 秒）
4. 可选：填角色信息

官方定义（🔵）：「bundle specific visual and audio references into a single, reusable character. Your character's **face, clothing, and voice remain strictly consistent** across multiple generations」

**引用语法**（🔵）：
- `@角色名` —— 例：`@CaptainZoro walking through a futuristic city.`
- `@me` —— 引用你自己的 avatar
- `@Voice: Andrew` —— 引用音色

**另一条平行机制 Ingredients**：「consistently use the same images for your character and key objects from one clip to the next」，在标准提示框里 `Video → Ingredients` 添加。官方给的写法很有代表性：「With ingredients of a woman, a lava lamp, and a foggy street, you can enter the prompt: **The woman, whose torso is the lava lamp, walks down the foggy street.**」🔵

官方最佳实践（🔵）：「provide subject or product references on a **plain or segmented background**」「Make sure location and style references **don't contain extra subjects**」「Your text prompt should **complement, not contradict**, your visual inputs」。

### (7) 成片与时间线

- **Scenebuilder**：见 (5)，可排序/裁剪/预览/下载整场。🔵
- **Extend**：「click **Extend**……describe how the action should continue」。限制：「You can currently **only extend Veo generated videos**」「You **can't apply other edit modes** such as insert, remove, and camera **to extended video clips**」。🔵
- **视频编辑（Omni Flash）**：上传 ≤60s / 1GB，>30s 必须先裁到 30s；在裁剪窗口里**选一段 ≤10 秒**，加一句话（例：「Change the lighting to a cinematic sunset」「Add a text overlay that says 'Coming Soon'」）；「You can continue for **up to 3 conversational turns** without losing the context of your previous edits」。🔵
- **音频**：语音是一等资产类型（🟢 资源选择器里有 `语音`），可自定义音色。🔵
- **字幕**：⚪ 未找到官方说明（只看到「Add a text overlay」作为编辑指令的一个例子）。
- **导出**：下载（含 **GIF 270p**）、分享链接（可选 `Include inputs` 一并分享输入素材）、**Publish to YouTube**。🔵

### (8) 进度、结果与历史

- **资产 stack + History 面板**（🔵，这是 Flow 最好的一处设计）：
  > 「When you edit a video in Google Flow, **you don't lose the original**. In the **History panel**, you can find **all previous versions of the video and the prompts you used to generate them**.」
  > 「Edits are automatically saved to the **asset's stack**.」
  > History 里可 `Save to Project` 把某个旧版本提为正式资产。
  > 视频可暂停在任一帧 → `Save frame` 存成图片 → 再当 ingredient / 首帧 / 尾帧用。
- **会话历史**：`≡ → 会话历史记录 / 创建新会话`，会话属于项目，可重命名、可删除（「Deleting a session clears the chat history, but **any media generated remains in your assets**」）。🟢🔵
- **项目设置**（🔵，值得抄的细节）：视图模式 `Grid` / `Batch`（Batch = 生成物一条条排，旁边是详情）、网格尺寸、悬停是否出声、是否强制静音、**是否在 tile 底部显示资产类型与生成 prompt**、**提交后是否清空提示框**。
- **Collections**：可嵌套的文件夹，拖一个 tile 到另一个上即可创建。🔵
- ⚪ 生成中的占位/进度形态未能观察（未提交生成）。

### (9) 技能 / 模板 / 预设 — Tools（工具）

**Flow 没有 `/` 技能，它有"工具"——用户自己造的生成式小应用。** 🟢 `flow-tools.png` / `flow-tools-community.png` / `flow-tools-templates.png`

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← 探索工具        ⟨ 我的工具 │ 社区 │ 模板 ⟩                             │
├───────────┬──────────────────────────────────────────────────────────────┤
│ ▦ 所有媒体│  ┌────────────────────────────────────────────────────────┐ │
│ ⟟ 角色    │  │ 提交工具，展示您的创意                                  │ │
│ ▤ 场景    │  │ 我们每周都会从社区中挑选几款最令人心动的新工具…         │ │
│ ─────     │  │            ┌──────────────────────────────┐            │ │
│ ⁙ 工具 ●  │  │            │ Effect Mode [ASCII Matrix ⌄] │            │ │
│           │  │            │ Pixel size  ──●────────  6px │            │ │
│           │  │            │ Contrast    ──●────────  6px │            │ │
│           │  │            └──────────────────────────────┘            │ │
│           │  └────────────────────────────────────────────────────────┘ │
│           │  我的作品                                                    │
│           │  ┌──────────┐                                               │
│           │  │    ⬆     │  ← 升级即可创建                               │
│           │  └──────────┘                                               │
└───────────┴──────────────────────────────────────────────────────────────┘
```

- **模板 tab**（Google 官方出品，🟢 原文）：
  图片类 `Simple Sketch`（Turn any drawing into a stylized image）/ **`Scene Explorer`**（Explore visuals for scenes based on an initial location）/ `Mockup` / `Image Editor` / **`Shot Explorer`（See your scene from new angles）** / `Mask Magic`（selective image edits using segmentation）/ `Converge` / `Grid Architect`（Create image grids and extract individual images from them）
  视频类 `Shader Effects` / `Type Overlays`（Add animated text to your videos）/ `pixelBento` / `Poster Designer` / `Video Sketch` / **`Transition Machine`**
- **社区 tab**：几十个用户提交的工具，署名作者，例如 `Character Persona Generator`（**Generate 22+ consistent character portraits from a reference image across multiple angles**）、`ComicGen Studio`、`Emote Crafter Pro`、`Fashion Grid Analyzer`、`Background Remover`、`Face Morph`。🟢
- 创建工具需要付费档（「升级即可创建」「只需描述您的构思，即可开始构建您能想象到的任何创意工具」）。🟢

**注意 `Shot Explorer`（同一场戏换机位）和社区的 `Character Persona Generator`（一张参考图出 22+ 多角度一致肖像）** —— 这和可灵的「多视角分镜」「角色三视图」是同一个需求的两种实现。**"从一张图扩出一组角度"是一个跨厂商反复出现的独立动作，值得单列成一个工具/技能，而不是埋在分镜流程里。**


---

## 2.5 次要观察（深度不足，仅作旁证）

### 海螺 Hailuo（MiniMax）— 🟢 实测 `hailuoai.video`，未登录

**同一个首页里，表单与 Agent 并排放着，用三个分段按钮切换**：`创作视频 | 创作图片 | 海螺Agent`。🟢 `hailuo-home.png` / `hailuo-agent.png`

```
表单态（创作视频）：
┌──────────────────────────────────────────────────────────────┐
│ ┌────┐  描述您想要生成的视频内容，例如，"一个孩子在公园里放  │
│ │ +  │  风筝，金色阳光，镜头上移。"                          │
│ │参考│                                                        │
│ │0/12│                                                        │
│ └────┘                                                        │
│ [⊙MiniMax H3][✂全能参考][▣2K][⏱5s][▭21:9]    [▨1] [💎60] [✦创作]│
└──────────────────────────────────────────────────────────────┘

Agent 态（海螺Agent）：「全模态支持 无限画布 让创作更简单」
┌──────────────────────────────────────────────────────────────┐
│ ┌────┐  分享您的想法—与智能助手共同创作视频、图片、音乐等内容。│
│ │ +  │                                                        │
│ └────┘                                                        │
│ [⊙自动][✂自动比例][⁘工具]                            [✦创作] │
└──────────────────────────────────────────────────────────────┘
                              ↓ 点「工具」
                         ┌──────────────┐
                         │ ▣ 生成图像   │
                         │ ▶ 生成视频   │
                         │ ♪ 生成音乐   │
                         │ ⁞ 语音合成   │
                         │ ▤ 一键MV     │
                         └──────────────┘
```
🟢 `hailuo-agent-tools.png`

两条值得记的：
1. **同屏对照最清楚**：表单态 6 个参数芯片（模型/参考模式/分辨率/**时长**/比例/数量）+ 明码积分 `💎60`；Agent 态只剩 `自动` / `自动比例` / `工具`。**时长、分辨率、数量在 Agent 态直接消失。**
2. **`工具` 菜单 = 用户显式指定 Agent 该调哪个工具。** 四家里只有海螺把工具选择权直接交给用户。这是一个介于"表单"与"全自动"之间的中间档，很便宜，值得考虑。

### Lovart — 🟢 实测 `lovart.ai`，未登录（营销页含产品实录）

布局是**聊天在左（窄）、画布在右（宽）**，与我们宿主一致。🟢 `lovart-home.png`

```
┌───────────────────────┬──────────────────────────────────────────────────┐
│ ⊙ 香薰产品发布      ⌄ │  ▣ Image              800 x 1440                 │
│ ┌───────────────────┐ │  ┌────────┐  ┌──────────────┐  ┌────────┐       │
│ │ 为香薰蜡烛系列产品│ │  │  ▣     │  │      ▣       │  │   ▣    │       │
│ │ 页设计电商视觉素材│ │  │        │  │  （选中态带  │  │        │       │
│ │ ，包括主图、场景图│ │  │        │  │   尺寸标签） │  │        │       │
│ │ 和产品特写…       │ │  └────────┘  └──────────────┘  └────────┘       │
│ └───────────────────┘ │                                                  │
│ ✓ 已分析用户意图      │   [电商] [品牌] [社交媒体]  ← 结果分组标签        │
│ ✓ 已探索视觉趋势      │                                                  │
│ ✓ 已收集参考资料      │                                                  │
│                       │                                                  │
│ 我已为香薰蜡烛产品详 │                                                  │
│ 情页生成了一套视觉素 │                                                  │
│ 材，聚焦温暖感与感官 │                                                  │
│ 吸引力。…             │                                                  │
└───────────────────────┴──────────────────────────────────────────────────┘
```

两条：
1. **步骤流是"进行时 → 完成时"的一行行小字**，官方演示原文按顺序是：`正在分析用户意图 → 已分析用户意图 → 正在搜索高质量参考 → 已探索视觉趋势 → 正在研究品牌信息 → 已收集参考资料`。**同一条目在完成后原地改写成过去式**，不是追加一条新消息。🟢
2. **`/` 技能**：`interior-design` / `logo-branding` / `outfit-styling` / `product-shoot` / `style-transfer` / `merch-design` / `poster-design`，官方标语「一键技能，胜任每一项创意任务」。🟢
3. 首页示例输入是「上传 `norven-logo.png` + `norven-brand-book.pdf` + 一句『为 Norven Running 创建一套发布活动。』」——**品牌资料（PDF）作为一等输入**，与 Runway 的 PDF 入口、Brand Kits 同向。🟢

### LTX Studio — ⚪ 未能访问
`ltx.studio` 在本次会话中导航超时/被阻断，未取得任何一手观察。**不写任何结论。**

---

## 三、横向对照矩阵

| | 即梦 Jimeng | 可灵 Kling（灵动画布） | Runway Agent | Google Flow | 海螺 Agent | Lovart |
| --- | --- | --- | --- | --- | --- | --- |
| **形态** | Agent 对话 + 无限画布（首页 tab 切换） | Agent 画布（与多个独立表单工具并列） | 聊天 + 三标签工作台（节点图 / 网格 / 时间线） | 项目资产库 + 右侧可开关 Agent 面板 | 表单 / Agent 同屏分段切换，Agent 落无限画布 | 聊天 + 画布 |
| **聊天位置** | ⚪ 登录墙后 | ⚪ 登录墙后（公告称"对话+画布"） | **右** | **右** | ⚪ | **左** |
| **输入接受** | 文本 / 剧本 / 上传参考 / 语音输入 | 文本 / 图片（chip `图1`）/ 视频 | 文本 / 图 / 视频 / 音频 / **PDF** | 文本 / 拖入项目素材或本地文件 | 文本 / 参考 0-12 个 | 文本 / 图 / **PDF 品牌手册** |
| **`/` 技能** | ✅ **技能市场**（作者/赞/使用数/添加/11 分类） | ❌（用模板 chip + 具名样例 brief 代替） | ✅ 9 个内置 + **Create Skill**（≤5000 字符，可分享 workspace） | ❌（用 **Tools** 生成式小应用代替，有社区与模板） | ❌（用 `工具` 菜单显式指定工具） | ✅ 7 个 |
| **`@` 引用** | ✅ 主体 | ✅ `[@元素名]` / `[@Image1]` | ✅ References（`@[Image 1]`，命名后跨会话） | ✅ `@角色名` / `@me` / `@Voice: X` | ⚪ | ⚪ |
| **参数谁定** | Agent。`生成偏好` = 自动开关 + 比例 + 模型 | Agent。`选择模型` = 自动开关 + **模型多选允许集** | Agent。`Ask•Quality` 药丸 = 模式 + Speed/Cost/Quality/**Custom(@模型/分辨率/比例)** | Agent。`智能体设置` = 确认策略 + 比例 + **数量** + 模型（图/视频各一套） | Agent。`自动` + `自动比例` + `工具` | ⚪ |
| **Agent 模式下是否暴露时长/镜数** | ❌ / ❌ | ❌ / ❌（但模型侧有 `Custom Multi-Shot` 面板配镜数与逐镜时长） | ❌ / ❌ | ❌ / ❌（时长只在关掉 Agent 的标准表单里） | ❌ / ❌（表单态才有 `5s`） | ⚪ |
| **生成前确认** | ⚪（技能描述写「确认后出片」） | ⚪ | ✅ `Ask` 档列**模型 + prompt + 预估积分**；**默认 Auto** | ✅ `始终 / 永不`；**默认始终** | ⚪ | ⚪ |
| **Agent 对话是否计费** | ⚪ | ⚪ | 按 credits（未细分） | **对话不计费**，仅有每日配额；媒体计费 | ⚪ | ⚪ |
| **分镜表示** | 画布节点（`part 02-9`，15s/节点，带连线）+ 技能里的「九列分镜表」 | ① prompt 里 `镜头N，Ns，…` 一次出多镜 ② 画布上的分镜图网格 | ① Workflow 节点图的 `Shot N` 节点 ② Generations 网格 ③ Final Cut 时间线 | 场景 = 一串 clip（Scenebuilder），`场景` 是一级资产 | ⚪ | 不适用 |
| **角色一致性** | 「主体」一级导航，`@` 引用 | **Element Library**：2–4 张多角度图（1 主 + 1–3 补）/ 可从视频建 / 可绑音色 / 视频引 7 图片引 10 / 首尾帧绑 3 / **AI 从 1 张主图自动扩视角与写描述** | **Saved References**：上传自动编号 → 命名即跨会话复用 → 可分享 workspace | **角色**：1–2 张图 + 名字 + **音色** + 简介，项目内复用；另有 Ingredients / Frames | ⚪ | ⚪ |
| **成片** | 无 UI；技能描述里出现工具名 `video_editor`「最终拼接」 | **不做**（官方："Say goodbye to fragmented assembly"），靠单次 15s + Multi-Shot | ✅ **Final Cut 时间线**（视频轨+音频轨，Split/Trim/音量/加轨/Download），实例 **03:07** | ✅ **Scenebuilder**（排序/拖拽裁剪/预览/下载场景）+ Extend（仅 Veo） | ⚪ | 不适用 |
| **改一镜** | 🟡 官方图：在帧上套索/圈画 + 一句话（Seedance 2.5 视频编辑） | Omni 视频编辑：3–15s 进、≤15s 出、4K，prompt 用 `@视频` `@图片` | 「restyle, change environments/seasons/lighting, swap or alter elements, **preserving the original motion and framing**」；也可在资产评论里 @Agent | Omni Flash：上传→裁到 30s→选 ≤10s 片段→一句话→**最多 3 轮保持上下文** | ⚪ | ⚪ |
| **进度呈现** | ⚪ | ⚪（公告称"并行同步生成并展示在画布上"） | ⚪ | ⚪ | ⚪ | ✅ 步骤行"进行时→完成时"原地改写 |
| **结果落点** | 画布节点（带 `AI生成` 徽标 + 变体计数 `12 ⌄`） | 对话 + 画布，可**批量框选批量下载** | Generations 网格（右侧聊天时间序，**最新在底部**） | 项目资产网格（**自动存进当前项目**）+ 资产 stack + History 面板 | 无限画布 | 画布节点（带类型与尺寸标签） |
| **版本/历史** | 节点内变体计数 | ⚪ | Session 即组织单位；Recents/Projects/Assets/Favorited | **asset stack + History 面板保留每个旧版本与当时的 prompt**；可 Save to Project / Save frame | ⚪ | ⚪ |
| **会话与项目的关系** | `对话` 与 `画布` 是两条并列历史 | 项目 | Session = 文件夹；Enterprise 下 Project 内也可用 Agent | **一个项目 N 个会话**；删会话不删素材 | ⚪ | 项目 |
| **社区/生态** | 技能市场 + 作品流 + **「查看创作过程」→ 只读画布 + 复制项目** | 创意圈 + **MCP / CLI**（让别人的 Agent 调可灵） | Workflows 可分享/发布成 app 或 API；skill 可 share with workspace | 工具社区（每周精选）+ Flow TV | 作品流 | 探索 |

---

## 四、收敛的模式 vs 各家分歧

### 4.1 已经收敛（可以安全照抄，不必再想）

1. **一个大输入框起手，不是一张表单。** placeholder 直接把可用触发写进去（「支持 `/` 使用技能，`@` 添加主体」/「Type @ for References or / for Agent Skills」）。四家一致。
2. **参数收进一颗小控件，默认自动。** 内容固定就是 **比例 / 数量 / 模型** 三件，图片与视频各一套。**没有人在 Agent 模式暴露时长和镜数。**
3. **富文本输入框，引用是内联 chip/token 而不是附件列表。** 即梦是 tiptap；Runway 的 `/Commercial` 是彩色内联 token；可灵的 `图 1` `图 2` 是文本开头的 chip。
4. **结果落在一个持久的空间面（画布或网格），不是聊天气泡。** 并且四家都保留一个全局资产库。
5. **角色 = 具名实体 + 多张多角度图（+ 音色），用 `@` 指代。** 差别只在张数上限与是否绑音色。
6. **一次对话可以产出一批**（批量变体 / 批量 prompt 并行）。可灵与 Flow 都把它写成卖点。
7. **改图/改视频是"选中 + 一句话"**，不是重新填表。选中可以是画布框选（Flow）、可以是画面上圈画（即梦）、可以是时间片段（Flow / 可灵 Omni）。
8. **技能/模板的描述文案都写成「何时调用 / 不处理什么」。** 即梦的社区技能与 Runway 的 Create Skill 指南完全同构。
9. **免责话术**：Runway 的「plan describes its intent, not a guaranteed outcome」值得原样抄。

### 4.2 真正的分歧（我们要自己拍板）

| 分歧点 | A 派 | B 派 | 备注 |
| --- | --- | --- | --- |
| **默认是否先请示** | **Flow：默认「始终」确认** | **Runway：默认 Auto** | 两家给的理由都在文案里：Flow 说「默认在花积分前请示」，Runway 说 Ask 档适合"有多个生成节点的 workflow"。→ 我们的视频单价高，倾向 Flow。 |
| **聊天在左还是在右** | Runway / Flow：**右** | Lovart / 我们宿主：**左** | 无共识。宿主已在左，没有理由改。 |
| **谁来切镜头** | 可灵：**模型切**（Multi-Shot 一次出多镜） | Runway / Flow：**先分镜再逐镜生成再拼** | 这条在仓库内 `agent-native-video-mode.md` §5.3 已详细展开，四种路线。注意 Runway `multi_shot_video` 同端点给 auto/custom 两档 —— **做成开关而不是立场**。 |
| **要不要时间线** | Runway：**要**（Final Cut，做到 03:07）<br>Flow：**要**（Scenebuilder，轻量） | 可灵：**明确不要**（"Say goodbye to fragmented assembly"）<br>即梦：没有 UI，只有一个 `video_editor` 工具 | 即梦那条最省：**成片是一个 Agent 工具，不是一个界面。** |
| **技能 / 模板的形态** | 即梦：**技能市场**（UGC、有作者与使用量）<br>Runway：**内置 + 自建 + workspace 分享** | 可灵：**只是预填文本**（模板 chip + 样例 brief）<br>Flow：**生成式小应用**（Tools，带参数控件）<br>海螺：**显式工具选择菜单** | 成本从高到低：市场 > 自建 > 小应用 > 预填文本 > 工具菜单。**第一版做"预填文本 + 内置技能"，把市场留给以后。** |
| **模型选择权** | 可灵：**多选允许集**（用户划范围，Agent 在范围内挑） | Runway：**意图档**（Speed/Cost/Quality/Custom 自然语言）<br>Flow / 即梦：**单选下拉** | 可灵的允许集最贴我们的多 channel 形态（权益直接编码进列表）。 |
| **参考素材的持久性** | Runway：**默认临时，命名即持久**<br>Flow / 可灵：**先建实体再引用** | — | Runway 那条更顺：用户不用预先决定"这算不算一个角色"。 |
| **历史的粒度** | Flow：**每个资产一个 stack + History 面板，记住每一版和当时的 prompt** | 其他家：会话历史 / 节点变体计数 | Flow 这条最强，也最贵。 |

---

## 五、给原型的输入

前置：宿主已有 **聊天面板（左，对话 / 创作记录两个 tab，流式、2–4 选项澄清、中途插话）+ 无限画布（右）+ `@` 引用 + 参考图按钮 + 生成参数 popover + 我的资产 + 四个工具（generateImage / editImage / generateVideo / readLibrary）**。以下只写**差量**，不重复已有。

### 5.1 提议的屏幕布局

**主张：不新建一个"视频模式"。把视频能力长进现有的创作模式，只在聊天面板上方加一条"工作面切换条"。** 理由：四家里没有一家把视频单独拆成一个模式；可灵是唯一拆开的，而它自己在首页挂着「灵动画布即将焕新升级」的迁移公告。

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 幕芽  项目名 ✎        [ 🔍 ]              余额 12,500 ✨   [+邀请] [⚙] [☺] │
├──────────────────────────────┬─────────────────────────────────────────────┤
│ ⟨ 对话 │ 创作记录 ⟩      ⋮   │   ⟨ ▦ 画布 │ ▤ 分镜 ● │ ⧗ 成片 ⟩    [⤢][%] │
│                              │                                             │
│ ┌──────────────────────────┐ │  ┌────┬──────────────────────────────────┐ │
│ │ 你：做一条 30 秒的国风短 │ │  │ #  │ 画面 / 台词 / 运镜  时长  状态   │ │
│ │ 片，关于一个盲剑客       │ │  ├────┼──────────────────────────────────┤ │
│ └──────────────────────────┘ │  │ 1  │ ▣ 大远景，晨雾竹海     5s  ✓出片 │ │
│                              │  │ 2  │ ▣ 特写，露珠滴落       3s  ⟳出片中│ │
│ ⟳ 正在读参考图…              │ │  │ 3  │ ▣ 挑战者踏叶而来      4s  ✓出图 │ │
│ ✓ 已定下风格与两位角色       │ │  │ 4  │ ▤ 盲剑客背身听风      4s  ○待办 │ │
│ ✓ 已写出 8 镜分镜            │ │  │ …  │                                  │ │
│                              │ │  └────┴──────────────────────────────────┘ │
│ ┌──────────────────────────┐ │  ↑ 每行可展开：首帧图 / 画面 / 台词 / 运镜  │
│ │ 幕芽：我按你说的写了 8   │ │    / 时长 / 引用的角色 chip / 版本           │
│ │ 镜，共 31 秒。风格是     │ │  ↑ 行右侧悬浮：[重出这一镜][改一句][延长]   │
│ │ ……                       │ │                                             │
│ │ ┌──────────────────────┐ │ │                                             │
│ │ │ ▶ 接下来我要做（3步）│ │ │                                             │
│ │ │ 1 出 8 张首帧图       │ │ │                                             │
│ │ │   Seedream · 16:9     │ │ │                                             │
│ │ │ 2 逐镜出片（8 段）    │ │ │                                             │
│ │ │   Seedance · 各 3-5s  │ │ │                                             │
│ │ │ 3 拼成一条 31s        │ │ │                                             │
│ │ │ 预计消耗 ≈ 1,240 ✨   │ │ │                                             │
│ │ │ [ 先只做第1步 ][开始] │ │ │                                             │
│ │ └──────────────────────┘ │ │                                             │
│ └──────────────────────────┘ │                                             │
│                              │                                             │
│ ┌──────────────────────────┐ │                                             │
│ │ ┌──┐┌──┐                 │ │                                             │
│ │ │▣ ││▣ │  ← 参考 chip    │ │                                             │
│ │ └──┘└──┘                 │ │                                             │
│ │ /分镜导演 把第 3 镜改成  │ │                                             │
│ │ 黄昏                     │ │                                             │
│ │ [+][✨]        [自动·质量▾][→]│                                          │
│ └──────────────────────────┘ │                                             │
└──────────────────────────────┴─────────────────────────────────────────────┘
   ←──── 聊天 ~420px ────→        ←────────── 工作面（自适应） ──────────→
```

**三个 tab 的分工**（抄 Runway 的三标签，但把"节点图"换成对我们更便宜的"表"）：

- **画布**：现状不变。单张图、试验、自由摆放。
- **分镜**：一张表。这是新东西，见 5.3。
- **成片**：第一版**只做一个只读的顺序预览 + 一个「拼成一条」按钮**，不做可拖拽时间线（见 5.5 砍掉的东西）。

**计划卡片**（上图聊天里那块）是本提案最重要的一个新组件，形状抄 Runway 的 Ask 档：**每一步写清「做什么 · 用哪个模型 · 什么参数」+ 一个总预估消耗 + 两个按钮（整份开始 / 只做第一步）。** 不要做成纯文字。

### 5.2 参数控件的改法

把现有「生成参数 popover」改成这个形状（合并 Runway 的档位 + Flow 的默认设置 + 可灵的允许集）：

```
┌──────────────────────────────────────────┐
│ 生成偏好                     自动 [●━]   │
├──────────────────────────────────────────┤
│ 花钱之前                                  │
│ ┌──────────────┬──────────────┐          │
│ │ 先问我 ●     │  直接做      │          │  ← 默认「先问我」（跟 Flow）
│ └──────────────┴──────────────┘          │
│ 偏向                                      │
│ ┌────────┬────────┬────────┐             │
│ │  质量  │  速度  │  省钱  │             │  ← 跟 Runway，先不做 Custom
│ └────────┴────────┴────────┘             │
│ ┌───────────────┬───────────────┐        │
│ │     图片      │     视频      │        │
│ └───────────────┴───────────────┘        │
│ 比例  [智能][16:9][9:16][1:1][4:3][21:9] │  ← 第一档「智能」且默认
│ 每次  [ x1 ][ x2 ●][ x3 ][ x4 ]          │
│ 可用模型（Agent 在其中挑）                │  ← 跟可灵：多选允许集
│  ☑ Seedance 2.5      ☑ Grok Imagine 1.5  │
│  ☑ Veo 3.1           ☐ Agnes 2.5 🔒付费  │
│                        [ 设为以后默认 ]   │
└──────────────────────────────────────────┘
```

**不要**在这里放时长和镜数。时长归分镜表的每一行，镜数归 Agent。

### 5.3 「分镜」这个新工作面

对应仓库内 `agent-native-video-mode.md` 的**候选 A（对话 + 一份可改的分镜文档）**。本次外部调研给它补了三条支持：

- 四家里有分镜产物的（即梦九列表 / Runway Shot 节点 / Flow 场景 / 可灵分镜图网格）**全都把它做成了一个可回看、可逐项操作的东西**，没有一家只留在聊天里。
- Flow 的 **asset stack + History（保留每版与当时的 prompt）** 说明"改一镜"必须能回溯。
- 可灵的 **`[@元素名]`** 说明分镜的每一行需要能挂角色引用。

**一行 = 一镜**，字段（比现在的七个文本框少，且每个都有明确归属）：

| 字段 | 谁写 | 界面 |
| --- | --- | --- |
| 镜号 | 系统 | 行号，可拖拽重排 |
| 首帧图 | 工具产物 | 缩略图，点开看变体 |
| 画面 | Agent，可人改 | 一行文本 |
| 台词 / 旁白 | Agent，可人改 | 一行文本（可空） |
| 运镜 | Agent，可人改 | 自由文本（四家都是自由文本，不要做成枚举） |
| 时长 | **Agent 定，人可改** | 秒数输入；表头显示合计 |
| 引用角色 | 人或 Agent | `@角色` chip 列 |
| 状态 | 系统 | 待办 / 出图中 / 已出图 / 出片中 / 已出片 / 失败 |

行悬浮操作：`重出这一镜` / `改一句`（打开一个只带这一镜上下文的小输入框）/ `延长` / `设为参考`。

**关键交互：在分镜表里选中第 3 行，然后在聊天里说一句话。** 选中态是 Agent 的隐式上下文 —— 这是 Flow 官方明写的机制（「select multiple assets and let the agent know which media you are referring to」），也是"聊天 + 空间面"相对纯聊天的唯一真正优势。

### 5.4 四条核心用户流程（按步骤写，可直接当原型脚本）

**流程 1 — 一句话到一条片（快乐路径）**
1. 用户在创作模式输入框打一句「做一条 30 秒国风短片，一个盲剑客」，回车。
2. Agent 流式回文字，同时在聊天里渲染一条**进行中的步骤行**（`⟳ 正在想分镜…`），完成后原地改写成 `✓ 已写出 8 镜分镜`（抄 Lovart）。
3. 右侧自动切到 **分镜 tab**，8 行**逐行流式出现**（这是对现在"等 60 秒然后全有或全无"的正面回答）。
4. Agent 发出**计划卡片**：3 步、每步写明模型与参数、总预估消耗、`[只做第 1 步] [开始]`。
5. 用户点 `开始` → 8 行状态依次进入 `出图中`；每张首帧图就位后缩略图填进对应行。
6. 逐镜出片。**这里必须并行**（可灵把并行写进公告；我们现在是 sequential + 一会话一轮，这是要动的地方）。
7. 全部就绪后，Agent 调 `stitch` 工具，成片 tab 出现一条 31s 的视频 + 下载按钮。

**流程 2 — 改一镜**
1. 用户在分镜表点第 3 行（选中），或直接在聊天里打 `@镜3`。
2. 输入「这一镜改成黄昏，机位低一点」。
3. Agent 只改这一行的 `画面` 与 `运镜` 两个字段（表格里那两格**高亮变化**），不碰其他镜。
4. Agent 发一张小计划卡：「重出第 3 镜首帧 + 重出第 3 镜视频，≈ 180 ✨」。
5. 确认后只有第 3 行状态回到 `出图中`。旧版本进这一行的版本抽屉（抄 Flow 的 stack）。

**流程 3 — 建一个角色并在分镜里用**
1. 用户在「我的资产」里点 `+ 新角色`（或在聊天里说「把这张图存成角色，叫阿竹」）。
2. 角色创建面板三条路并列：**描述生成 / 上传 / 从画布里挑**（抄 Flow）。给 6 个原型预设卡降低门槛。
3. 起名字 → 保存。若只给了一张图，提供一个「**自动补多角度**」按钮（抄可灵的 AI 扩视角 + Flow 社区的 Character Persona Generator）。
4. 之后在输入框或分镜表打 `@阿竹`，Agent 在生成时把这个角色的参考图带进请求。
5. **临时参考图也能就地升格**：上传后自动叫 `图1`，悬停给一个"起个名字"的入口，命名后即成为可复用角色（抄 Runway，这条比"先建实体"顺得多）。

**流程 4 — 从一张已有的图/片起手**
1. 用户把画布上一张图拖进输入框，或选中它。
2. 说「基于这个镜头扩一批多角度分镜」（可灵原话）或「让它动起来，8 秒」。
3. Agent 直接干活，不问。—— 这是 OpenAI model guidance 那条「Before asking clarifying questions, complete the work that is already authorized from context」的落地：**素材已经给了，意图已经清楚，就别问。**

### 5.5 第一版需要的组件清单

**必做（没有就跑不起来）**

1. **计划卡片**（聊天内）：步骤列表 + 每步的模型与参数 + 总预估消耗 + `[开始] [只做第一步] [改改再说]`。对应后端要有一个"在花钱前停下"的接缝 —— pi 的 `beforeToolCall` 正是它（`{ block, reason, terminate }`，已装未用）。
2. **步骤行组件**：`⟳ 进行时` → `✓ 完成时`，**原地改写不追加**。
3. **分镜表**（新工作面）：见 5.3。行内编辑、拖拽重排、状态徽标、悬浮操作、选中态。
4. **工作面切换条**：`画布 / 分镜 / 成片` 三个 tab。
5. **生成偏好 popover 改版**：见 5.2。默认「先问我」。
6. **角色实体**：资产库里新增一个类型；创建面板（描述/上传/从画布挑 + 名字 + 预设卡）；`@` 补全里出现;分镜行里的角色 chip。
7. **临时参考图的"起名即持久"入口**。
8. 后端差量（已在 `agent-native-video-mode.md` §4 列出，此处只标与本报告的对应）：视频产物可回读、`extendVideo` / `editVideo` 工具、`stitch` 工具、分镜文档表、**工具并行**。

**值得做，但可以第二版**

9. `/` 技能：先做 3–4 个内置（`/分镜导演`、`/多视角扩镜`、`/电商短片`、`/情绪板`），走 `SKILL.md`。**技能市场不做。**
10. 「智能体指令」面板（抄 Flow）：可叠加、可开关、可挂参考图的项目级常驻指令。
11. 资产版本 stack + History（保留每版与当时的 prompt）。
12. 在某一帧上圈画 + 一句话改视频（抄即梦）。宿主已有遮罩 interject，差一个"按时间戳取帧"。

### 5.6 第一版**故意不做**的东西（写下来是为了不被诱惑）

| 不做 | 理由 |
| --- | --- |
| **可拖拽的多轨时间线** | Runway 那套（Split/Trim/音量/加轨/播放头/缩放/Fit）是一个独立产品的工作量。可灵干脆不做也活得很好，即梦把它做成一个 Agent 工具 `video_editor`。**第一版：成片 tab 只给顺序预览 + 「拼成一条」+ 下载。** |
| **技能市场（作者/赞/使用量/添加）** | 即梦那套是生态运营，不是交互设计。先有 3 个内置技能跑通再说。 |
| **工具/小应用构建器（Flow Tools）** | 同上，且 Flow 自己把它锁在付费档后面。 |
| **节点图** | Runway 的 Workflows 是给"可复用流水线"用的，我们连一次性流程都还没跑顺。分镜用表，不用图。 |
| **音色 / 配音 / 音乐** | 可灵、Flow、Runway 都有，但这是另一条上游链路。分镜表里的"台词"字段先只作为画面提示词的一部分。 |
| **Custom 自然语言偏好（Runway 的第四档）** | 先做 质量/速度/省钱 三档。Custom 要配 `@模型` 补全，成本不低而收益窄。 |
| **实时对话数字人** | Runway Characters 那条线与我们无关。 |
| **多视角/三视图自动生成** | 想做，但它依赖角色实体先落地。放在角色功能的第二步。 |

### 5.7 一句话总结给 owner

**把「导演台」换成「创作模式里多一个分镜工作面 + 一张会在花钱前停下来给你看的计划卡」，参数收进一颗默认自动的小控件，角色升格成一等资产用 `@` 指代 —— 这三件事就是四家的公约数。时间线和技能市场是后面的事，第一版别碰。**


---

## 六、附录

### 6.1 来源清单（全部 2026-09-17 读取）

**即梦 Jimeng**（🟢 实测，未登录）
- `https://jimeng.jianying.com/ai-tool/home`（首页、生成/画布 tab、创作类型菜单、生成偏好 popover、技能 chips）
- `https://jimeng.jianying.com/ai-tool/explore`（探索 > 技能 tab，技能市场与全部技能描述原文）
- `https://jimeng.jianying.com/ai-tool/work-detail/7682233986071973144`（作品详情页 →「查看创作过程」→ 只读画布）
- 登录弹窗内的官方产品宣传轮播（🟡 Seedance 2.5 视频编辑、Seedream 5.0 Pro 图片批注）
- ❌ `jimeng.jianying.com/ai-tool/help`、`/help` 均 302 回首页 —— **即梦没有公开帮助中心**

**可灵 Kling**
- `https://klingai.com/app/`（🟢 首页、左 rail、工具卡片、banner）
- `https://klingai.com/canvas/home?projectType=personal`（🟢 灵动画布首页、模板 chip 下拉、样例 brief 全文、模型 popover）
- `https://klingai.com/app/omni/new`（🟢 硬登录墙）
- `https://klingai.com/release-note/release-history`（🔵 更新公告索引）
- `https://klingai.com/release-note/release-notes/s568cuscq1`（🔵🟡 2026-01-29《灵动画布-Agent模式重磅上线》全文 + 官方配图）
- `https://klingai.com/release-note/release-notes/whbvu8hsip`（🔵🟡 2026-01-31《可灵视频 3.0 全量开放》全文 + 自定义分镜面板配图）
- `https://klingai.com/release-note/release-notes/Kling_3_Turbo`（🔵 2026-06-17《3.0 Turbo 与 Omni 视频编辑升级》）
- `https://klingai.com/quickstart`（🔵 官方指南索引）
- `https://klingai.com/quickstart/klingai-video-3-model-user-guide`（🔵 Multi-Shot / Custom Multi-Shot、元素绑定）
- `https://klingai.com/quickstart/klingai-element-library-3-user-guide`（🔵 Element Library 全文）

**Runway**
- `https://runway.com/product/agent`（🟢 产品页与 FAQ）
- `https://runway.com/product/characters`（🟢 —— 用于**排除**这条线）
- `https://help.runwayml.com/hc/en-us`（🔵 帮助中心首页与目录）
- `https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent`（🔵🟡 主文 + 5 张官方截图）
- `https://help.runwayml.com/hc/en-us/articles/53907039424915-Using-Agent-Skills`（🔵🟡 + 3 张）
- `https://help.runwayml.com/hc/en-us/articles/53645211363475-Building-and-running-Workflows-with-Agent`（🔵🟡 + 2 张）
- `https://help.runwayml.com/hc/en-us/articles/54338359132819-Setting-custom-generation-preferences-in-Runway-Agent`（🔵🟡 + 1 张）
- `https://help.runwayml.com/hc/en-us/articles/24298206897043-Navigating-Runway`（🔵 IA）
- `https://help.runwayml.com/hc/en-us/articles/52963720640275-Using-reference-media-to-guide-your-generations`（🔵 References 机制）

**Google Flow**
- `https://flow.google.com/`（🟢 **登录态实测**：首页、项目工作台、角色创建、工具三 tab、智能体设置、智能体指令、`@` 资源选择器、会话历史）
- `https://support.google.com/flow/?hl=en`（🔵 帮助中心目录）
- `.../answer/17093911` Use the Google Flow Agent（🔵）
- `.../answer/16353334` Create videos in Google Flow（🔵）
- `.../answer/16935718` Edit videos & build scenes in Google Flow（🔵 Scenebuilder / Extend / Omni Flash 编辑）
- `.../answer/...` Create & edit images in Google Flow（🔵）
- `.../answer/...` Manage your Google Flow projects, assets & collections（🔵 角色创建、collections、项目设置）

**次要**
- `https://hailuoai.video/zh-Intl`（🟢 表单态 / Agent 态 / 工具菜单）
- `https://www.lovart.ai/zh`（🟢 营销页含产品实录）
- `https://ltx.studio/`（⚪ 导航超时，未取得任何观察）

**明确排除**
- 任何第三方评测、榜单、YouTube 讲解 —— 本报告未使用。
- Sora —— 按要求不覆盖。

### 6.2 截图清单（70 张，未入库）

截图含厂商官方产品图，不进公开仓库；原件存于 owner 本机 `~/Projects/Self/_research-assets/video-teardown-2026-09-17/`。下表文件名均指该目录。

`🟢` = 我在浏览器里拍的；`🟡` = 从厂商官方页面下载的官方产品截图（已缩放）。

**即梦（17）**
`jimeng-home.png` 🟢 首页全貌 ·
`jimeng-agent-mode-dropdown.png` 🟢 创作类型菜单（Agent 模式✓/图片/视频/音乐/音频/数字人/动作模仿）·
`jimeng-auto-dropdown.png` 🟢 生成偏好 popover（图片）·
`jimeng-genpref-video.png` 🟢 生成偏好（视频）·
`jimeng-slash-menu.png` 🟢 打 `/` 触发登录墙 + 官方轮播 ·
`jimeng-canvas-toggle.png` 🟢 画布 tab（新建画布 + 两个模板 + `@添加主体` placeholder）·
`jimeng-skills-panel.png` 🟢 技能页加载态 ·
`jimeng-skills-gallery.png` 🟢 **技能市场**（分类 + 卡片 + 添加 + 作者赞数）·
`jimeng-subject.png` 🟢 主体（登录墙，弹回首页）·
`jimeng-view-process.png` 🟢 作品详情播放器 ·
`jimeng-creation-process.png` 🟢 只读画布（命名 frame + 节点 + 只读横幅）·
`jimeng-canvas-fit.png` 🟢 **整块画布 8% 全貌** ·
`jimeng-canvas-zoomin.png` 🟢 **参考图节点 → 连线 → `part 02-N` 视频节点** ·
`jimeng-canvas-node-detail.png` 🟢 视频节点 103%（内联播放 00:15）·
`jimeng-canvas-tool2.png` 🟢 缩略地图 ·
`jimeng-login-carousel-2/3/4.png` 🟡 官方：Seedance 2.5 首发 / **视频帧标注编辑** / **Seedream 5.0 图片批注**

**可灵（16）**
`kling-app-home.png` 🟢 app 首页（rail + 工具卡 + MCP banner）·
`kling-canvas-home.png` 🟢 灵动画布首页 ·
`kling-canvas-template-story.png` 🟢 模板 chip 下拉出具名样例 ·
`kling-canvas-sample-filled.png` 🟢 样例 brief 填入（`图1`/`图2` chip）·
`kling-canvas-composer-hex.png` 🟢 **选择模型 popover（自动开关 + 多选）** ·
`kling-canvas-model-video.png` 🟢 视频模型允许集（含 VIP 灰档）·
`kling-omni.png` 🟢 Omni 硬登录墙 ·
`kling-release-history.png` 🔵 更新公告索引 ·
`kling-release-agent-canvas.png` 🔵 Agent 画布公告 ·
`kling-element-library-guide.png` 🔵 Element Library 指南 ·
`kling-official-custom-shot-panel.png` 🟡 **Prompt | 参考主体图 | 生成结果 三栏 + `@小小书童` 四图主体** ·
`kling-official-subject-multiangle.png` 🟡 主体多角度 ·
`kling-official-subject-scene-assets.png` 🟡 步骤1 输出：主体 + 场景 ·
`kling-official-cast-and-sets.png` 🟡 **角色白底立绘一排 + 空场景板一排** ·
`kling-official-character-turnarounds.png` 🟡 **角色三视图 turnaround** ·
`kling-official-storyboard-grid-16shots.png` / `-20shots.png` 🟡 分镜图网格 ·
`kling-official-multiview-9angles.png` 🟡 单镜扩 9 角度

**Runway（14）**
`runway-agent-landing.png` 🟢 产品页 ·
`runway-characters.png` 🟢 Characters=数字人（排除用）·
`runway-help-home.png` / `runway-help-agent.png` 🔵 帮助中心 ·
`runway-agent-home-settings-popover.png` 🟡 **Agent 首页 + Ask/Auto + Speed/Cost/Quality + Set as default + 最近会话网格** ·
`runway-agent-skills-picker.png` 🟡 **`/Commercial` 内联 token + Starters/Media + Skills 卡片网格** ·
`runway-agent-create-skill-empty.png` / `-filled.png` 🟡 **Create Skill 弹窗（Name/Description/Instructions 5000/Sharing）** ·
`runway-agent-custom-preferences.png` 🟡 **Custom 偏好 + `@ Add`** ·
`runway-agent-session-workflow-layout.png` 🟡 **会话全貌：顶栏 + Workflows/Generations/Cuts + 节点图 + 右侧聊天** ·
`runway-agent-session-generations-tab.png` 🟡 Generations 瀑布 ·
`runway-agent-final-cut-timeline.png` 🟡 **Final Cut 时间线（03:07 成片）** ·
`runway-agent-timeline-annotated.png` 🟡 时间线功能标注 ·
`runway-agent-timeline-tracks.png` 🟡 双轨 ·
`runway-agent-workflow-toolbar.png` 🟡 工作流工具条

**Flow（15，全部 🟢 登录态实测）**
`flow-landing.png` 首次进入的同意弹窗（两个营销勾选框**保持未勾**）·
`flow-home.png` 首页 ·
`flow-project.png` **项目工作台全貌（左 rail / 中网格 / 右 Agent）** ·
`flow-composer-tune.png` **智能体设置（生成前先确认=始终）** ·
`flow-video-models.png` 视频模型下拉（Omni 1.1 Flash / Veo 3.1 ×3）·
`flow-composer-article.png` / `flow-agent-instructions.png` **智能体指令（可叠加、可开关、可挂参考图）** ·
`flow-composer-at.png` **`@` 资源选择器（全部/图片/视频/语音/角色/虚拟形象/上传）** ·
`flow-composer-plus.png` `+` 同一选择器 ·
`flow-session-menu.png` 会话历史记录 ·
`flow-characters.png` **新角色（6 原型预设 + 描述/上传/从项目添加）** ·
`flow-tools.png` / `flow-tools-community.png` / `flow-tools-templates.png` 工具三 tab ·
`flow-help-home.png` 🔵 帮助中心

**次要（4）**
`hailuo-home.png` 🟢 表单态（含 `5s` 与 `💎60`）·
`hailuo-agent.png` 🟢 Agent 态（`自动`/`自动比例`/`工具`）·
`hailuo-agent-tools.png` 🟢 **工具菜单（显式指定 Agent 工具）** ·
`lovart-home.png` 🟢 聊天左 + 画布右 + 步骤行

### 6.3 未能核实的事项（不推断，留给下一轮）

**登录墙后，未能直接观察：**

| 产品 | 缺什么 | 价值 |
| --- | --- | --- |
| **可灵 灵动画布** | 项目内部全貌：对话面板与画布如何并置、Agent 消息卡形态、分镜图节点长什么样、生成中的占位与进度、批量框选的交互、成本确认 | ★★★ **最高。** 它是最接近我们目标形态的产品，而我们只有公告文字和官方成品图 |
| **可灵 视频生成表单** | `Multi-Shot` 开关与 `自定义分镜` 面板的真实控件（镜数怎么加、每镜时长怎么填） | ★★★ 直接对应我们分镜表的字段设计 |
| **即梦 Agent 会话** | 消息卡、计划展示、澄清问题的 UI 形状、进度、成本确认、`/` 技能触发后的样子 | ★★★ 即梦是四家里技能系统最成熟的 |
| **即梦 主体** | 创建流程、支持几张图、是否绑音色、管理界面 | ★★ |
| **即梦 可编辑画布** | 工具箱、右键菜单、节点如何生成节点、连线是自动还是手连 | ★★ |
| **可灵 Omni** | 多模态编辑器的工作台布局 | ★★ |
| **Runway Agent 实机** | 生成中的占位/进度形态（官方截图里都是完成态）；Ask 档的计划卡片实际长什么样 | ★★ 计划卡片是我们要抄的核心组件，只有文字描述没有图 |
| **Flow 生成中的形态** | 占位、进度、确认对话框的实际样子（本次只浏览未生成） | ★★ **代价最低**：owner 已登录，跑一次最便宜的图片生成即可拿到 |
| **LTX Studio** | 全部 | ★ 导航超时，本次零观察 |

**官方未说明（查过，找不到）：**
- 即梦：成本确认机制；Agent 是否有生成前确认设置；拼接是否有用户界面
- 可灵：灵动画布是否有生成前确认；Agent 对话是否计费；进度呈现
- Runway：Agent 视频的最长时长（FAQ 标题存在但答案为折叠项，本次未能展开）
- Flow：字幕能力（只见到「Add a text overlay」作为编辑指令的一个例子）；`场景` 资产与 Scenebuilder 的确切关系

**本次主动排除的误解：**
- ❌ 「Runway Characters 是角色一致性功能」 —— **错**。它是实时对话数字人。Runway 的角色一致性靠 **命名过的 saved References**。
- ❌ 「Flow 有 Jump To / Scenebuilder 是主界面」 —— Flow 当前版本（2026-09-17 实测）的主界面是**项目资产库 + 右侧 Agent 面板**，Scenebuilder 是资产上的一个动作（`More ⋮ → Add to Scene`）。`Jump To` 在本次读到的官方帮助文档里**未出现**，可能已改名或下线；不采用。
