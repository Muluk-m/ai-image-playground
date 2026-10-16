---
version: alpha
name: Muvloom Studio
description: 幕芽 Muvloom 创作工作台（apps/web）的设计体系。暗色为默认主题；值以暗色为准，亮色取值见 Colors 一节与 src/styles/theme.css。
colors:
  primary: "#c1eb94"
  on-primary: "#161f14"
  background: "#111311"
  surface: "#181b18"
  surface-raised: "#252825"
  accent: "#2e352c"
  on-surface: "#f6f6f4"
  on-surface-muted: "#a6a9a2"
  border: "#323531"
  destructive: "#e96363"
  success: "#75d799"
  warning: "#f6c155"
  on-warning: "#2a1c07"
  scrim: "#000000"
  on-media: "#ffffff"
  transparency-grid-dark: "#666666"
  transparency-grid-light: "#737373"
  canvas-annotation: "#159cf6"
  brand-google: "#4285f4"
  creation-selected-start: "#d9ffba"
  creation-selected-middle: "#93e46f"
  creation-selected-end: "#63c455"
  creation-selected-foreground: "#0b1a08"
  membership-free: "#9aa4a0"
  membership-basic: "#8fe06a"
  membership-plus: "#4fd2e8"
  membership-max: "#f2c75c"
  light-background: "#f8f8f7"
  light-surface: "#ffffff"
  light-primary: "#436c28"
  light-on-primary: "#ffffff"
  light-on-surface: "#1d201d"
  light-on-surface-muted: "#6c7269"
  light-border: "#d9dbd6"
typography:
  display:
    fontFamily: HarmonyOS Sans SC
    fontSize: 38px
    fontWeight: 600
    lineHeight: 1.2
  headline:
    fontFamily: HarmonyOS Sans SC
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.25
  title-lg:
    fontFamily: HarmonyOS Sans SC
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.35
  title-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
  title-sm:
    fontFamily: HarmonyOS Sans SC
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.4
  body-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: HarmonyOS Sans SC
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: HarmonyOS Sans SC
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: HarmonyOS Sans SC
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
  mono-sm:
    fontFamily: Maple Mono
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
rounded:
  xs: 4px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 12px
  2xl: 16px
  3xl: 24px
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
  page-gutter: 24px
  page-header-height: 56px
  sidebar-width: 264px
  control-sm: 28px
  control-md: 32px
  control-lg: 36px
  control-xl: 40px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-lg}"
    padding: 16px
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-lg}"
    padding: 16px
  button-ghost:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-md}"
    padding: 12px
  button-ghost-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.on-surface}"
  icon-button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-muted}"
    rounded: "{rounded.md}"
    size: "{spacing.control-md}"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    height: "{spacing.control-lg}"
    padding: 12px
  param-chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.xl}"
    height: "{spacing.control-xl}"
    padding: 12px
  segmented-tab:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    height: "{spacing.control-sm}"
    padding: 12px
  segmented-tab-active:
    backgroundColor: "color-mix(in srgb, {colors.primary} 15%, transparent)"
    textColor: "{colors.primary}"
  page-header:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface}"
    typography: "{typography.title-sm}"
    height: "{spacing.page-header-height}"
    padding: "{spacing.page-gutter}"
  section-header:
    textColor: "{colors.on-surface}"
    typography: "{typography.title-sm}"
  section-header-link:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.2xl}"
    padding: 16px
  popover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: 6px
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.title-md}"
    rounded: "{rounded.3xl}"
    padding: 24px
  sidebar-item:
    backgroundColor: "{colors.background}"
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xl}"
    height: "{spacing.control-lg}"
  sidebar-item-active:
    backgroundColor: "color-mix(in srgb, {colors.primary} 15%, transparent)"
    textColor: "{colors.primary}"
  media-badge:
    backgroundColor: "{colors.scrim}"
    textColor: "{colors.on-media}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
    padding: 6px
  status-success:
    textColor: "{colors.success}"
  status-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.on-warning}"
  status-destructive:
    textColor: "{colors.destructive}"
  empty-state:
    textColor: "{colors.on-surface-muted}"
    typography: "{typography.body-sm}"
  surface-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-on-surface}"
  surface-light-page:
    backgroundColor: "{colors.light-background}"
    textColor: "{colors.light-on-surface-muted}"
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
  divider-light:
    backgroundColor: "{colors.light-border}"
  divider:
    backgroundColor: "{colors.border}"
