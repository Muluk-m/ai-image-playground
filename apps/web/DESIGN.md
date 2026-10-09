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
  sidebar-width: 208px
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
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-surface}"
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
    backgroundColor: "{colors.accent}"
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

本文件是 `apps/web` 视觉决定的唯一事实源。数值写在 frontmatter；`src/styles/theme.css`
与 `tailwind.config.js` 是它的实现，二者冲突时以本文件为准并回写代码。

## Overview

幕芽是一个以图片与视频为主角的创作工作台：界面要退后，作品要站到前面。基调是**暗色、
低饱和的墨绿灰**，只有一种强调色——芽绿——标记「下一步该按哪里」。信息密度偏高（参数、
历史、画布工具都要在一屏里），所以靠统一的字阶、控件高度和圆角建立秩序，而不是靠留白或
装饰。首页 hero 是唯一允许出现品牌表情（光晕、渐变强调字）的地方，工作区一律素净。

PC 端（≥768px）的骨架固定为：左侧 208px 导航栏 + 右侧内容区。内容区没有全局顶栏，
每个页面自带一条 56px 的页头；账号簇浮在右上角，页头按它的实际宽度让位。

## Colors

色板全部是 shadcn 语义 token（`--background`、`--card`、`--primary` …），组件不持有自己的调色板。

- **Primary 芽绿（暗 #c1eb94 / 亮 #436c28）**：主要操作、选中态、焦点环。必须与
  `on-primary` 成对使用；同一视图里实心芽绿按钮只有一个。
- **Background / Surface / Surface-raised**：三级墨绿灰构成层次——页面底、卡片与弹层、
  卡片内的凹槽与 hover 底。层级靠明度差，不靠阴影。
- **Accent**：选中但不是「主操作」的状态（页签、侧栏当前项），比 surface-raised 略偏绿。
- **On-surface / On-surface-muted**：正文与次要文字只有这两档；禁止再用 `/70`、`/60`
  透明度造第三档灰字。
- **状态色 success / warning / destructive**：只表达结果与风险，不作装饰。不要用
  `amber-*`、`red-*`、`emerald-*` 调色板类代替。
- **Scrim / On-media**：盖在图片、视频上的角标与遮罩固定用黑底白字，不随主题变；
  不透明度只用两档：角标 55%、全屏遮罩 70%。画笔色、二维码白底同样不随主题变。

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

- **基础组件只从 `components/ui/` 取**（shadcn new-york，Radix 原语只在这里封装一次）。
  业务代码不写原生 `<button>`、`<input>`、`<select>`、`<textarea>`、`<dialog>`，也不直接 import
  `@radix-ui/*`；缺什么组件就先按 shadcn 加进 `components/ui/`，再在业务里组合。现有清单：
  Button、Input、Textarea、Label、Checkbox、Select、Slider、Popover、Sheet。
- **Button**：只用 `components/ui/button.tsx` 的 variant（default / outline / ghost /
  destructive）与 size；不要在业务里手写一套 `rounded-xl border px-3.5 py-2.5` 的按钮。
- **PageHeader**：所有浏览页共用一个组件，固定 56px，右侧按账号簇宽度让位。
- **SectionHeader**：标题 title-sm + 右侧「查看全部」链接（body-sm、muted、lucide 箭头），
  链接文字与下方网格右边缘对齐。
- **SegmentedTabs**：页内切换（资产页签、探索的模型筛选）统一 28px 高的胶囊页签，
  选中态 accent 底。
- **SearchField**：带放大镜图标的 36px 输入框，宽 280px。
- **Composer 参数**：每个创作输入框底部只有「附件 · 模型 chip · 参数摘要 chip · 生成」。
  模型单独一个 chip；比例、分辨率、数量、质量、格式等全部收进摘要 chip 点开的设置卡片
  （`components/composer/SettingsPanel.tsx`）：标题 + 关闭、按组排列、底部「恢复默认 / 完成」，
  改动即时生效。摘要只写画幅与张数（如「16:9 · 2K · 1 张」），其余参数偏离默认时 chip 右上角亮
  一个点。卡片里的互斥档位一律用 `SettingsSegmented`（比例用 `RatioGrid`），开关用
  `SettingsToggle`。图片（`ParamControls`）与视频（`CanvasVideoParams`）共用这一个外壳，
  不要再在输入框里平铺一排参数 chip。
- **EmptyState**：一枚 24px 线性图标 + 一句 body-sm 说明 + 可选一个按钮，在内容区上部居中。
- **图标**：一律 lucide，自定义图标集中放在 `components/icons.tsx`（或 `*Icons.tsx` 图标模块），
  业务组件里不写内联 `<svg>`；`+ − ＋ → ↗ ×` 这类文字字符不能当图标用。
  图标尺寸跟控件走：28px 控件配 14px 图标，32–36px 配 16px。

## Do's and Don'ts

- Do：新写样式先查本文件的 token；找不到合适的档位就先改本文件，再写代码。
- Do：同一语义动作用同一个词——「查看全部」，不要再出现「查看全部作品」「查看全部 →」。
- Do：焦点环统一 `focus-visible:ring-2 ring-ring`，用 `focus-visible:` 而不是 `focus:`（文本输入框除外）。
- Do：禁用态统一 `disabled:opacity-50`；按下缩放统一 `active:scale-[0.97]`。
- Do：状态色只用 success / warning / destructive token，不用 emerald / amber / red 调色板类。
- Don't：用 `text-[Npx]`、`rounded-[Npx]` 这类任意值；需要新档位就加 token。
- Don't：给只在触屏上成立的操作写 PC 文案（如「长按缩略图」），按指针类型分别给提示。
- Don't：在界面上解释系统行为；空态最多一句话说明「这里放什么、怎么开始」。
- `light-*` 色值是亮色主题的对照组，只经由 `:root:not(.dark)` 生效，不在组件里直接引用。

## 门禁

`pnpm lint` 会跑 `scripts/check-design.ts`，拦下业务代码里的原生控件、内联 `<svg>`、字符图标、
任意字号 / 间距 / 圆角 / 颜色、Tailwind 调色板类、字阶外字号、超出三档的字重、`/70` 灰字、
`focus:` 焦点环、Radix 直引，以及 CSS 里写死的颜色与字号。规则与修法见脚本里的 `DESIGN_RULES`。

- 存量违规按「文件 × 规则」计数记在 `scripts/design-baseline.json`，只许降不许升。修掉存量后
  跑 `pnpm design:baseline` 把计数收紧并一起提交。
- 确属例外（画布热区、第三方挂载点等）在该行行尾或紧邻上方的注释行写
  `design-allow <rule>: 理由`；不要靠改 baseline 放行新代码。
