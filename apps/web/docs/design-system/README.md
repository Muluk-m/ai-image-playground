# 幕芽设计系统

设计规则的唯一入口是 [`DESIGN.md`](../../DESIGN.md)。写或改界面时先读它，再从它的「目录 / 入口」进到本目录。
这里只讲**怎么用**：找「该用哪个组件」。颜色、字阶、间距、圆角等 token 与视觉原则以 DESIGN.md 为准，不在这里重复。

| 文档 | 内容 |
|---|---|
| [components.md](./components.md) | `components/ui/` 原语：Button、Input、Select、Popover… 的变体、尺寸与禁忌 |
| [patterns.md](./patterns.md) | `components/patterns/` 组合件，以及页面骨架、对话框、表单、反馈、空态的配方 |
| [icons.md](./icons.md) | `<Icon>` 的用法、现有语义名、新增图标与自绘图标的流程 |

## 三层

```text
apps/web/src/components/
├── ui/          原语：shadcn new-york + <Icon>。无业务含义，Radix 只在这里封装一次
│   └── icon/    <Icon>（index.tsx）与语义名对照表（registry.ts）
├── patterns/    通用组合件：只由 ui 与通用工具组成，无业务含义
├── assistant-ui/elements/   assistant-ui 的改写（Hint 提示、生成卡片等），算 UI 层
└── (其余)       业务共用组件：InputBar、TaskCard、Sidebar…
features/        各业务自己的组件
```

依赖只能自上而下：业务 → patterns → ui，`ui/` 也不依赖 `patterns/`。`pnpm lint` 的设计门禁会拦下越层
依赖、业务代码里的原生控件与直接引图标库等写法，完整规则与例外写法见 DESIGN.md「门禁」。

## 我要做 X → 用哪个

| 要做的事 | 用 | 位置 |
|---|---|---|
| 一个按钮（带字 / 纯图标） | `Button` + `variant` / `size` | ui/button |
| 图标 | `<Icon name size>` | ui/icon |
| 鼠标悬停或聚焦时的说明 | `Hint`（包住按钮） | assistant-ui/elements/tooltip-icon-button |
| 单行输入 / 多行输入 | `Input` / `Textarea`，配 `Label` | ui/input、ui/textarea、ui/label |
| 带放大镜的搜索框 | `SearchField` | patterns |
| 从一组选项里选一个（表单里） | `Select`（Radix，`SelectTrigger` + `SelectContent`） | ui/select |
| 下拉里要拖拽排序、改名、删除 | `Select`（自研组合件） | patterns/Select |
| 勾选 / 开关 | `Checkbox`（带标签） / `Switch` | patterns |
| 数值滑块 | `Slider` | ui/slider |
| 页内切换几个视图 | `SegmentedTabs` | patterns |
| 浏览页页头 | `PageHeader` | patterns |
| 区块标题 + 「查看全部」 | `SectionHeader` | patterns |
| 一行设置（图标 + 标签 + 控件） | `SettingRow` | patterns |
| 小标签（状态、计数、角标） | `Badge` + `tone` | patterns |
| 空态 | `EmptyState` | patterns |
| 对话框（标题 + 正文 + 底栏） | `Dialog` | patterns |
| 全屏查看器等自定义模态 | `Overlay` 外壳 + 自己的面板 | patterns |
| 从侧边滑出的面板 | `Sheet` | ui/sheet |
| 贴着触发点弹出的卡片 | `Popover` | ui/popover |
| 右键 / 长按菜单 | `ContextMenu` + `ContextMenuItem` | patterns |
| 确认「删除吗？」 | `useStore().setConfirmDialog(...)` | store（全局 ConfirmDialog） |
| 一句操作结果提示 | `useStore().showToast(message, type)` | store（全局 Toast） |
| 拖文件进来的遮罩 | `DropOverlay` | patterns |

表里找不到时，先看 [patterns.md](./patterns.md) 的配方；还是没有，就按下一节新增，不在业务里手搭。

## 新增一个组件

1. 先判断层级：**没有业务含义**、能被两个以上页面复用的，才进 `ui/` 或 `patterns/`。
   - 新的控件类型或 Radix 原语 → `ui/`（照 shadcn new-york 写；admin 也有同名文件时两边必须一致，
     `parity.test.ts` 会查）。
   - 由原语组合出的常用结构 → `patterns/`。
   - 只有一个业务用 → 放在那个 feature 里。
2. 样式只用 DESIGN.md 的 token 与档位；控件高度只有 28 / 32 / 36 / 40。
3. 在本目录对应文档里加一节：何时用、变体、示例、禁忌。
4. 在陈列页（开发服务器上的 `/design.html`，源码 `src/dev/DesignGallery.tsx`）加上它，浅色深色各看一眼。