---

# Muvloom Studio 设计体系

本文件是 `apps/web` 设计规则的唯一入口，也是视觉决定的唯一事实源。数值写在 frontmatter；
`src/styles/theme.css` 与 `tailwind.config.js` 是它的实现，二者冲突时以本文件为准并回写代码。
组件用法、分层和图标不在这里复制，从下面的目录进去。

## 目录 / 入口

- [组件用法](./docs/design-system/components.md)：`components/ui/` 原语（Button、Input、Select、Popover 等）的变体、尺寸与禁忌。
- [分层与选型](./docs/design-system/README.md)：ui / patterns / 业务三层怎么依赖，「我要做 X → 用哪个」，以及新增组件的流程。
- [组合件与页面配方](./docs/design-system/patterns.md)：`components/patterns/` 组合件，以及页面骨架、对话框、表单、反馈、空态的配方。
- [怎么加图标](./docs/design-system/icons.md)：`<Icon>` 的用法、现有语义名，以及新增图标与自绘图标的流程。
- Figma 底稿：TODO（URL 待补）。界面定稿的存档位置。

## 产品与交互规则

色值、字号、间距等 token 留在 frontmatter 与代码里，本节不重复。

- **风格**：深色、克制、有高级感；绿色只做点缀；保留点阵背景和光晕；不用 emoji 图标。
- **主按钮**：主按钮必须带强调色。
- **单一入口**：每个功能只有一个入口：不重复入口，不多套层级。图上悬停工具栏只放针对该图的编辑操作，不和下方操作栏（复制、重新生成、下载、更多）重复。
- **未上线与内部标识**：未上线的功能隐藏，不展示；不展示内部用户 ID。
- **图标**：图标只用设计系统里的。见上面的图标文档，不另找图形。
- **悬停提示**：用途不明显的控件必须有悬停提示，最好显示当前值（如「生成 4 张」）。
- **登录前后一致**：登录和未登录状态下的同类项（主题、设置、条款）用同一个组件和样式。主题切换是纯图标三段（深色 / 跟随系统 / 浅色）。
- **输入框参数**：输入框参数收进一个组合胶囊，每段配和面板对应的图标，点开是统一设置面板；空间不足时只显示图标。张数只在图片生成模式出现，Agent 模式由 Agent 决定张数、出图还是出视频。
- **批量结果**：批量结果排成一横排，生成中、排队中、已完成的图块尺寸一致，不互相重叠。
- **定稿存档**：定稿必须存档到 Figma 底稿（链接见「目录 / 入口」，URL 待补）。

## Overview

幕芽是一个以图片与视频为主角的创作工作台：界面要退后，作品要站到前面。基调是**暗色、
低饱和的墨绿灰**，只有一种强调色——芽绿——标记「下一步该按哪里」。信息密度偏高（参数、
历史、画布工具都要在一屏里），所以靠统一的字阶、控件高度和圆角建立秩序，而不是靠留白或
装饰。首页 hero 允许出现品牌表情（光晕、渐变强调字）。工作区保持素净；节点画布的 AI 入口按产品要求使用品牌芽绿标识、墨绿渐变与细高光，限定在单个 40px 胶囊内，悬停轻微浮起，遵守减少动态效果设置。

首页创作路径切换保留圆形胶囊：选中项使用 `creation-selected-*` 芽绿渐变和深色字，未选中项悬停只提亮文字，不能出现第二个选中块。右上角账户区不加整体胶囊或描边；积分按钮采用 28px 高的扁平小圆角，头像保持圆形，菜单内部使用标准控件圆角。

