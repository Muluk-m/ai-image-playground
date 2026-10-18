# 组合件与页面配方（components/patterns）

组合件只由 `ui/` 原语与通用工具（`lib/utils`、hooks、i18n）组成，不碰 store 与业务。新的控件类型
（开关、分段页签这类）在这里用原生元素搭，业务代码再用它们。

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
需要占满一行并等分选项时传 `fullWidth`；默认保持按内容宽度排列。
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

### Dialog

标准对话框：标题（20px）+ 右上角关闭 + 可滚动正文 + 可选底栏，面板 `rounded-3xl`、`shadow-dialog`。
宽度用 `className` 的 `max-w-*` 给（默认 `max-w-md`）。

已有 `Overlay` 的宿主可用同一组属性渲染 `DialogSurface`，复用面板而不嵌套 portal 或焦点锁。
独立弹窗仍使用 `Dialog`。

```tsx
<Dialog
  title={t('import.title')}
  onClose={close}
  footer={
    <>
      <Button variant="outline" size="sm" onClick={close}>{t('common:action.cancel')}</Button>
      <Button size="sm" onClick={submit}>{t('common:action.confirm')}</Button>
    </>
  }
>
  …
</Dialog>
```

### Overlay

**所有模态浮层的唯一外壳**：portal、滚动锁、ESC 只关最顶层、点背景关闭（防划词误关）、焦点困在
面板内并在关闭后归还、打开时收起所有提示。Overlay 只管这些行为，面板长相由调用方给。

| 属性 | 取值 |
|---|---|
| `tier` | `modal`（默认，z 50）/ `raised`（弹窗里再开的弹窗，100）/ `alert`（确认，110）/ `assets`（资源抽屉，900）/ `review`（产物审阅，1000）/ `artifact`（产物审阅之上，1200） |
| `backdrop` | `dim`（默认暗化）/ `none`（全屏查看器自带底） |
| `layout` | `center`（默认，居中加 16px 边距）/ `fill`（内容自己铺满） |
| `className` | 自定义 fill 外壳的布局与背景，不覆盖层级、焦点或关闭行为 |
| `label` | 读屏念出的对话框名称 |
| `role` | 面板自己带 `role="dialog"` 并关联标题时传 `none`，免得念两遍 |

资源抽屉与产物审阅的原图预览通过 `ImagePreview tier="artifact"` 保持在宿主之上；其他调用默认仍为 raised。

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

用 `Dialog`（见上）：底栏左侧放次要操作（ghost），右侧「取消」(outline) +「确认」(default)。
全屏查看器这类自带布局的模态才直接用 `Overlay`。

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


### 创作参考素材堆叠

`components/creation/CreationReferenceStack` 用于首页、项目与验收 Demo。固定占用 72 × 72 的位置，
最多展示三层左右交替倾斜的预览；数量不会改变输入区宽高。右下角保留添加按钮，点击堆叠打开
可滚动的素材浮层，继续使用原有单图预览、遮罩、移除与上传重试操作。不要在输入区铺开多行缩略图，
不要添加独立「清空」卡片。陈列页包含 0、1、3、100 张的状态。

参考素材堆叠在鼠标悬停时展开浮层，移出后延迟收起；点击固定浮层，触屏与键盘仍可点击操作。上传未确认时显示转圈与已完成/总数，缩略图可见不代表上传已完成；失败显示原因并保留重试入口。

视频参数使用 `CanvasVideoParams` 与 `VideoPresetRows`：模型按钮及菜单复用 `ModelLogo`。
时长超过五项时，将 5 / 8 / 10 / 15 秒作为快捷选项，其余支持值收进「其他时长」，
继续保留已有选择和分辨率约束；不得为了简化展示而收窄模型协议能力。

画布对话栏的结果缩略图保持紧凑布局，不叠加悬停编辑菜单。点击已在画布上的产物直接定位对应节点；
编辑操作在画布进行。尚未交付到画布的产物仍可预览，不触发无目标定位。
节点画布的定位通过当前编辑器注册的 React Flow 焦点桥接选中节点并调整视口，不能只更新旧 `CanvasDoc`
的相机。重复点击同一产物仍须重新定位；切换或卸载画布后释放注册，避免操作旧视图。
定位时退出未保留的整理预览，按节点原位置显示；不将临时整理位置写入文档。

生成占位和结果的自动显露通过同一编辑器注册的 React Flow reveal 入口，仅作最小平移，不改变参考节点选择或缩放。
部分越界也须显露；目标包围盒超过可用区域时，超出轴按左侧／顶部对齐。目标已可见仍视为节点画布已接管，
不再读取旧镜头；只有未挂载节点画布时才回退 Konva 的可见性判断与镜头操作。

创作记录的作品高亮使用当前编辑器的节点选择；节点画布取消选择时不得复用旧文档选区。
节点画布卸载后才回退旧文档选择，点击记录与画布内选择须保持一致。

云端图片提交前被拒不补建失败占位，错误与处理入口留在对话卡片；已受理的任务占位继续归服务端管理。
本机图片和云端视频已有占位的失败、重试与交付行为不变。已有历史失败节点不自动清理，也不新增同步过滤。
