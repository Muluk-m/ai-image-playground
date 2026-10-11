# 组合件与页面配方（components/patterns）

组合件只由 `ui/` 原语与通用工具（`lib/utils`、hooks、i18n）组成，不碰 store 与业务。它们是新控件
类型唯一允许直接写原生元素的地方（门禁对 `ui/` 与 `patterns/` 放行 `native-control`）。

## 组合件

### PageHeader

浏览页（探索、资产、工具箱）共用的页头：固定 56px，底部 1px 分割线，左右内边距 24px；右侧按浮动账号簇
的实际宽度让位。`title` 用 title-sm（15px），`leading` 放返回按钮或面包屑，`children` 放页签、搜索和
主操作。

```tsx
<PageHeader title={t('library.title')}>
  <SegmentedTabs label={t('library.tabsAria')} tabs={tabs} value={tab} onChange={setTab} />
  <SearchField placeholder={t('library.search')} value={query} onChange={…} className="ml-auto" />
</PageHeader>
```

### SectionHeader

区块标题（title-sm）+ 右侧「查看全部」。`action.label` 一律用「查看全部」，链接文字与下方网格右边缘对齐。

### SegmentedTabs

页内切换几个视图：28px 胶囊页签，选中态 accent 底。必须传 `label` 说明这组页签切换的是什么（读屏用）。
互斥的**参数档位**（比例、质量）不用它，用设置卡片里的 `SettingsSegmented`。

### SearchField

带放大镜的 36px 搜索框，默认最宽 280px。属性同原生 input（`type` 固定为 search）。

### Checkbox

勾选框加标签：`checked` / `onChange(boolean)` / `label`。`tone="danger"` 只用于会顺带清掉数据的勾选
（清空时连同配置一起清、退出时清掉本机数据）。

### Switch

唯一的 `role="switch"` 实现：`checked` / `onChange`。开关立即生效，不配「保存」按钮。

### SettingRow

一行设置：图标 + 标签（`hint` 可补一行说明）+ 右侧 `control`。设置面板与头像菜单共用。

### Select（组合件）

需要下拉里**拖拽排序、行内改名删除、选项带图标与说明**时用；普通表单选择用 ui 的 Radix `Select`。

### Badge

卡片角落与行内的小标签，不带交互，一种颜色说一件事：

| tone | 用在 |
|---|---|
| `neutral`（默认） | 计数、元数据 |
| `overlay` | 盖在图片、视频上的角标（黑底白字，不随主题变） |
| `primary` | 当前、推荐 |
| `success` / `warning` | 结果与风险 |
| `info` | 提示性标记 |

### EmptyState

一枚线性图标（`<Icon size="lg">`）+ 一句 body-sm 说明 + 可选一个按钮，放在内容区上部居中。
说明只写「这里放什么、怎么开始」，不解释系统行为。

```tsx
<EmptyState
  icon={<Icon name="images" size="lg" />}
  title={t('assets.emptyTitle')}
  action={<Button size="sm" onClick={upload}>{t('assets.upload')}</Button>}
/>
```

### Overlay

**所有模态浮层的唯一外壳**：portal、滚动锁、ESC 只关最顶层、点背景关闭（防划词误关）、焦点困在
面板内并在关闭后归还、打开时收起所有提示。Overlay 只管这些行为，面板长相由调用方给。

| 属性 | 取值 |
|---|---|
| `tier` | `modal`（默认，z 50）/ `raised`（弹窗里再开的弹窗，100）/ `alert`（确认，110）/ `artifact`（产物审阅之上，1200） |
| `backdrop` | `dim`（默认暗化）/ `none`（全屏查看器自带底） |
| `layout` | `center`（默认，居中加 16px 边距）/ `fill`（内容自己铺满） |
| `label` | 读屏念出的对话框名称 |
| `role` | 面板自己带 `role="dialog"` 并关联标题时传 `none`，免得念两遍 |

### ContextMenu

右键 / 长按菜单：传 `x` / `y` / `onClose`，里面放 `ContextMenuItem`（`icon` 用 `<Icon>`、`label`、
`onClick`）。它会按实测尺寸夹回视口，点外面、滚动、缩放即关。它是定位浮层，不走 Overlay。

### DropOverlay

拖文件进入时盖在区域上的遮罩，只传 `label`。

## 页面配方

### 浏览页

```text
PageHeader（56px，标题 + 页签 + 搜索 + 主操作）
└─ 内容区：整块滚动，内边距 24px，内容左对齐铺满宽度
   └─ SectionHeader + 卡片网格（卡片 rounded-2xl，静止不带阴影，hover 最多 shadow-lg）
```

只有首页 hero 居中（最大宽度 1152px）。内容区占满视口（`100dvh`），不为全局顶栏预留高度。

### 对话框

`Overlay` 外壳 + 一块面板：`bg-card`、`rounded-3xl`、`shadow-dialog`、`ring-1 ring-hairline`。

```text
面板
├─ 头部：标题（text-xl font-semibold）+ 右上角关闭（Button ghost icon-sm）
├─ 内容：可滚动，内边距 20–24px
└─ 底栏：border-t，左侧次要操作（ghost），右侧「取消」(outline) +「确认」(default)
```

确认类对话框（删除、清空）不要自己写，用 `setConfirmDialog`：它走 `alert` 层；`tone: 'danger'`（或标题里有「删除」「清空」）
时确认按钮是红色的「确认删除」，`tone: 'warning'` 是黄色，其余是「确认」。

### 设置卡片 / 弹出卡片

`Popover` + `rounded-xl` 面板：标题 + 关闭、按组排列、底部「恢复默认 / 完成」，改动即时生效。
互斥档位用 `SettingsSegmented`，开关用 `Switch`。

### 表单

- 一个字段 = `Label` + 控件（+ 一行 `text-label-sm text-muted-foreground` 说明）。
- 字段之间 16px，分组之间 24px；同一行的控件高度一致。
- 校验错误写在字段下方，`text-destructive`，存 i18n key、渲染时再翻译。

### 反馈

| 场景 | 用 |
|---|---|
| 一次操作的结果（已复制、已删除、失败） | `showToast(message, 'success' \| 'error' \| 'info')`，出现在页头下方 |
| 当前区域无法完成（加载失败、无权限） | 区域内的错误态：`<Icon name="error" size="lg">` + 一句说明 + 重试按钮 |
| 不可逆操作前 | `setConfirmDialog` |
| 进行中 | `<Icon name="loading" className="animate-spin">`；整块加载用骨架或品牌加载，不叠多个转圈 |

状态色（success / warning / destructive）只表达结果与风险，不做装饰。

### 空态

用 `EmptyState`，见上。