PC 端（≥768px）的骨架固定为：左侧 208px 导航栏 + 右侧内容区，两者同底色，靠导航栏右侧 1px `border` 分界，与页头底部分割线相接。内容区没有全局顶栏，
每个页面自带一条 56px 的页头；账号簇浮在右上角，页头按它的实际宽度让位。

## Colors

色板全部是 shadcn 语义 token（`--background`、`--card`、`--primary` …），组件不持有自己的调色板。

- **Primary 芽绿（暗 #c1eb94 / 亮 #436c28）**：主要操作、选中态、焦点环。必须与
  `on-primary` 成对使用；同一视图里实心芽绿按钮只有一个。
- **Background / Surface / Surface-raised**：三级墨绿灰构成层次——页面底、卡片与弹层、
  卡片内的凹槽与 hover 底。层级靠明度差，不靠阴影。
- **Accent**：一般轻强调表面；页签与侧栏当前项统一使用 `primary/15` 浅底与 `text-primary`，不使用灰底灰字。
- **On-surface / On-surface-muted**：正文与次要文字只有这两档；禁止再用 `/70`、`/60`
  透明度造第三档灰字。
- **状态色 success / warning / destructive**：只表达结果与风险，不作装饰。不要用
  `amber-*`、`red-*`、`emerald-*` 调色板类代替。
- **Scrim / On-media**：盖在图片、视频上的角标与遮罩固定用黑底白字，不随主题变；
  不透明度只用两档：角标 55%、全屏遮罩 70%。画笔色、二维码白底同样不随主题变。
- **Transparency-grid-dark / light**：透明图预览的两档中性棋盘灰，固定于主题之外，让纯黑与纯白
  的透明素材都能辨认；不用于页面、卡片或文字。
- **Canvas-annotation**：区域编辑框与其编号使用的固定蓝色，与画布标注图层保持一致，不作界面强调色。
- **Brand-google**：登录提供商 Google 标识的品牌蓝，只用于该标识。
- **Membership-free / basic / plus / max**：会员等级的身份色，只用于等级徽标与对应套餐。
  暗色保留灰绿、芽绿、青、金四档；亮色分别使用 muted-foreground、primary、深青与 warning，
  不把等级色用于普通按钮或成功、失败状态。

## Typography

正文与界面用 HarmonyOS Sans SC（中文优先），英文展示字回落系统 Display 字体，数值与尺寸
标签用 Maple Mono。字阶只有十档：

| token | 字号 | Tailwind 类 | 用途 |
|---|---|---|---|
| display | 38 | `text-display` | 首页 hero 标题 |
| headline | 28 | `text-headline` | 空画布、落地页的主标题 |
| title-lg | 20 | `text-xl` | 对话框标题 |
| title-md | 16 | `text-base` | 面板标题、空态主句 |
| title-sm | 15 | `text-title` | 页头标题、区块标题、卡片标题 |
| body-md | 14 | `text-sm` | 输入框、表单、正文 |
| body-sm | 13 | `text-body-sm` | 列表行、侧栏、页签、说明 |
| label-md | 12 | `text-xs` | 按钮、chip、元数据 |
| label-sm | 11 | `text-label-sm` | 计数、次要标注 |
| mono-sm | 11 | `font-mono text-label-sm` | 媒体角标上的比例与尺寸 |

手写 CSS 用 `theme('fontSize.body-sm')` 等引用同一份 Tailwind 字阶；不另建字号表。

`text-lg`、`text-2xl`、`text-3xl` 等不在字阶里，不要用。

小于 11px 的字不出现。唯一例外是 56px 以内缩略图上的「MASK」、序号这类角标，允许 7–9px，
且只能贴在缩略图上。字重只用 400 / 500 / 600 三档。

## Layout

- 4px 基础网格，常用档位 4 / 8 / 12 / 16 / 24 / 32 / 48。
- **布局层**（页面、区块、卡片之间与卡片内边距）只用上面的档位。**控件内部**（按钮、chip、
  输入框、列表行的内边距与图文间距）允许 2px 步进（`px-2.5`、`gap-1.5`、`py-0.5`），这是
  shadcn 组件本身的密度。任何地方都不写 `p-[6px]` 这类任意值。
