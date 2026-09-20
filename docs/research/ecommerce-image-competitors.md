# 电商图竞品调研：局部重绘 / 场景替换 / 商品替换

> 调研日期：2026-09-19。范围：官方文档、官方产品页、官方定价页与官方开源仓库。
> **未试用、未触发任何生成、未读取任何竞品私有系统提示词。**
> 来源等级标注：不标 = 官方原文直读；`[官抓]` = 官方页面正文经搜索引擎抓取（站点拦截非浏览器 UA）；`[二手]` = 第三方来源；`[存疑]` = 未取证。
>
> 相邻文档：飞象产品形态见 [flyelep-product-notes.md](flyelep-product-notes.md)；遮罩编辑的意图约束与对抗审查见 [masked-edit-intent.md](masked-edit-intent.md) 及其[竞品附件](masked-edit-reviews/competitors.md)。本文只补这两份没写的部分：**三个目标能力的逐家做法、字段与枚举**。

## 一、先说结论

1. **「局部重绘」在市面上有三种互斥的交互形态，且正在从「涂抹」向「点选」迁移。**
   - 涂抹画笔：Photoroom AI Retouch、Adobe Express、Lovart Eraser、稿定 AI 消除、绘蛙。
   - **点选自动分割**：Canva Magic Edit（「click on an element ... or brush over an area」）、Lovart Mark/Touch Edit（点一下，AI 认出对象并作为**带标签 token 塞进对话输入框**）。
   - 纯文字无 mask：Photoroom Edit With AI、Claid Image AI Edit、Shopify Magic、飞象 `partial-redrawing` 默认路径。
   - 我们已有的是**圈选 + 涂抹 + `selectionBindings` 结构化绑定**，比这三种都强；缺的是「点选即成选区」这条零精度负担的快路径。
2. **「场景替换」的技术路线在 2026 年发生了一次公开反转。** Pebblely 2026-03 明确取消抠图：「**No more background removal**」，理由是抠图对珠宝、发饰、透明瓶代价太高，改为全图重绘。而 Photoroom / Claid / Shopify 仍坚持「先抠图，只在主体周围生成」，并以此换取**可审计的像素保真承诺**。两条路各有代价，不存在共识。
3. **「商品替换」是三个目标能力里产品化程度最低、但电商价值最高的一个。** 只有四家做成一级能力：飞象 `product-replace`、美图设计室「AI 商品替换」（slug 也叫 `/image-workshop/product-replace`）、稿定「商品替换」、Adobe（Reference to × Intent 两个枚举）。Canva、Shopify、Pebblely、即梦**都没有**。
4. **商品一致性有三条互斥路线，选哪条是产品级裁决：**
   | 路线 | 代表 | 代价 |
   | --- | --- | --- |
   | 强制透明底 + 数值摆位（原始像素不动） | Claid（`placement_type` / `position` / `scale` / `rotation_degree`）、Photoroom | 抠图质量是天花板；透明/毛边品类崩 |
   | 训练商品专属模型 | Flair（6–10 张，Standard 约 3 小时）、绘蛙（15–30 张）、万相营造「商品数字分身」 | 长尾卖家的前置摩擦致命 |
   | **参考图 in-context** | Photoroom `additionalImages`（≤4）、Adobe（Flux ≤3 / Gemini ≤8）、飞象（≤3）、我们的 `editImage`（≤3 参考） | 保真靠模型，无硬保证 |
   我们已在第三条路上，且上限（3）与飞象（3）、Photoroom（4）同量级。**不需要改路线，需要补的是「像素是否被改」的显式声明。**
5. **最该抄的一条，来自 Photoroom：把「产品像素会不会被改」写成可审计的契约。** 官方文档原文：「**With this approach, it's simply not possible to introduce alterations, such as modifying a logo or a brand name**」，并**穷举列出哪些功能会碰主体**（AI Relight / AI Text Removal / AI Uncrop / AI Expand / AI Upscale / AI Beautifier / Edit With AI / 服装类），末尾还加「if product accuracy is important for you, then we recommend that you have a human validation」。这可以直接映射成每条 SKILL.md 的一行声明。

## 二、三个目标能力横向对照

