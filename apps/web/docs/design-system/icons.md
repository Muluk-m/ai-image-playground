# 图标

业务代码只用 `<Icon>`，不直接 import `lucide-react`，不写内联 `<svg>`，也不拿 `× → ↗ ✓` 这类字符
当图标。门禁的 `lucide-import`、`inline-svg`、`glyph-icon` 会拦。

```tsx
import { Icon } from '@/components/ui/icon'

<Icon name="download" />                              // 16px，装饰性（aria-hidden）
<Icon name="loading" size="xs" className="animate-spin" />
<Icon name="favorite" filled={isFavorite} />          // 实心只给选中态
<Icon name="error" size="lg" label={t('errors.title')} /> // 单独表达含义时给读屏名字
```

## 规格

- 24 网格、描线、`round` 端点与连接；线宽 1.5px 按屏幕像素算（`non-scaling-stroke`），图标被 CSS
  放大缩小也不变粗变细。
- 尺寸跟控件高度走：

  | size | px | 用在 |
  |---|---|---|
  | `xs` | 14 | 28px 控件、角标、行内说明 |
  | `sm`（默认） | 16 | 32–36px 控件、菜单项 |
  | `md` | 20 | 40px 控件（首页输入框工具、生成按钮） |
  | `lg` | 24 | 空态、加载与报错占位、大入口 |

  放进 `Button` 时由按钮决定图标尺寸（`xs` / `icon-xs` → 14，`icon-lg` → 20，其余 16），
  按钮里的 `<Icon>` 不用传 size。
- 实心（`filled`）只给选中态（已收藏）。例外：「停止」是实心方块。
- 颜色跟着文字走（`currentColor`），用 `text-muted-foreground` 等语义色调，不写色值。
- 纯图标按钮的名字由按钮的 `aria-label` 承担；图标本身单独表达含义（状态图标）时才传 `label`。

## 语义名

名字说的是**含义**，不是形状；同一含义只有一个名字。下表是当前全部名字，以
`components/ui/icon/registry.ts` 为准。

| 名字 | 含义 | 名字 | 含义 |
|---|---|---|---|
| `add` | 新增 | `chevronUp` / `chevronDown` | 展开 / 收起、下拉指示 |
| `close` | 关闭、移除 | `chevronLeft` / `chevronRight` | 上一个 / 下一个 |
| `check` | 选中、完成 | `arrowRight` | 前往（「查看全部 →」） |
| `delete` | 删除 | `folderOpen` | 从文件夹导入 |
| `copy` | 复制 | `assets` | 素材库 |
| `edit` | 编辑 | `bookmark` | 存为模板 |
| `reuse` | 复用配置 | `favorite` | 收藏（选中时 `filled`） |
| `link` | 链接、插入引用 | `sparkles` | 生成 |
| `code` | 查看原始数据 | `image` / `images` | 一张图 / 多张图 |
| `download` | 下载、导出 | `sendToCanvas` | 送入画布 |
| `attach` | 添加附件 | `brush` | 遮罩、局部重绘 |
| `refresh` | 重试、刷新 | `stop` | 停止生成 |
| `loading` | 进行中（配 `animate-spin`） | `error` | 出错 |
| `search` | 搜索 | `blocked` | 不可用、已达上限 |
| `dragHandle` | 拖动排序把手 | `clock` | 耗时、时间 |

## 新增一个名字

1. 先在上表里找同义的名字，能用就用；含义相同只是换个地方用，不新增名字。
2. 在 `registry.ts` 对应分组里加一行 `语义名: 图形`，图形先从 lucide 选。
3. 在上表补一行含义。
4. web 的 `icon.test.tsx` 会检查每个登记的图标都满足网格、线宽与端点规格。

## 自绘图标

核心图标会逐步换成幕芽自己画的版本。换的时候**只改 `registry.ts` 那一行**，业务代码不动：

```ts
// components/ui/icon/glyphs/generate.ts
import { createLucideIcon } from 'lucide-react'

export const Generate = createLucideIcon('generate', [
  ['path', { d: 'M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z', key: 'a' }],
])
```

```diff
- sparkles: Sparkles,
+ sparkles: Generate,
```

画法：24 × 24 画布四周留 2px，作画区 20 × 20；坐标落在整数或 .5 上；只描线、不填充（`fill` 由
`<Icon filled>` 控制）；圆形图标比方形略大一点，让视觉重量一致。

品牌 Logo（模型厂商标识）在 `components/assistant-ui/elements/logos.tsx`，不属于图标体系。