- **页头**：高 56px、底部 1px 分割线、左右内边距 24px；左侧标题（title-sm），其后是页签，
  右侧是搜索与主操作。页头高度固定，不随内容撑高。
- **内容区**：页头以下整块滚动，内边距 24px；浏览类页面（探索、资产、工具箱）内容左对齐、
  铺满宽度。只有首页的 hero 居中，最大宽度 1152px。
- **页面高度**：内容区占满视口（`100dvh`），不得再为已删除的全局顶栏预留 3.5rem。
- **控件高度**：28 / 32 / 36 / 40 四档。页签与小按钮 28，图标按钮与 ghost 按钮 32，
  输入框与常规按钮 36，首页创作输入框里的模型与参数 chip 40，侧栏宽度（380px）的输入框里 32。
  同一行的控件高度一致。

## Elevation & Depth

层次靠**明度分层 + 1px 描边**：background → surface → surface-raised。浮层外缘的发丝线
用 `ring-1 ring-hairline`（亮色 5% 黑、暗色 10% 白），不再写 `ring-black/5 dark:ring-white/10`。

阴影只给真正浮在内容之上的东西，只有两档：`shadow-popover`（下拉、菜单、Toast、批量操作条）
与 `shadow-dialog`（对话框）。卡片 hover 时最多加 `shadow-lg`，静止的卡片不带阴影。首页 hero
的光晕是唯一的装饰性深度。

层级（z-index）只用这张表，新浮层先找位置再写数：

| 层 | 值 | 谁 |
|---|---|---|
| 页面内 | 10–40 | 吸顶、侧栏、移动导航 |
| 模态 | 50 / 100 / 110 | Overlay 的 modal / raised / alert |
| 画布浮层 | 400–430 | 画布工具条、批量条 |
| 定位浮层 | 600 | Radix Popover |
| 产物审阅 | 1000–1200 | artifact pane 与其上的 Overlay |
| 通知 | 1390 / 1400 | 更新横幅 / Toast |
| 提示 | 1450 | Tooltip |
| 右键菜单 | 1500 | ContextMenu |

## Shapes

圆角跟着「元素大小」走，而不是跟着组件随手挑：

| token | 值 | 用在 |
|---|---|---|
| xs | 4 | 进度条、行内高亮 |
| sm | 6 | 媒体角标、小徽标 |
| md | 8 | 按钮、输入框（shadcn 原语，与 admin 共用）、图标按钮、缩略图 |
| lg | 10 | 卡片内的次级块（= `--radius`） |
| xl | 12 | 参数 chip（40px）、分段控件的轨道、弹层、菜单 |
| 2xl | 16 | 卡片、面板 |
| 3xl | 24 | 对话框、首页创作输入框 |
| full | — | 页签、头像、开关 |

不要用 7 / 9 / 14 / 18 / 20 / 21 / 22px 这类中间值。

## Components

组件怎么分层、何时用哪个、变体与配方，从上面的「目录 / 入口」进到对应文档：
先查「我要做 X → 用哪个」速查表，找不到再按它的流程新增组件，不在业务里手搭控件。

图标统一使用 `Icon` 语义名，来源及规格见目录里的图标文档；
不在业务组件直接引入 lucide 或写 SVG。

下面只记产品专属、不属于任何通用组件的规则。

