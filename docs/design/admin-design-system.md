---
name: 幕芽 Muvloom 后台（Admin v2）
scope: apps/admin
tokens: apps/admin/src/styles/tokens.css
colors:
  brand-ink: '#23282B'
  brand-ink-raised: '#30373B'
  brand-sprout: '#DBFFA0'
  brand-sprout-strong: '#BFE77E'
  brand-mint: '#83EEB0'
  background: '#FFFFFF'
  foreground: '#09090B'
  card: '#FFFFFF'
  card-foreground: '#09090B'
  popover: '#FFFFFF'
  primary: '#18181B'
  primary-foreground: '#FAFAFA'
  secondary: '#F4F4F5'
  secondary-foreground: '#18181B'
  muted: '#F4F4F5'
  muted-foreground: '#71717A'
  accent: '#F4F4F5'
  accent-foreground: '#18181B'
  border: '#E4E4E7'
  input: '#E4E4E7'
  ring: '#18181B'
  destructive: '#EF4444'
  success: '#0C8D62'
  warning: '#DC8F09'
  danger: '#DA1B3B'
  private: '#762FDA'
  background-dark: '#09090B'
  foreground-dark: '#FAFAFA'
  muted-dark: '#27272A'
  muted-foreground-dark: '#A1A1AA'
  border-dark: '#27272A'
typography:
  page-title:
    fontFamily: system-ui
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 28px
    letterSpacing: -0.01em
  metric:
    fontFamily: system-ui
    fontSize: 24px
    fontWeight: '700'
    lineHeight: 32px
    letterSpacing: -0.02em
  section-title:
    fontFamily: system-ui
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: '0'
  body:
    fontFamily: system-ui
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: '0'
  label:
    fontFamily: system-ui
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: '0'
  overline:
    fontFamily: system-ui
    fontSize: 10px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.18em
  code:
    fontFamily: ui-monospace
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: '0'
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.375rem
  lg: 0.5rem
  card: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  2xl: 24px
  page: 20px
  shell-header: 64px
  shell-nav: 256px
  shell-nav-icon: 72px
  inspector: 576px
---

# 幕芽 Muvloom 后台设计系统

适用范围：`apps/admin`（运营者后台）。主站 `apps/web` 另有自己的 `theme.css`，两者共享品牌色，但不共用本文的壳与密度规则。

单一事实来源是 `apps/admin/src/styles/tokens.css`；本文解释这些 token 的意图。取值冲突时以该文件为准。

## 1. 视觉基调

这是一套**给一个人用的高密度运维工具**，不是营销页面。整体气质是安静的、以数据为主角的：大面积中性底色，克制的留白，颜色只在「需要立刻被看见」的地方出现——失败、告警、私有树标记、主要动作。运营者一天要在这里回答两类完全不同的问题（业务跑得怎么样 / 部署有没有出事），所以界面必须做到扫一眼就能分辨严重程度，而不是把所有区块都做得同样鲜艳。

配色骨架是**冷中性灰阶**（zinc），品牌的**芽尖绿**只作为动作与选中色点缀。左侧导航是常驻的**深灰品牌壳**，与右侧随系统深浅色切换的内容区形成稳定对比：无论用户是浅色还是深色偏好，导航始终是同一块深色，芽绿选中条在上面最醒目。信息密度偏高——列表行紧凑、卡片内边距 16px、页面边距 20px——但所有可点区域都保证至少 36px 高，避免在长列表里误点。

## 2. 色彩与角色

三层结构：primitive 是唯一写死具体色值的地方，semantic 承载用途，component 承载组件私有覆盖。深浅色切换**只覆盖 semantic 层**。

### 品牌

| 名称 | 色值 | 角色 |
|---|---|---|
| Ink 墨灰 | `#23282B` | 常驻导航壳底色、主站预览卡底色 |
| Ink Raised 抬升墨灰 | `#30373B` | 导航壳上的分隔线与 hover 底 |
| Sprout 芽尖绿 | `#DBFFA0` | 主要动作（发布、新建）、导航选中态、推荐位标记 |
| Sprout Strong 深芽绿 | `#BFE77E` | 芽绿动作的 hover |
| Mint 薄荷绿 | `#83EEB0` | 品牌标记点、选中行的描边；不做大面积填充 |

芽绿是浅色，**必须与 `--brand-action-foreground`（墨灰）成对使用**，永远不要配白字。

### 中性基座

页面 `--background` 浅色为纯白、深色为近黑（`#09090B`）；卡片与页面同色，靠 `--border` 分隔而不是靠阴影。`--muted` 同时充当次级底色和列表 hover 底。`--muted-foreground` 承担所有说明文字、时间戳和次要元信息。

### 状态

| 语义 | 浅色 | 深色 | 用在哪 |
|---|---|---|---|
| success | `#0C8D62` | `#28BD8C` | 服务存活、任务完成、已发布 |
| warning | `#DC8F09` | `#F6AE31` | 心跳延迟、队列卡住、5xx 比例升高 |
| danger | `#DA1B3B` | `#F25A73` | 宿主机告警、失败任务 |
| destructive | `#EF4444` | `#7E1D1D` | 破坏性按钮与徽标（shadcn 语义位） |
| private | `#762FDA` | `#AE7EF1` | 私有树（积分、收款、计费）标记 |

`danger` 与 `destructive` 不是一回事：前者描述**被观测到的状态**，后者描述**用户将要执行的破坏性动作**。

## 3. 字体规则

系统字体栈，中文走 PingFang SC / Microsoft YaHei；等宽栈用于 ID、sha、模型名、错误码。后台不引入 Web Font——它在内网/低带宽下也要秒开。

