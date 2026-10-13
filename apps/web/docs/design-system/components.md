# 原语（components/ui）

shadcn new-york 原语加 `<Icon>`。业务代码从这里取控件，不写原生 `<button>` / `<input>` 等，
也不直接 import `@radix-ui/*`。尺寸、颜色只用下面列出的变体；需要新变体时改原语本身
（admin 有同名文件时两边一起改），不在调用处用 class 硬改高度或底色。

控件高度只有 28 / 32 / 36 / 40 四档，各自用在哪见 DESIGN.md「Layout」。

## Button

`import { Button } from '@/components/ui/button'`

| variant | 用在 | 不要 |
|---|---|---|
| `default` | 主操作（生成、保存、确认），每个视图只有一个 | — |
| `secondary` | 并列的次要操作（复用配置、编辑输出） | 拿它表达状态 |
| `outline` | 工具按钮、需要边界的图标按钮、对话框里的「取消」 | — |
| `ghost` | 工具条、卡片操作、关闭按钮等融在背景里的操作 | — |
| `destructive` | 确认对话框里的「确认删除」 | 列表里的删除入口（用 `ghost` + `hover:text-destructive`） |
| `link` | 文中链接式操作（「展开全部」） | — |

| size | 高度 | 用在 |
|---|---|---|
| `xs` | 28 | 小按钮、页签式按钮（图标自动 14px） |
| `sm` | 32 | 次要按钮、对话框底栏 |
| `default` | 36 | 常规按钮 |
| `lg` | 40 | 首页输入框里带字的按钮 |
| `icon-xs` | 28 | 卡片操作、列表行操作（图标 14px） |
| `icon-sm` | 32 | 工具条、对话框关闭、复制等纯图标按钮 |
| `icon` | 36 | 与 36px 输入框或文字按钮同排的图标按钮 |
| `icon-lg` | 40 | 首页输入框的工具按钮（图标 20px） |

```tsx
<Button variant="ghost" size="icon-sm" aria-label={t('common:action.close')} onClick={onClose}>
  <Icon name="close" />
</Button>
```

- 纯图标按钮必须有 `aria-label`；需要悬停说明时外面包 `Hint`。
- 圆角用默认的 `rounded-md`，见 DESIGN.md「Shapes」。
- 禁用态由原语给（50% 透明 + 不响应指针）。品牌生成按钮这类自带禁用外观的，加
  `disabled:opacity-100` 后写自己的禁用样式。
- 禁用按钮收不到指针事件：要在禁用时解释原因，把 `Hint` 包在外层容器上。

## Icon

见 [icons.md](./icons.md)。

## Input / Textarea / Label

`Input` 36px 高、`Textarea` 至少 80px，都是描边 + 透明底，聚焦时 1px 焦点环。

```tsx
<Label htmlFor={id}>{t('settings.apiKey')}</Label>
<Input id={id} value={value} onChange={(e) => setValue(e.target.value)} />
```

- 需要放大镜图标的搜索框用 patterns 的 `SearchField`，不在 Input 外面再套一层。

## Select（Radix）

表单里「从一组固定选项里选一个」用它；需要拖拽排序、行内改名删除的，用 patterns 的 `Select`。

```tsx
<Select value={format} onValueChange={setFormat}>
  <SelectTrigger aria-label={t('param.format')}>
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="png">PNG</SelectItem>
    <SelectItem value="jpeg">JPEG</SelectItem>
  </SelectContent>
</Select>
```

## Checkbox / Slider

原语本身只有方框和滑轨。带标签的勾选框用 patterns 的 `Checkbox`；`Slider` 直接用，数值显示在旁边
用 `font-mono` 或 `tabular-nums`。竖向滑块传 `orientation="vertical"`，由父容器给出高度，
不要用旋转水平滑块替代，否则指针坐标与轨道方向不一致。

## Popover

贴着触发点弹出的卡片（设置卡片、候选列表）。默认宽 288px、内边距 16px、`shadow-md`；需要更宽时
改 `className` 的宽度，不改圆角和阴影。高度可能超出窗口时加
`max-h-[min(36rem,var(--radix-popover-content-available-height))]` 并让内部滚动。

## Sheet

从屏幕边缘滑出的面板（移动端侧栏、筛选面板）。`side` 取 `top` / `bottom` / `left` / `right`，
标题用 `SheetTitle`（20px，对话框标题档）。

## Tooltip

不直接使用。悬停提示统一用 `Hint`（assistant-ui/elements/tooltip-icon-button），它在 Tooltip 原语上
加了统一的延迟、样式，以及「打开模态时收起所有提示」的约定。