| 平台 | 局部重绘 | 场景替换 | 商品替换 |
| --- | --- | --- | --- |
| **飞象** | `partial-redrawing`，默认纯文字；可传现成 `maskDataUrl`（白=重绘区）；**明令 agent 不得自己造 mask** | `scene-replace`，无 mask，场景参考图 **≤1** | `product-replace`，无 mask，目标商品图 **≤3**（逗号分隔） |
| **美图设计室** | 无此名；拆成 AI 消除（涂抹/圈选/框选 + 自动识别文字水印）与 AI 改文字 | 「AI 商品图（AI 换背景）」：**40+ 场景缩略图点选生成同款** / 文字 / 上传参考图，三者可叠加，支持批量 | **「AI 商品替换」一级 Skill**，上传原图 + 新商品图 + 文字说明三步 |
| **稿定** | 无此名；拆成 AI 改图 / AI 消除（涂抹）/ AI 改字 `[官抓]` | 「场景图生成」「小商品背景图」「爆款场景复刻」，模板按节点+品类切 | **「商品替换」Agent 卡片**，交互形态未公开 `[存疑]` |
| **即梦 AI** | **官方一级功能名「局部重绘」**：矩形框选 + 笔刷涂抹双模式，**一次出 2–4 候选再「应用」** | 无独立入口，靠局部重绘框选背景 | 无 |
| **绘蛙**（阿里） | 「局部重绘」，slug `partial-redraw`，主交互是自然语言口令 | 「一键换背景」，按行业分 tab（服装/鞋包/配饰/母婴…） | 有，**但主打视频侧**；`[二手]` 输入约束 20K–15M、>400×400；**「更自然」/「更像参考」二档开关** |
| **千牛 / 生意管家** | 有，且**「局部重绘」与「选区擦除」并列**（命名暗示选区而非涂抹） | 「背景替换」 | 无——它替换的是**模特**不是货 |
| **万相营造** | 公开页查不到 `[存疑]` | 「创造性融合背景」 | 无「替换」语义；走「商品数字分身训练 + 重生成」 |
| **RabbitVis**（兔展，2026-08） | **不做 mask，做图层拆解**：自动拆成背景/主体/文字/装饰，再用自然语言改指定图层 `[二手]` | 「替换背景图层」，保真靠图层隔离 | 无专门封装，只有通用「元素替换」 |
| **Canva** | Magic Edit（点选 or 涂抹 + prompt，官方点名底模 Nano Banana）`[官抓]`；另有 Magic Grab（点选抠成可移动图层，非生成式） | AI Background Generator + Magic Expand，**两个弱耦合功能，没有统一「换场景」动作** | **无一等公民动作**；只能 Magic Edit 靠模型想象，不能喂我的商品参考图 |
| **Adobe** | Generative Fill，选区手势全行业最丰富（Object Selection / Select Subject / Quick Selection / Magic Wand / Selection Brush / 三种套索 / Color Range + Expand/Contract/Feather/Refine Edge） | 单张 Generative Expand；企业版 Creative Production 批量换背景 | **有，且是唯一把语义做成正交枚举的**（见 §四） |
| **Lovart** | Mark/Touch Edit（点选，**≤10 marks/prompt**）+ Quick Edit（Tab 出预设）+ Eraser（唯一画笔） | Remove Background + Expand；换背景本身走 Agent 对话 | 「update products」「swap models」，靠 Agent + 参考图 + Skills 包起来，不给枚举 |
| **Photoroom** | AI Retouch（涂抹，定位「去除」）+ Edit With AI（纯文字，`ai.auto`） | AI Backgrounds（抠图后合成，**像素保真承诺**）+ Product Staging（**不让选背景**，一键 2 张） | Edit With AI 的 `additionalImages`，**主图外 ≤4 张**（总 ≤5） |
| **Flair.ai** | 最细：Magic Paint / Magic Erase / **Regenerate Product·Human·Clothing** / Fix Logo & Text（绿色 product mask 涂抹）/ Change Camera Angle / Change Color；**不支持 negative prompt** | 拖拽画布摆道具后 AI 渲染 / 文字 / 拖入背景图 / Templates | 靠训练 Custom Model（Product / Human / Aesthetic 三类，6–10 张图） |
| **Pebblely** | **无。出图不满意只能整张重 roll** | 有，**2026-03 起从抠图合成改为全图重绘**；Custom（文字+style image+颜色）/ Templates（40+ 主题）双 tab | 无 |
| **Claid.ai** | Image AI Edit，纯文字无 mask，`model` = `v1`\|`v2` | 强制前置抠图 +**数值参数摆位** | Reusable backgrounds / Repeatable scenes：同一背景换不同 SKU |
| **Shopify Magic** | 基本没有（无 mask 无画笔），只有 prompt 级改写 `[二手]` | Color Background（纯色/透明）+ Generate（AI 场景），「product remains the subject」 | 无 |
| **Amazon Ads** | 无 `[存疑]` | 有，但**入口是 ASIN 不是上传图** | 无（商品从 ASIN 注入，不存在替换语义） |
| **鹿班**（阿里，**已停服**） | 无 | 模板套版，非生成式 | 无 |