| 角色 | 尺寸 | 字重 | 用途 |
|---|---|---|---|
| metric | 24px | 700 | KPI 数值，唯一允许「大」的地方 |
| page-title | 18px | 600 | 页头标题 |
| section-title | 16px | 600 | 卡片标题 |
| body | 14px | 400 | 正文与表格，后台的默认字号 |
| label | 12px | 500 | 徽标、筛选、元信息 |
| overline | 10px | 600 + 0.18em | 导航分组标签，大写字距 |
| code | 12px | 400 | 任务 id、提交 sha、模型名、错误码 |

规则：一屏里最多一个 24px 数值组；说明文字一律 `--muted-foreground`；任何 id 类文本必须走等宽，避免 `l/1/I` 混淆。

## 4. 组件规范

### 按钮

| 变体 | 背景 | 文字 | 用途 |
|---|---|---|---|
| brand | `--brand-action` | `--brand-action-foreground` | 发布、新建条目、确认收款 |
| default | `--primary` | `--primary-foreground` | 常规提交 |
| outline | 透明 + `--border` | `--foreground` | 次级动作 |
| ghost | 透明 | `--foreground` | 图标按钮、工具条 |
| destructive | `--destructive` | `--destructive-foreground` | 停用、删除 |

高度 36px，圆角 `--radius`，hover 只换底色不位移；disabled 用 50% 透明并 `pointer-events-none`。一个页面或抽屉里**只允许一个 brand 按钮**。

### 卡片

圆角 12px，1px `--border`，默认无阴影；只有可点卡片才在 hover 时给 `--shadow-md` 并上移 2px。内边距 16px，内部块间距 16px。卡片不叠卡片——需要分组时用标题 + 分隔线。

### 检视抽屉（v2 核心交互面）

右侧滑出，宽 576px，灵感条目用 704px。层级：`--inspector-shadow` + 1px 左边框；内容区独立滚动；发布/下架/存草稿固定在底部，随内容滚动时保持可见。打开抽屉**不改变列表的筛选、滚动位置与选中项**——这是选 A 方案的核心理由。

### 导航壳

常驻深色（`--shell-nav-bg`），展开 256px / 收起 72px。分组标签用 overline 字阶 + `--shell-nav-group-label`。选中项整块铺芽绿、文字转墨灰；未选中项 hover 只提亮底色。收起态每项必须有 tooltip 与 `aria-label`。

### 表单

输入高度 36px，圆角 `--radius`，1px `--input`；focus 用 2px `--ring` 环而不是换边框色。提示词一类长文本用等宽 12px、行高 20px，至少 9 行。模板的 `{槽位}` 在预览里渲染成 chip，不在 textarea 里做富文本。

### 徽标与状态点

徽标圆角同 `--radius`（不是胶囊），12px 字号，左右 10px。纯状态用 8px 圆点 + 文字，不单独用颜色表达含义——色觉障碍下必须仍可读。

### 灵感媒体网格

卡片圆角 12px，封面 4:3，网格最小列宽 240px、间距 16px。封面上叠两个角标：左上类型（效果图/模板/技能示例），右上推荐位星标（芽绿底 + 墨灰星）。卡片底部一行放状态点、标题、分类与 7 天播放数。

### 主站预览

在墨灰底上渲染一张浅色卡片，模拟 `/explore` 的真实观感，底部是芽绿「玩同款」按钮。预览必须跟随编辑实时更新，否则运营者要靠想象发布。

## 5. 布局原则

- **栅格**：应用壳为「固定导航 + 流式内容」；内容区最大 1680px，两侧 20px 内边距（`lg:` 起 28px）。
- **节奏**：4px 基数。组件内 8/12px，卡片内 16px，区块之间 20px。
- **对齐**：一律左对齐；数字右对齐；状态与徽标居中。后台没有居中排版的英雄区。
- **响应式**：断点沿用 Tailwind 默认。`<lg` 导航收成图标栏，抽屉转全屏；表格改为卡片列表。后台以桌面为主，但必须在 iPad 宽度可用。
- **深浅色**：跟随系统 `prefers-color-scheme`，不提供切换开关——与主站现有行为一致。
- **底部留白**：原型期底部 80px 被切换条占据；正式实现里该区域留给抽屉动作条。

## 6. 使用约定

1. 组件里禁止出现具体色值。写 `bg-brand`、`text-muted-foreground`，不写 `bg-[#DBFFA0]`。
2. 需要新颜色时，先在 primitive 层加一个命名值，再在 semantic 层起一个用途名，最后才在组件里用。
3. 深浅色差异只允许出现在 `tokens.css` 的 `prefers-color-scheme` 块里；组件里不写 `dark:` 分支来表达主题色。
4. 颜色一律存 `H S% L%` 三元组，这样 `bg-primary/60` 这类透明度修饰符才成立。
5. 私有树区块必须带 `private` 标记，免费部署下整块不渲染。
6. 芽绿不表达状态，只表达「这是主要动作」或「这是当前选中」。

## 7. 现状与后续

已落地：三层 token 文件、Tailwind 映射（`brand.*`、`shell.*`、`success/warning/danger/private`、语义间距、动效时长）、A 方案原型已全部改用 token。

重构时已核对：30 个 shadcn 语义 token 在浅色与深色下的计算值与重构前完全一致，现有后台外观未发生变化。

待办：正式实现 v2 时把 `--inspector-*`、`--shell-nav-*`、`--media-*` 落到真实组件；私有 overlay 的 `shared.tsx` 目前用裸 Tailwind 类，需要跟着换成 token。