- **Composer 参数**：产品约束以「产品与交互规则」为准。对话输入框底部是「附件 · 模式 · 一颗参数胶囊 · 生成」。
  模型、画幅、思考深度、张数收进同一颗胶囊，不再另放模型 chip、思考档位或张数步进器。
  胶囊每一段使用和面板里同一行相同的图标。智能体模式读作「模型图标 智能 · 仪表 中等 · 比例」，
  例如「智能 · 中等 · 3:4」；只有画幅为自动时才不显示比例。面板含模型（智能 / 自动选模型）、
  画幅（沿用 `RatioGrid` 的形状宫格：自动 / 1:1 / 3:4 / 4:3 / 16:9）、思考深度和直接出图开关，
  没有张数控件，也不写「张数由 Agent 按需求决定」。
  图片生成模式读作「模型图标 模型名 · 比例 · N 张」，面板里的张数只有 1/2/3/4/6/8。
  点开仍是设置卡片（`components/composer/SettingsPanel.tsx`）：标题 + 关闭、按组排列、
  底部「恢复默认 / 完成」，改动即时生效。画幅用 `RatioGrid`，其余互斥档位用 `SettingsSegmented`，
  开关用 `SettingsToggle`。视频参数仍走 `CanvasVideoParams` 这一个外壳。
  输入框宽度不超过 400px 时胶囊只留图标（模型、思考深度，以及非自动时的比例形状），图标保持完整可辨。
  悬停显示被收起的文字标签。
- **Composer 底栏**：首页、智能创作与画布直接生成统一用 `CreationToolbar` 和 `CreationSend`。
  宽栏和窄栏都按「模式 · 参数胶囊 · 发送」一行排列。宽栏控件高 40px、间隔 8px；
  输入框宽度不超过 520px 时间隔 6px、控件高 32px。选择器按输入框容器宽度响应：大于 600px 显示完整名称，401–600px 创作类型显示短名称，400px 及以下模式收为 52px 的图标加下拉箭头、参数胶囊只留图标；悬停与键盘聚焦显示完整标签，展开菜单始终保留完整名称。触屏控件至少高 44px，
  仍然留在同一行。上传状态和充值入口另占一行，不挤占发送位置；长模型名截断，
  具体模型仍可打开菜单查看。参考图上的移除是 16px 深色角标，不用危险色。
- 展开的参考素材统一使用紧凑缩略条：首页、画布、Agent 输入框的单张缩略图固定 **48 × 64px**，间距 **4px**，添加入口同尺寸；不随容器拉伸，超出横向滚动。图片用 `object-fit: cover`，完整内容通过预览查看。缩略图圆角统一 4px，配低对比度 1px 内描边，内部图片不再叠加圆角；悬浮预览按原图比例贴合显示，不加额外边框或留白；标题到素材条间距 12px，素材条与输入区间距 12px。遮罩入口只占缩略图角落，不用整图蒙层遮住图片，也不与图片预览争抢悬停；展开素材不能压缩书写区，首页输入区桌面至少 96px、窄屏至少 84px。
- **资产 → 素材**：新建入口只在网格第一格（空库、搜索无匹配也保留），打开后提供上传与可用的智能体子路径。卡片封面进入详情；悬停工具栏提供加入参考图、编辑、删除，详情底部只有「加入参考图」使用实心芽绿。资产页折叠侧栏为 64px 图标轨，当前项保持芽绿浅底；顶部默认面板描边图标，悬停或键盘聚焦显示现有品牌芽标，点击展开。画布沉浸导航保持原有行为。

## Do's and Don'ts

- Do：新写样式先查本文件的 token；找不到合适的档位就先改本文件，再写代码。
- Do：同一语义动作用同一个词——「查看全部」，不要再出现「查看全部作品」「查看全部 →」。
- Do：焦点环统一 `focus-visible:ring-2 ring-ring`，用 `focus-visible:` 而不是 `focus:`（文本输入框除外）。
- Do：禁用态统一 `disabled:opacity-50`；按下缩放统一 `active:scale-[0.97]`。
- Do：状态色只用 success / warning / destructive token，不用 emerald / amber / red 调色板类。
- Don't：用 `text-[Npx]`、`rounded-[Npx]` 这类任意值；需要新档位就加 token。
- Don't：给只在触屏上成立的操作写 PC 文案（如「长按缩略图」），按指针类型分别给提示。
- Don't：在界面上解释系统行为；空态最多一句话说明「这里放什么、怎么开始」。
- Don't：给已经显示文字、功能一目了然的按钮、菜单项或标签再加 tooltip / title。约定俗成的纯图标（关闭 X、返回、搜索）不加可见文字，也不加 tooltip；提示只留给用途看不出来的控件。文字被裁成省略号时，只在真正溢出时显示同一段完整可见文字，不要附上模型 id 等内部标识。`aria-label` 等无障碍名称保留，但不因此弹出提示。
- `light-*` 色值是亮色主题的对照组，只经由 `:root:not(.dark)` 生效，不在组件里直接引用。