**鹿班已于 2025-06-30 24:00 全面停止服务**（2024-06-25 起停止购买续费）。整条「模板库 + 智能排版」路线被生成式模型证伪并下线——任何「先建模板库再套版」的设计都要谨慎。

## 三、飞象四条技能的字段全表（主要参考对象）

来源：官方 GitHub 组织 `FlyelepAI` 的公开仓库 [`agent-skills`](https://github.com/FlyelepAI/agent-skills)，共 16 条技能，逐字读完四条正文。

> **许可更正**：既有笔记 §六 写的仓库名 `flyelep-skills` 有误，实际是 `FlyelepAI/agent-skills`；许可表述也应更正为「**README 自称 MIT，但仓库根目录没有 LICENSE 文件，GitHub API 的 `license` 字段为 `null`**」。引用时按此表述。

一条贯穿全仓的结构事实，三份文件逐字重复：

> 「场景替换、商品替换、商品换色三个接口共用同一 DTO，由接口内部自动设置 `type` 字段，调用方无需传入 `type`。」

**局部重绘不在这个 DTO 里**——它多了 `maskDataUrl` 与 `languageType`，且 `modelType` 是字符串而非整数。

### 3.1 四条横向对照

| 维度 | `partial-redrawing` | `scene-replace` | `product-replace` | `product-color-change` |
| --- | --- | --- | --- | --- |
| 原图 | `sourceUrl` 1 张 | `sourceUrl` 1 张 | `sourceUrl` 1 张 | `sourceUrl` 1 张 |
| 第二类图 | `replaceImageUrl` 参考替换图 1 | `replaceImageUrl` 场景参考 **≤1** | `replaceImageUrl` 目标商品 **≤3**，逗号分隔 | `replaceImageUrl` 颜色参考 **≤1** |
| 蒙版 | `maskDataUrl`，白=重绘区，**仅收用户现成的** | 无 | 无 | 无（用第二文字槽代替） |
| 文字槽 | 1（`textPrompt`） | 1 | 1 | **2**（`textPrompt` + `prompt`，服务端用中文逗号拼接） |
| `modelType` | **String** `"0"`gemini-2.5 / `"2"`gemini-3.1 / `"9"`Flyelep Image 2，默认 `"0"`，**不接受 null** | Integer，仅 `9` | Integer，仅 `9` | Integer，仅 `9` |
| 计费写进技能正文 | 是：`"2"`/`"9"` 按 3.1 档计费 | 否 | 否 | 否 |
| 保留清单 | 主体、品牌标识、材质、构图 | 主体商品、角度、构图、光影关系 | 背景、光影、角度、构图、摆放位置 | 材质、品牌标识、背景、光影、构图 |
| 产物 | 单个 URL 字符串 | 单个 URL 字符串 | 单个 URL 字符串 | 单个 URL 字符串 |

### 3.2 提示词写法（原文引用，这是最值得借的部分）

**`product-replace` 的三条示例全部以「保留……」开头**，保留项写在替换项前面：

> - 「`保留背景和桌面反光，将商品替换为黑色蓝牙耳机`」
> - 「`保持原场景与阴影效果，将主体换成白色保温杯`」
> - 「`保留背景展台不变，将中间产品替换为新的香水瓶，风格保持高级简洁`」

执行流程四条：

> 「1. 优先保证 `sourceUrl` 清晰展示原场景和原商品
> 2. 优先提供 `replaceImageUrl`，帮助模型准确识别目标商品
> 3. 通过 `textPrompt` 强调保留项：背景、光影、角度、构图、摆放位置
> 4. 通过 `textPrompt` 补充目标商品要求：颜色、材质、风格、展示方式」

图/文优先级的定性判断：

> 「该接口支持 `textPrompt`，但在商品替换场景下，**目标商品图通常比纯文字更关键**。」

多角度参考的经验（与我们 `product-restyle` 已有的一致）：

> 「同一商品的多角度图一起传，有助于模型还原商品细节」

**`partial-redrawing` 的范围控制句**（整份文件最有价值的一条）：

> 「当用户目标是"小范围替换"时，提示词应避免写成整张图重做；当用户目标是"换背景"时，应在 `textPrompt` 中强调保留主体不变。」

**`scene-replace` 的边界守则**：

> 「当用户要求"换背景场景但保留产品不变"时，提示词应明确写出"保留主体不变"；如果用户真正想改的是商品本身而不是背景，应改用商品替换类 skill。」

### 3.3 失败归因：飞象把「素材不行」和「提示词不行」分开

这是我们整块缺失的维度。我们三条技能的翻车表 **100% 归因提示词**，飞象指出了另一半：

| 现象 | 飞象的归因（原文） |
| --- | --- |
| 替换结果不像目标商品 | 「目标商品图不够清晰或**角度不足**，可增加参考图（最多 3 张）」 |
| 商品替换后背景不协调 | 「提示词未强调保留原背景和光影」 |
| 局部也被错误换色 | 「**原图主体边界不清晰，可换更干净的源图**」 |

### 3.4 飞象四条技能的共同口径（不抄，但要知道）

- 「**返回结果应直接展示给用户，不要回读图片内容。**」——禁止 agent 把生成图喂回视觉模型自查。**我们的做法相反且更诚实**（`scene-swap`：「工具成功只代表出了候选……必须由人眼确认」）。
- 「以下必传参数必须通过询问用户获取，agent 不可自行填写……应先向用户列出必传参数与可选参数表格。」——**与我们的裁决正好相反**，且本次逐条读完确认这是**贯穿全仓**的一致策略，不是个别技能的写法。
- 素材格式白名单：`bmp` `gif` `jpg` `jpeg` `png`，**`webp` 需先转 `png`/`jpg`**。
- 「上传不消耗算力，但服务端不做去重：同一文件一次任务里只上传一次，记下 `fullPath` 复用」。

## 四、Adobe 的两个正交枚举 —— 语义建模的最优解

Photoshop Generative Fill + Reference image，选中区域后设两个彼此正交的枚举：

- **Reference to**：`Object`（References a single subject） / `Whole image`（References the entire scene）
- **Intent**：`Swap the selected area`（Replaces an existing object） / `Place into the selected area`（Adds an object **while preserving the background**）

参考图张数按模型分档：**Flux ≤3，Gemini ≤8**。

这两个枚举恰好切中我们三个目标能力的边界：

| Reference to × Intent | 等于哪个能力 |
| --- | --- |
| Object + Swap | **商品替换** |
| Object + Place | 商品置入（我们目前没有这个概念） |
| Whole image + Swap | **场景替换** |

用户不必写「把这个包换成我上传的那个，但别动背景」这种容易跑偏的长 prompt。另外 Firefly 的 Composition 参考配的是 **Strength 滑杆而非布尔开关**——「参考多少」本就是连续量。

## 五、可抄清单

按可抄程度排序，每条都注明出处与落点。

1. **每条 SKILL.md 显式声明「是否改动商品像素」**（Photoroom）。它把 pipeline 写死成「抠图 → 只在主体周围生成」，据此给出像素保真承诺，并穷举列出会碰主体的功能。我们做不到像素级承诺，但**必须写清哪条技能会重画商品**——这是电商信任度的地基。
2. **保留项写在替换项前面**（飞象 `product-replace` 三条示例无一例外）。我们 `product-restyle` 的三句顺序是「换什么 / 保留什么 / 还原什么」，`scene-swap` 是「新场景 / 光线对齐 / 保留清单」——保留都排在后面。值得做一次 A/B。
3. **失败归因分「提示词侧」与「素材侧」两栏**（飞象 `product-color-change`「换更干净的源图」、`product-replace`「角度不足」）。我们三条技能的翻车表全部指向提示词，缺了一半真相。
4. **点选即成选区**（Canva Magic Edit、Lovart Mark/Touch Edit）。Lovart 的形态最贴我们：点一下画布 → AI 识别对象 → **作为带标签 token 进入对话输入框** → 继续对这个 token 说话，一次 prompt ≤10 个 mark。这正是左对话右画布的核心命题：既不必精细涂抹，也不必写「左边那个杯子」这种易指代失败的措辞。
5. **局部重绘一次出 2–4 个候选再「应用」**（即梦）。我们目前 `n` 默认 1。把 AI 不确定性变成用户可选的分支，比「不满意就重 roll」代价低得多。
6. **「更自然」vs「更像参考」二元开关**（绘蛙）。把「忠于参考图」和「忠于真实感」这对天然冲突显式交给用户，比让用户调 prompt 强度直观。
7. **商品在场景里的位置做成数值参数**（Claid：`placement_type` = `absolute`\|`original`，`position.x/y` 0–1 默认 0.5，`scale` 0–1，`rotation_degree` 0–360）。右侧画布天然适配：拖动商品 = 改 `position`。其中 **`placement_type: original`（商品原位不动，只重绘背景）是「保持商品像素」的最小可信实现**。
8. **尺寸预设放在生成之前而非生成之后裁**（Pebblely，官方明说「generates the full image at the right dimensions from the start, rather than cropping or extending」）。同一 prompt 在 1080×1350 和 1200×628 下应该是两种构图。
9. **把局部重绘拆成按对象类型的动词**（Flair：Regenerate **Product** / **Human** / **Clothing**、Fix **Logo & Text**）。用户说「这个瓶子歪了」→ 直接路由到 regenerate-product，而不是让模型猜 mask 范围。天然映射成 SKILL 粒度。
10. **两个正交枚举 Reference to × Intent**（Adobe，见 §四）。
11. **对话式 agent 先出可审阅的中间产物再出像素**（Amazon Creative Agent 的 storyboard；美图「AI 商品替换」的三段说明也是同一形状：替换哪个商品 / 保留的背景构图 / 需要匹配的光影和角度）。我们已有「确认生成」草稿卡，方向一致。
12. **composer 上直接显示本次预计消耗**（Pebblely 的 Create 按钮显示总 credit；飞象每个按钮带价）。

## 六、明确不抄清单

| 不抄 | 谁 | 原因 |
| --- | --- | --- |
| 生成前列参数表让用户逐项确认 | 飞象（全仓一致） | 与我们「意图清楚就直接做并说明替用户定了什么」的裁决相反 |
| 禁止 agent 回读产物、由 agent 自述成功 | 飞象 | 我们把验收推给人，更诚实 |
| 商品一致性押在 6–10 张图 + 3 小时训练 | Flair、绘蛙（15–30 张）、万相营造 | 长尾卖家前置摩擦致命，还占「模型数量」配额 |
| 场景不可选、一键出 2 张随机 lifestyle | Photoroom Product Staging | 不可控 + 强制二次编辑，在对话形态里是体验倒退 |
| 完全没有局部修改能力 | Pebblely | 用户第二句话一定是「把左边那个杯子去掉」 |
| 输出锁死 ~1 MP、大图先降采样 | Shopify Magic `[二手]` | 以「替代拍摄」为卖点的产品，分辨率不能是事后才发现的天花板 |
| 三档 AI 额度 + 不滚存 + 换算不透明 | Canva | 用户点生成前无法预判扣多少，不敢连续迭代 |
| 两套 credit 池互不相通 | Claid（Web / API） | 计费历史包袱转嫁给用户 |
| 把电商刚需锁在企业档 | Adobe（Object Composites、Creative Production 均需 enterprise） | 个人卖家摸不到最核心动作 |
| 能力堆到 60+ Skill 平铺导航 | 美图设计室 | 很多只是换了个预设 prompt 的同一条链路，SEO 落地页驱动，不是真的能力分层 |
| 能力分层外溢成域名分层 | 稿定（gaoding.com + gaoding.art 两套导航两套会员） | 用户要先搞清楚该去哪个站 |
| 把四个工具并排放工具栏让用户自选 | 即梦（消除/扩图/改文字/局部重绘） | 我们是 Agent + SKILL 路由，不该让用户判断需求属于哪个工具 |
| 纯自然语言编辑、无直接操作兜底 | RabbitVis | 「LOGO 往左移 20px」用嘴说远不如拖一下 |
| 商品输入锁死单一平台主键 | Amazon Ads（ASIN）、万相营造（淘系） | 独立工具这么做就是自断输入 |
| 先建模板库再套版 | 鹿班 | 这条路线已被证伪并下线 |

## 七、与幕芽现状的差距

现有三条技能（均标注「示例级内容，尚未经过真实产出验证」）：
`apps/bff/skills/image/scene-swap/SKILL.md`、`product-restyle/SKILL.md`、`image-remix/SKILL.md`。
遮罩编辑接缝已落地：`MaskEditorModal`（圈选默认填满内部 / 涂抹保留笔刷语义）、`AgentReference.maskDataUrl`、`selectionBindings`、圈外像素按原图回贴。

### 我们比竞品强的（确认不改）

- **`selectionBindings` 是结构化绑定**（图片 id + 选区 id），且区分「目标图上的选区 = 改这块」与「参考图上的选区 = 参考这块」。飞象只有一张外部 mask PNG，且明令 agent 不许自己造；其余各家都没有这个区分。
- **逐张调用语义**：`scene-swap` 写了「用户说『每张』『全部』时逐张调用，其它待处理照片不能自动变成参考图」（#669 的四分类）。竞品接口只吃单张原图，这个问题在它们那里不存在。
- **`n` 与「多版 vs 多方案」的区分**：三条技能都写了「同一场景的多版才用 `n`；不同场景/不同商品分别调用」。
- **复刻的合规提醒**：`image-remix` 有，飞象 `product-replace`/`scene-replace` 一句没有。

### 确认要补的（本次调研的直接产出）

1. **`scene-swap` 缺参考图张数上限**。`product-restyle` 写了「最多再放三张」，`scene-swap` 只写「放在目标图后面」，两条口径不齐。飞象给的是场景参考 ≤1。
2. **三条技能都缺「素材侧失败归因」**，见 §3.3。
3. **`scene-swap` 那句「工具成功只代表出了候选」没有提升为三条共用的收尾口径**——`product-restyle` 与 `image-remix` 只列了「要人工确认什么」，缺那句总断言。
4. **没有一句禁止 agent 凭空编造选区 id** 的等价物（飞象有「agent 不要自己构造掩码」）。
5. **`商品替换` 与 `换色/换款` 挤在 `product-restyle` 一条技能里**。飞象、美图、稿定都把它拆成一级能力；美图的 slug 甚至与飞象同名。
6. **素材格式约束未写进技能**（飞象有 webp 需转码的白名单）。`[INFERENCE]` 未核对我方 `editImage` 的实际格式校验实现。

## 八、未验证 / 查不到

1. **逐平台（淘宝/京东/拼多多/1688/小红书/抖音/Amazon/Temu/TikTok Shop）的官方尺寸表与合规要求**：没有任何一家在公开页面给出。美图只说「支持任一电商平台尺寸」，稿定只点名平台名，千牛有「素材合规检测」但不公布规则。
2. **即梦、稿定、绘蛙、万相营造的参考图张数上限与分辨率上限**：均在登录墙后。唯一拿到硬约束的是绘蛙商品替换（20K–15M、>400×400，`[二手]`）。
3. **RabbitVis、千牛生意管家的计费单位**：登录墙后。
4. **Canva 全站、gaoding.com / gaoding.art 对非浏览器 UA 返回拦截页或 HTTP 405**；Shopify help 页返回 403。相关内容均为搜索引擎抓取的官方页面正文，已在 §二 表格与正文标注。
5. **Photoroom 的具体美元价**：官方定价页由 JS 注入，未取到。
6. **本文全部内容来自只读观察，没有触发任何一家的生成。** 所有关于效果、保真度、失败率的表述都是各家自己的官方话术，不是实测结论。

## 九、来源

**飞象**：https://github.com/FlyelepAI/agent-skills （四条技能 raw：`skills/partial-redrawing/SKILL.md`、`skills/scene-replace/SKILL.md`、`skills/product-replace/SKILL.md`、`skills/product-color-change/SKILL.md`）、https://www.flyelep.cn/

**Canva**：https://www.canva.com/help/using-magic-edit 、https://www.canva.com/features/ai-photo-editing 、https://www.canva.com/en_au/help/using-magic-grab 、https://www.canva.com/create/ai-background 、https://www.canva.com/features/ai-image-expander 、https://www.canva.com/features/ai-replace 、https://www.canva.com/help/generate-with-dreamlab 、http://canva.com/help/ai-access

**Adobe**：https://helpx.adobe.com/photoshop/desktop/create-open-import-images/create-images/edit-images-with-generative-fill.html 、https://helpx.adobe.com/photoshop/desktop/create-open-import-images/create-images/use-reference-images-for-consistent-results.html 、https://helpx.adobe.com/photoshop/desktop/make-selections/refine-modify-selections/use-selections-for-generative-editing.html 、https://helpx.adobe.com/firefly/web/work-with-enterprise-features/create-object-composites/object-composites-overview.html 、https://helpx.adobe.com/creative-cloud/apps/generative-ai/generative-credits-faq.html

**Lovart**：https://www.lovart.ai/business-owners 、https://www.lovart.ai/docs/edit-your-design/advanced-ai-editing 、https://www.lovart.ai/docs/edit-your-design/ai-transformation 、https://www.lovart.ai/docs/how-to-prompt/agent-skills 、https://www.lovart.ai/pricing

**Photoroom**：https://docs.photoroom.com/ 、https://docs.photoroom.com/image-editing-api-plus-plan/ai-backgrounds 、https://docs.photoroom.com/image-editing-api-plus-plan/edit-with-ai 、https://www.photoroom.com/tools/product-staging 、https://www.photoroom.com/batch

**Flair.ai**：https://flair.ai/ 、https://flair.ai/pricing 、https://flair.ai/resources/faq 、https://flair.ai/key-features/on-model-photography

**Pebblely**：https://pebblely.com/blog/introducing-new-pebblely 、https://www.pebblely.com/pricing

**Claid.ai**：https://docs.claid.ai/ai-background-api/ai-background-options/object 、https://docs.claid.ai/ai-background-api/ai-background-options/scene 、https://docs.claid.ai/image-ai-edit-api/image-ai-edit-options 、https://claid.ai/api-pricing

**Shopify Magic**：https://changelog.shopify.com/posts/improved-ai-image-editing-with-sidekick 、https://changelog.shopify.com/posts/shopify-magic-now-in-the-media-editor

**Amazon Ads**：https://advertising.amazon.com/generative-ai-ad-solutions

**即梦 AI**：https://jimeng.jianying.com/ 、https://www.volcengine.com/docs/85621/1976207

**美图设计室**：https://www.designkit.cn/ai-product-background 、https://www.designkit.cn/image-workshop/product-replace 、https://www.designkit.cn/object-remover 、https://www.designkit.cn/ecom-product/listing-images

**稿定**：https://www.gaoding.com/ai-product 、https://www.gaoding.art/ 、https://www.gaoding.art/pricing

**绘蛙**：https://www.ihuiwa.com/ 、https://www.ihuiwa.com/workspace/ai-image/partial-redraw

**万相营造**：https://www.wanxiang.art/ 、https://agi.alimama.com/

**千牛 / 生意管家**：https://quick.taobao.com/

**RabbitVis / 兔展**：https://rabbitvis.rabbitpre.com/ 、https://www.rabbitpre.com/about.html

**鹿班（停服公告）**：https://luban.aliyun.com/
