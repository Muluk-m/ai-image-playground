# 图标

业务代码只用 `<Icon>`，不直接 import `lucide-react`，不写内联 `<svg>`，也不拿 `× → ↗ ✓` 这类字符
当图标。

```tsx
import { Icon } from '@/components/ui/icon'

<Icon name="download" />                              // 16px，装饰性（aria-hidden）
<Icon name="loading" size="xs" className="animate-spin" />
<Icon name="favorite" filled={isFavorite} />          // 选中态换双色款
<Icon name="error" size="lg" label={t('errors.title')} /> // 单独表达含义时给读屏名字
```

## 规格

- 图形取自 [Solar](https://icon-sets.iconify.design/solar/)（480 Design，CC BY 4.0）的
  Linear 与 Bold Duotone 两款，Solar 缺的抓手、文字、形状、进行中取自 lucide，线宽统一。署名见
  `components/ui/icon/NOTICE.md` 与线上的 `/third-party-notices.txt`。
- 24 网格、描线；线宽 1.5px 按屏幕像素算（`non-scaling-stroke`），图标被 CSS 放大缩小也不变粗变细。
- 尺寸跟控件高度走：

  | size | px | 用在 |
  |---|---|---|
  | `xs` | 14 | 28px 控件、角标、行内说明 |
  | `sm`（默认） | 16 | 32–36px 控件、菜单项 |
  | `md` | 20 | 40px 控件（首页输入框工具、生成按钮） |
  | `lg` | 24 | 空态、加载与报错占位、大入口 |

  放进 `Button` 时由按钮决定图标尺寸（`xs` / `icon-xs` → 14，`icon-lg` → 20，其余 16），
  按钮里的 `<Icon>` 不用传 size。
- **选中态用 `filled`**：换成双色款（主形 + 半透明底），颜色跟着文字走。当前导航项、已收藏、
  正在使用的工具都用它；其余一律描线。取自 lucide 的几个没有双色款，选中时保持描线。
- 颜色用 `text-muted-foreground`、`text-primary` 等语义色调，不写色值。
- 纯图标按钮的名字由按钮的 `aria-label` 承担；图标本身单独表达含义（状态图标）时才传 `label`。

## 语义名

名字说的是**含义**，不是形状；同一含义只有一个名字。不同含义可以共用一个图形（「复制到剪贴板」与
「复制一份」）。下表与 `scripts/build-icon-glyphs.mjs` 一一对应，web 的 `icon.test.tsx` 会检查。

**导航**

| 名字 | 含义 | 图形 |
|---|---|---|
| `create` | 创作（导航） | magic-stick-3 |
| `explore` | 探索 | compass |
| `assets` | 资产 | album |
| `toolbox` | 工具箱 | toolbox |
| `guide` | 使用指南 | book |
| `chat` | 对话 | chat-round |
| `canvas` | 画布 | frame |
| `settings` | 设置 | settings |
| `user` | 账户 | user-circle |
| `logout` | 退出登录 | logout |
| `sidebar` | 收起 / 展开侧栏 | sidebar |
| `light` | 浅色主题 | sun |
| `dark` | 深色主题 | moon |
| `system` | 跟随系统外观 | monitor（lucide） |
| `language` | 界面语言 | global |

**会员等级**

| 名字 | 含义 | 图形 |
|---|---|---|
| `membershipFree` | Free 会员等级 | sprout（lucide） |
| `membershipBasic` | Basic 会员等级 | stars |
| `membershipPlus` | Plus 会员等级 | star |
| `membershipMax` | Max 会员等级 | crown-line |

**创作**

| 名字 | 含义 | 图形 |
|---|---|---|
| `generate` | 生成 | stars |
| `wand` | 智能编辑 | magic-wand |
| `model` | 模型 | cpu |
| `ratio` | 比例 | crop-minimalistic |
| `quality` | 质量 | crown-line |
| `settingsAdjust` | 参数设置 | tuning |
| `imageAdd` | 添加参考图 | gallery-add |
| `attach` | 添加附件 | paperclip |
| `send` | 发送 | arrow-up |
| `shortcut` | 快捷键 | keyboard |
| `clear` | 清空输入 | text-cross |
| `stop` | 停止生成 | stop |
| `refresh` | 重试、重新生成 | refresh |
| `speed` | 速度 | bolt |
| `security` | 安全保障 | shield-check |
| `back` | 返回 | arrow-left |
| `upscale` | 高清放大 | maximize-square |
| `removeBg` | 抠图 | scissors |
| `brush` | 遮罩、局部重绘 | paint-brush |
| `crop` | 裁剪 | crop |
| `outpaint` | 扩图 | maximize-square-2 |
| `variant` | 变体 | shuffle |
| `template` | 存为模板 | bookmark |
| `favorite` | 收藏 | star |
| `reuse` | 复用配置 | undo-left-round |
| `prompt` | 提示词 | document-text |
| `sendToCanvas` | 送入画布 | gallery-send |

**生产面板**

| 名字 | 含义 | 图形 |
|---|---|---|
| `script` | 剧本 | document-text |
| `storyboard` | 分镜 | clapperboard |
| `clip` | 片段 | video-frame |
| `character` | 角色 | user-rounded |
| `location` | 场景地点 | map-point |
| `exportPackage` | 导出素材包 | box |
| `quote` | 引用原文 | chat-square-call |
| `compare` | 对照修改 | transfer-horizontal |
| `history` | 修订历史 | history |
| `collapseAll` | 折叠章节 | list-up |
| `moveUp` | 上移排序 | arrow-up |
| `moveDown` | 下移排序 | arrow-down |
| `imageUnavailable` | 图片不可用 | gallery-remove |

**画布工具**

| 名字 | 含义 | 图形 |
|---|---|---|
| `select` | 选择工具 | cursor |
| `pan` | 抓手 | hand（lucide） |
| `draw` | 画笔 | pen |
| `erase` | 橡皮 | eraser |
| `drawArrow` | 箭头标注 | arrow-right-up |
| `text` | 文字工具 | type（lucide） |
| `shape` | 形状 | shapes（lucide） |
| `undo` | 撤销 | undo-left |
| `redo` | 重做 | undo-right |
| `duplicate` | 复制一份 | copy |
| `zoomIn` | 放大 | magnifer-zoom-in |
| `zoomOut` | 缩小 | magnifer-zoom-out |
| `fit` | 适合屏幕 | maximize |
| `layers` | 图层 | layers |

**媒体与文件**

| 名字 | 含义 | 图形 |
|---|---|---|
| `image` | 一张图 | gallery |
| `images` | 多张图 | gallery-wide |
| `video` | 视频 | videocamera |
| `play` | 播放 | play |
| `pause` | 暂停 | pause |
| `volume` | 声音 | volume-loud |
| `fullscreen` | 全屏 | full-screen |
| `minimize` | 收起展开的内容区域 | minimize |
| `download` | 下载、导出 | download-minimalistic |
| `upload` | 上传 | upload-minimalistic |
| `share` | 分享 | share |
| `link` | 链接、插入引用 | link |
| `copy` | 复制到剪贴板 | copy |
| `folder` | 文件夹、从文件夹导入 | folder-open |
| `database` | 数据 | database |
| `delete` | 删除 | trash-bin-2 |
| `edit` | 编辑 | pen-2 |
| `code` | 查看原始数据 | code |

**通用**

| 名字 | 含义 | 图形 |
|---|---|---|
| `search` | 搜索 | magnifer |
| `add` | 新增 | add |
| `close` | 关闭、移除 | close |
| `check` | 选中、完成 | check |
| `more` | 更多操作 | menu-dots |
| `filter` | 筛选 | filter |
| `sort` | 排序 | sort |
| `grid` | 网格视图 | widget |
| `list` | 列表视图 | list |
| `chevronUp` | 收起 | alt-arrow-up |
| `chevronDown` | 展开、下拉 | alt-arrow-down |
| `chevronLeft` | 上一个 | alt-arrow-left |
| `chevronRight` | 下一个 | alt-arrow-right |
| `arrowRight` | 前往（「查看全部」） | arrow-right |
| `external` | 新窗口打开 | square-top-up |
| `drag` | 拖动排序 | hamburger-menu |

**状态**

| 名字 | 含义 | 图形 |
|---|---|---|
| `loading` | 进行中（配 animate-spin） | loader-circle（lucide） |
| `success` | 成功 | check-circle |
| `warning` | 警告 | danger-triangle |
| `error` | 出错 | danger-circle |
| `info` | 提示 | info-circle |
| `blocked` | 不可用、已达上限 | forbidden-circle |
| `lock` | 锁定、会员可用 | lock |
| `unlock` | 解锁比例、独立调整 | lock-unlocked |
| `key` | API 密钥 | key |
| `visible` | 显示 | eye |
| `hidden` | 隐藏 | eye-closed |
| `notify` | 通知 | bell |
| `credits` | 积分 | bolt |
| `clock` | 耗时、时间 | clock-circle |

## 新增名字或更换图形

1. 先在上表里找同义的名字，能用就用；含义相同只是换个地方用，不新增名字。
2. 在 `apps/web/scripts/build-icon-glyphs.mjs` 的 `GLYPHS` 对应分组里加一行 `语义名: ['solar', 图形名]`。
   图形名在 [Iconify 的 Solar 合集](https://icon-sets.iconify.design/solar/) 里查，必须同时有
   `-linear` 与 `-bold-duotone` 两款；Solar 没有时才用 `['lucide', 图形名]`。
3. 在 `apps/web` 下运行 `node scripts/build-icon-glyphs.mjs` 重新生成 `glyphs.gen.ts`，不手改生成文件。
4. 在上表补一行，到陈列页（`/design.html`）深浅色各看一眼。

品牌 Logo（模型厂商标识）在 `components/assistant-ui/elements/logos.tsx`，不属于图标体系。

**工具箱与指南**

| 名字 | 含义 | 图形 |
|---|---|---|
| `resize` | 调整图片尺寸 | maximize |
| `compress` | 压缩图片 | minimize-square |
| `convertFormat` | 转换图片格式 | transfer-horizontal |
| `rotate` | 旋转图片 | rotate-cw |
| `flipHorizontal` | 水平翻转 | flip-horizontal-2 |
| `flipVertical` | 垂直翻转 | flip-vertical-2 |
| `collage` | 拼图 | widget |
| `stitch` | 拼接长图 | gallery-vertical |
| `slice` | 切图 | grid-3x3 |
| `sendToComposer` | 送入创作页 | gallery-send |
| `gettingStarted` | 快速上手 | rocket |
| `tip` | 使用提示 | lightbulb |
| `help` | 常见问题 | question-circle |

**Agent 交互与技能**

| 名字 | 含义 | 图形 |
|---|---|---|
| `terminal` | 执行命令 | terminal |
| `diagnostic` | 错误诊断 | bug |
| `selectLasso` | 套索选区 | lasso |
| `selectRectangle` | 矩形选区 | square |
| `starter` | 使用起手句 | corner-down-right |
| `poster` | 海报场景 | presentation-graph |
| `shop` | 电商场景 | shop |
| `resolution` | 视频分辨率 | monitor |
| `firstFrame` | 视频首帧 | skip-back |
| `lastFrame` | 视频尾帧 | skip-forward |
| `keyframes` | 视频关键帧 | video-frame |
| `audio` | 音频与声音 | soundwave |
| `aperture` | 光圈技能 | aperture |
| `camera` | 摄影技能 | camera |
| `flame` | 火焰效果技能 | fire |
| `focus` | 聚焦技能 | focus |
| `home` | 室内场景技能 | home-2 |
| `imageAnimate` | 图片动效技能 | image-play |
| `translate` | 语言翻译 | languages |
| `layoutTemplate` | 版式模板 | layout-template |
| `advertise` | 广告创作 | megaphone |
| `landscape` | 自然场景 | mountain |
| `notebook` | 笔记创作 | notebook-pen |
| `productAdd` | 创建产品素材 | package-plus |
| `palette` | 视觉风格 | palette |
| `replace` | 内容替换 | replace |
| `imageInspect` | 图片分析 | scan-search |
| `product` | 产品素材 | bag-4 |
| `cart` | 购物商品 | cart-large |
| `sprout` | 植物技能 | sprout |
| `waves` | 波纹技能 | waves |
| `agentActivity` | 智能体步骤状态 | sparkle |