## 门禁

`pnpm lint` 会跑 `scripts/check-design.ts`，拦下业务代码里的原生控件、直接 import `lucide-react`、
内联 `<svg>`、字符图标、任意字号 / 间距 / 圆角 / 颜色、Tailwind 调色板类、字阶外字号、超出三档的
字重、`/70` 灰字、`focus:` 焦点环，CSS 里写死的颜色与字号，以及 `ui/`、`patterns/` 对业务代码的
依赖（`layer-import`），规则与修法见脚本里的 `DESIGN_RULES`。原生控件与 `focus:` 只在设计系统内部
（`ui/`、`patterns/`）放行。
`components/ui/` 之外 import `@radix-ui/*`、以及任何非 lucide 图标库，由 `biome.json` 的
`noRestrictedImports` 拦截。

- 存量违规按「文件 × 规则」计数记在 `scripts/design-baseline.json`，只许降不许升。修掉存量后
  跑 `pnpm design:baseline` 把计数收紧并一起提交。新增规则时用
  `bun run scripts/check-design.ts --adopt <rule>` 登记它的存量，其他规则不受影响。
- 确属例外（画布热区、第三方挂载点等）在该行行尾或紧邻上方的注释行写
  `design-allow <rule>: 理由`；不要靠改 baseline 放行新代码。

### 纯图标按钮的标签

所有纯图标按钮必须有简短、可本地化的 `aria-label`，说明动作（如“编辑素材”“删除素材”）。用途看不出来的纯图标，鼠标悬停与键盘聚焦都要展示可见标签；不能只给读屏名称。共用 `Button` 只在没有可见文字、且图标不是约定俗成的动作时，把 `aria-label` 显示为 Portal Tooltip，避免被卡片、侧栏或弹窗裁切；已有 `Hint` / `TooltipIconButton` 不重复生成提示。关闭（X）、返回、搜索这类一看就懂的图标按钮不加可见文字，也不加 tooltip，`aria-label` 只留给读屏。禁用的非约定图标按钮仍可悬停查看含义，不能因此变成可点击。

已经写出文字、作用看得懂的控件不加 tooltip。这包括菜单项、带标签的按钮和芯片：不要把可见名称再弹一遍，也不要把模型 id、任务 id、技能 slug 这类内部标识补进提示。调用方显式传入的 `title` 只用于两件事——文字真的被裁成省略号时显示同一段完整文字（名称被收成纯图标时同样显示完整标签），以及控件上看不到的必要原因（例如为什么点不了）。`aria-label` 继续留给读屏，不单独变成悬停提示。

动态按钮的标签必须跟随当前动作更新。组合件必须要求调用方传入标签并透传；仅有 `sr-only` 文本不能代替可见提示。`icon-button-label` 门禁阻止新增无标签的图标按钮，覆盖公开 Web、Admin 与私有 overlay。

## 公共官网与登录

`apps/website` 使用 A 版沉浸式漫画视觉，沿用芽绿和语义色。官网展示字阶单独限定在
`--site-display`（48–102px）、`--site-heading`（30–58px）、`--site-closing`（40–80px），
不改变工作台字阶。品牌视觉采用原画，首屏居中，滚动时收成画框，分镜逐格进入；减少动态效果
设置关闭视差和收框。动画通过单个 requestAnimationFrame 更新，滚动监听为 passive。
登录页与弹框共用真实登录表单，页布局左右分栏，弹框只保留表单。原有 OAuth、注册、验证码
与登录后待发送恢复流程继续共用；官网示例入口不提交任何示例消息。
