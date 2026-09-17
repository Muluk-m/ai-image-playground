# 智能体原生的视频创作模式：能力与交互模型调研

调研日期：**2026-09-17**。只读调研，未改动任何实现代码。

仓库内事实均现场读代码得来，每条带 `file:line`。外部事实均现场读官方一手文档（官方 API reference / 官方产品帮助中心 / 官方 changelog / 官方 OpenAPI），每条带 URL 与读取日期。凡未在官方来源找到的，明确写「未找到官方说明」，不做推断；凡只拿到搜索引擎从官方页抽出的摘录而未能直读正文的，标「摘录级」。

起因是所有者的两句裁决：**「现在这套太死板太难用」**、**「这个分镜生成这块后面要走 Agent 模式」**。本文回答：智能体原生的视频创作模式，能力与交互模型该长什么样，才能把导演台整套换掉。

---

## 一、先钉住宿主现状

这些是仓库内实测事实，不是假设。它们决定了下面每个候选的真实代价。

| 事实 | 证据 |
| --- | --- |
| 智能体运行时已上线：`@earendil-works/pi-agent-core` 0.85.1 当库跑在 BFF 进程里 | `apps/bff/package.json:17-18`、`docs/adr/0003-agent-runtime-in-bff-process.md` |
| 四个工具：生图、改图、查素材库、**生视频**。生视频已在场 | `apps/bff/src/lib/agent/tools/index.ts:12`、`tools/generateVideo.ts:71-121` |
| 一轮 = 一条 `chat` 任务，起轮前按估算 token 在同一事务里预扣，结束按实际用量结算 | `apps/bff/src/lib/agent/start-turn.ts:99-152`、`turn.ts:534-553` |
| 工具内部复用现有队列：`createQueueTask` 提交 → `awaitQueueTask` 轮询，单任务等待上限 **30 分钟** | `apps/bff/src/lib/agent/tools/queueTask.ts:85-110`、`packages/shared/src/queue-protocol.ts:215` |
| 工具进度经 `onUpdate` 推成 `toolProgress` 事件（`submitted` / `running`） | `tools/queueTask.ts:103-109`、`turn.ts:410-421` |
| 工具起跑那一刻就发 `toolStart`，带 `outputCount` 与 `anchorObjectId`，画布先占位 | `turn.ts:388-408` |
| SSE 带会话内单调 `seq`，事件落 Postgres，断线按 `Last-Event-ID` 重放；15 秒心跳；事件保留 24 小时 | `apps/bff/src/lib/agent/events.ts:11-71`、`sse.ts:16-52`、`packages/shared/src/agent.ts:279-282` |
| **中途插话已实现**：`interject()` 带图带遮罩 → `agent.steer()`，轮不中断 | `turn.ts:458-498`、`runningTurns.ts:12-19`、路由 `apps/bff/src/routes/agent.ts:227-228` |
| **中止已实现**：`abort()` | `turn.ts:499-502`、`apps/bff/src/routes/agent.ts:218-219` |
| **澄清已实现**，但形状很窄：一句问题 + **2–4 个互斥选项**，发出即**本轮结束** | `apps/bff/src/lib/agent/clarification.ts:7-34`、`turn.ts:261`、`turn.ts:423-431` |
| 上下文压缩是一等接缝：`transformContext` + 摘要锚点 + 熔断器 | `turn.ts:262-268`、`compaction.ts:1-80`、`compaction-transform.ts` |
| **工具串行执行**：`toolExecution: 'sequential'`，一个会话同时只允许一轮 | `turn.ts:258-259`、`runningTurns.ts:23-26` |
| pi 还有三个**已装但没用**的接缝：`beforeToolCall`（可 `{ block, reason, terminate }` 拦截）、`afterToolCall`（可改写工具结果）、`followUp()`（轮尾追加） | `pi-agent-core@0.85.1` `dist/agent.d.ts:5-24,88-92`、`dist/types.d.ts:40-73` |
| pi 还带 **Agent Skills 标准的 `SKILL.md` 加载器**（`loadSkills` / `Skill { name, description, content, filePath }`），但它在 harness 层，当前 `turn.ts` 直接用 `Agent` 类，没有接 | `pi-agent-core@0.85.1` `dist/harness/skills.d.ts`、`dist/harness/types.d.ts:31-58`；对比 `turn.ts:237-269` |
| 智能体面板**只挂在创作模式**，视频模式里没有智能体 | `apps/web/src/App.tsx:93-96`、`apps/web/src/features/canvas/components/CanvasMode.tsx:173-174` |
| 视频模式是 5 个视图的独立工作台：导演台 / 分镜库 / 生成与成片 / 快速生成 / 新建分镜 | `apps/web/src/features/video/components/VideoMode.tsx:15,59-139` |
| 服务端已有「带修订号的文档」先例：`canvas_projects.document` + `revision` 乐观并发 | `packages/db/src/schema.ts:214-230`、`docs/adr/0002-…md`「项目同步的增量交付」 |
| 分镜**只存浏览器 IndexedDB**，不进同步集合 | `apps/web/src/features/video/storyboard/lib/storyboardStore.ts:11-16`；`apps/bff/src/routes/sync.ts` 无 storyboard |
| 能力位 deny by default；`generation:storyboard`、`agent:chat`、`generation:video` 默认全关 | `packages/shared/src/capabilities.ts:3-16`、`docs/adr/0001-capability-config-fails-closed.md` |
| 上游最长单次出片 **15 秒**（Grok / Seedance），Veo 只有 4/6/8 秒；仓库里**没有任何拼接代码** | `packages/shared/src/video-presets.ts:87-155`；全仓 `grep -r "concat\|stitch\|拼接"` 只命中 PNG 编码、对象存储键前缀与 Grok 1.0 的参考图 contact sheet（`apps/web/src/lib/productMatte/pngEncode.ts:43`、`apps/bff/src/lib/objectKeyPrefix.ts:1`、`apps/bff/src/lib/upstream.ts:459`），**没有任何视频拼接** |
| `extend` / `edit` 两个派生模式已在协议与视频模式里落地，但**不是智能体工具** | `packages/shared/src/video-presets.ts:26-59`、`apps/web/src/features/video/lib/derive.ts:31-50`；对比 `tools/index.ts:12` |

**路线图与 ADR 已经把答案指了一半**（这是本次最该先认下来的一条）：

- ROADMAP 2.3 原文：分镜「依赖 2.1（出口）、**2.2（它就是智能体的一个专业形态，结构化输出）**」。`docs/ROADMAP.md:94-97`
- ADR 0003 的 Consequences 最后一句：「好处是 skills 走 Agent Skills 标准的 `SKILL.md` 目录，**给分镜这类专业形态留了一条不写代码的路**」。`docs/adr/0003-agent-runtime-in-bff-process.md:35`

也就是说「分镜走 Agent 模式」不是新主意，是当初选 pi 时就写进 ADR 的预期路径。本文要定的是**交互形状**，不是要不要走。

---

## 二、今天这套导演台，死板在哪（逐条带证据）

不是"感觉繁琐"，是十处硬编码。按严重程度排：

### 2.1 一次性 JSON，全有或全无

`POST /api/storyboard/plan` 把创意、镜数、总时长、比例、风格拼成一段提示词，**非流式**一次要回整个 JSON，`maxTokens: 4000`、`timeoutMs: 90_000`（`apps/bff/src/lib/storyboard.ts:10-62`）。解析器是**全有或全无**：镜头数对不上返回 `null`、任一镜缺 `title` / `description` / `camera` / `imagePrompt` / `videoPrompt` 中的任何一个就整份作废（`packages/shared/src/storyboard.ts:100-120`、`74-97`）。`askChatModel` 最多重试一次，两次都解析不出就抛（`apps/bff/src/lib/chatCompletion.ts:222-234`）。

结果：用户等 ~60 秒（界面自己写 `STORYBOARD_PLAN_TYPICAL_SECONDS = 60`，`storyboard/store.ts:38`），要么全拿到、要么全空。**没有部分产出，没有中途看见，没有中途纠偏。**

### 2.2 镜数与总时长是枚举，不是参数

```ts
STORYBOARD_SHOT_COUNTS = [2, 3, 4, 5]
STORYBOARD_TOTAL_SECONDS = [10, 15]
```
`packages/shared/src/storyboard.ts:3-8`，并由路由 schema 强制（`apps/bff/src/routes/storyboard-plan.ts:20-21`）。

`STORYBOARD_TOTAL_SECONDS` 上面那行注释说破了根因：「整条分镜一次生成，总时长直接进视频请求，所以只能取 `VideoDuration` 里的档位」。**天花板不是产品选择，是「没有拼接」这个事实的投影**——最长单次出片 15 秒（`video-presets.ts:90,116`），所以整片最长 15 秒，2–5 镜均分下来每镜 2–7.5 秒。

### 2.3 时间轴是均分的，模型说了不算

`storyboardSegments()` 把总时长按镜数**等分**并对齐到 0.5 秒（`packages/shared/src/storyboard.ts:20-29`）。模型返回的时间段被**直接丢弃**：`parseShot` 注释写着「时间段是请求参数不是模型答案：模型改了它，下游的视频请求就会跟界面对不上」（`storyboard.ts:92-95`）。

也就是说：分镜师最该决定的东西之一——节奏——模型无权决定。

### 2.4 「整片」只是一段多行提示词，不是多个片段

`generateWholeVideo` 把每镜的 `videoPrompt` 拼成多行文本，作为**一次**视频请求发出去（`storyboard/store.ts:548-572`、`storyboard/lib/director.ts:38-47`）。逐镜出片（`generateShotVideo`，`store.ts:522-547`）产出的是**互不相干的独立任务**，仓库里没有任何代码把它们接起来（见 §1 末尾那条 grep）。

「生成与成片」这个视图名是 UI 措辞；成片这一步在代码里不存在。

### 2.5 改时长靠正则改写提示词

用户选的秒数要落到模型支持的档位上（`DirectorGeneration.tsx:48-56` 取最近档），然后 `promptAtDuration()` 用正则把提示词里的「镜头N（a-b秒）」逐个按比例缩放重写，并在最前面插一句「视频总时长为 N 秒」（`storyboard/lib/director.ts:50-58`）。

用户手编过的秒数，在提交那一刻会被正则重新算一遍。

### 2.6 逐镜编辑是 7 个纯文本框

一镜的可编辑字段：`title` / `description` / `camera` / `line` / `videoPrompt` / `imagePrompt` / `seconds`（`storyboard/types.ts:78-83`），卡片上摊开 5 个（`StoryboardShotCard.tsx:19-25`），详情面板再加 2 个（`StoryboardBoard.tsx:328-390`）。

要让第 3 镜暗一点，用户得自己想清楚该改 `description` 还是 `videoPrompt`，还是两个都改。**没有"说一句话改一镜"这个动作。**

### 2.7 重写脚本 = 推倒重来

`replan()` 建一条**全新记录**（新 `id`、`versions: []`、`videoTaskId: null`、`shots` 全换），原稿留着但两者从此无关（`storyboard/store.ts:434-464`）。所有已出的分镜图与视频与新脚本脱钩。

「把第 2 镜换个角度、其余不动」在这套设计里只能靠手改，重写就是全丢。

### 2.8 逐镜出片必须先有分镜图

`generateShotVideo` 在 `!shot.imageId` 时直接弹 toast「这一镜还没有分镜图」并返回（`store.ts:527-530`、`store.ts:34`）。而首帧图是另一条流水线（`generateMissingShotImages` / `regenerateShotImage`，`store.ts:512-520`）。

想快速试一镜，得先排一条图任务。

### 2.9 分镜只在这台浏览器里

`storyboardStore` 是 IndexedDB 的三个方法（`lib/storyboardStore.ts:11-16`），分镜库界面自己写着「保存在当前浏览器」（`StoryboardLibrary.tsx:22`）。换设备就没了；版本快照、参考图、导出 ZIP 全部同理。

### 2.10 与智能体完全不相通

智能体面板只在创作模式（`App.tsx:93-96`、`CanvasMode.tsx:173-174`），视频模式是另一套五视图工作台（`VideoMode.tsx:15`）。两边不共享会话、不共享历史、不共享画布、不共享参考图语义。分镜脚本还用**另一个模型**（`STORYBOARD_MODEL`，`apps/bff/src/config.ts:117-120`）。

另外：分镜脚本生成**不计费**但烧上游额度，因此路由要求登录（`routes/storyboard-plan.ts:29-37`、`CONTEXT.md:273-276`）——一条没有计量的成本通道。

---

## 三、智能体运行时今天就能扛住的部分（一行不用改）

把导演台需要的能力对着现有 runtime 点一遍：

| 导演台要的 | 智能体今天有没有 | 证据 |
| --- | --- | --- |
| 从一句创意起步 | ✅ 就是一条用户消息 | `start-turn.ts:79-169` |
| 带参考图（多张、可带遮罩） | ✅ 引用原语，`[image N]` 编号 + 图片 id | `agent/images.ts:129-138,198-279` |
| 分镜文案的生成 | ✅ 模型直接吐文字，**逐字流式** | `turn.ts:364-375` |
| 逐镜出首帧图 | ✅ `generateImage` / `editImage`，一次调用可出 n 张 | `tools/generateImage.ts`、`tools/queueParams.ts:6-13` |
| 出视频（文生 / 图生） | ✅ `generateVideo`，带时长 / 比例 / 清晰度 | `tools/generateVideo.ts:19-46` |
| 分钟级任务不把界面卡死 | ✅ 提交进队列 + 轮询，进度推 `toolProgress`，SSE 15 秒心跳 | `tools/queueTask.ts:103-109`、`sse.ts:16-47` |
| 刷新 / 切网后接回 | ✅ `Last-Event-ID` 重放，轮独立于连接存活 | `events.ts:54-71`、`runningTurns.ts:8-19` |
| 中途改主意 | ✅ `interject` → `steer`，轮不断 | `turn.ts:458-498` |
| 叫停 | ✅ `abort` | `turn.ts:499-502` |
| 问用户一句 | ⚠️ 有，但一次只能一问 2–4 选项且**发出即结束本轮** | `clarification.ts:7-34`、`turn.ts:261` |
| 产出落到用户能看见的地方 | ✅ 画布占位 → 产物交付，带冲突语义 | `turn.ts:388-408`、`CONTEXT.md:317-322,346-349` |
| 长会话不爆上下文 | ✅ 压缩 + 锚点 + 熔断 | `compaction.ts` |
| 按量计费 | ✅ 对话按 token、工具任务各自预扣结算 | `start-turn.ts:99-152`、`CONTEXT.md:300-304` |
| 部署可关 | ✅ 能力位 + 工具可用性判定 | `tools/index.ts:18-20`、`tools/generateVideo.ts:80` |

**结论：第 2 节列的十条死板，有七条（2.1、2.3、2.5、2.6、2.7、2.9、2.10）在智能体这边天然不成立**——因为智能体没有表单、没有一次性 JSON、没有均分时间轴、没有「重写即推倒」，历史在服务端且跨设备。

剩下三条（2.2 镜数时长枚举、2.4 没有成片、2.8 必须先有图）是**真实的能力缺口**，换交互模型解决不了。

---

## 四、缺口：必须新建的东西

按「非做不可 → 可以后补」排：

1. **一件可被反复修改的分镜产物。** 今天智能体只有消息和画布对象；没有「一份有结构、能被第 5 轮改第 2 镜的文档」。消息是追加式的，改不了。服务端已有的类比是 `canvas_projects.document` + `revision` 乐观并发（`schema.ts:214-230`），但分镜不是画布结构，套不进 `ProjectDocument`（协议版本 1 只认文字、箭头、画笔，见 ADR 0002）。

2. **视频产物不可回读。** `outputsFromHistory` 只记 `media === 'image'` 的产物（`agent/images.ts:115-125`），所以模型拿不回自己刚出的那段视频。**这一条卡死了所有「基于上一段继续」的交互**。

3. **没有 `extend` / `edit` 工具。** 协议里有（`video-presets.ts:26-59`），视频模式里能用（`derive.ts:31-50`），智能体清单里没有（`tools/index.ts:12`）。而外部一手证据显示（见 §5.2），**续接是全行业做长片的唯一手段**。

4. **没有拼接。** 全仓无 concat/stitch。这是 2.2 与 2.4 的共同根因。

5. **`generateVideo` 参数面太窄。** 只有 `first_frame_index`，没有尾帧（`generateVideo.ts:110`），而 Agnes 2.5 Flash 与 Seedance 2.0 都支持尾帧（`video-presets.ts:108,121`）；视频模型也不可选（写死 `config.agent.videoModel`，`queueTask.ts:65`），`AgentTurnParams` 是纯图片参数（`packages/shared/src/agent.ts:55-65`）。

6. **工具串行 + 一会话一轮。** `toolExecution: 'sequential'`（`turn.ts:259`）、`runningTurn()` 单例（`runningTurns.ts:23-26`）。5 镜逐条跑，Seedance 典型 120 秒/条（`video-presets.ts:124`）就是 10 分钟一轮，期间会话锁死。单任务等待上限 30 分钟（`queue-protocol.ts:215`）暂时够，但进程被强杀这一轮的文字就没了（ADR 0003 已认下这笔账）。

7. **澄清太窄。** 一次一问、2–4 互斥选项、无多选、无自由文本、发出即结束本轮（`clarification.ts:15-22`、`turn.ts:261`）。对比 Anthropic 官方的 `AskUserQuestion`：**1–4 个问题、每问 2–4 选项、支持 `multiSelect`、支持自由文本、支持选项预览**（见 §5.4）。分镜场景一次要问的恰恰是「画幅 + 时长 + 风格」这类并列的几件事。

8. **智能体不在视频模式里。** 要么把视频创作搬进创作模式，要么在视频模式里挂一个面板。两条路都要动 §1 里那两处挂载点。

---

## 五、外部一手证据

以下全部为 2026-09-17 现场抓取。可达性限制先说明：`help.openai.com` 全站、`openai.com/index/sora-2/`、`help.runwayml.com` 全站均 403；`kling.ai/document-api/*` 是 SPA + WAF，未能取得其 API 字段名。这些位置的内容一律标「摘录级」或「未找到官方说明」。

### 5.1 先说一条会影响选型的事实：Sora 正在下线

OpenAI 官方 deprecations 页原文：「On March 24th, 2026, we notified developers using the Videos API and Sora 2 video generation model aliases and snapshots of their deprecation and removal from the API on **September 24, 2026**」。受影响的是 `sora-2`、`sora-2-pro` 及整个 Videos API，**官方未列替代品**。
<https://developers.openai.com/api/docs/deprecations>（2026-09-17）

Sora App 已于 2026-04-26 停（官方 help 文章 20001152，**摘录级，403 未直读**）。

**结论**：Sora 的 storyboard / remix / re-cut / blend / loop 只能当交互设计样本，不能当可对接后端。

### 5.2 底层作业协议已经完全收敛（可当事实基线）

| 事项 | 各家做法 | 来源（均 2026-09-17） |
| --- | --- | --- |
| 异步作业 + 轮询 / webhook，**无一例外** | OpenAI `POST /videos` → `GET /videos/{id}`，status `queued`/`in_progress`/`completed`/`failed`；Runway 「Generation endpoints are asynchronous. They return a task `id`; poll `GET /v1/tasks/{id}` until `status` is `SUCCEEDED` or `FAILED`」；Veo 走 long-running operation 每 10 秒轮 `done`；Luma `GET /v1/generations/{id}`；Pika `GET /v1/media/jobs/{job_id}` | <https://developers.openai.com/api/docs/api-reference/videos>、<https://docs.dev.runwayml.com/api.md>、<https://ai.google.dev/gemini-api/docs/veo>、<https://docs.agents.lumalabs.ai/guides/videos/generation>、<https://dev.pika.art/openapi.json> |
| **没有一家同步返回视频** | 同上 | 同上 |
| 「图作为帧锚点」是通用原语 | Runway `promptImage[].position: "first" \| "last"`（每个 position 唯一）；Veo `image` + `lastFrame`（尾帧必须同时给首帧）；Luma `start_frame` / `end_frame`，或 `keyframes` + `keyframe_indexes`（**1–64 张**）；Kling「Start & End Frames-to-Video」；Pika `images` 数组；OpenAI 只有 `input_reference`（仅首帧） | 同上 + <https://kling.ai/quickstart/klingai-video-3-model-user-guide> |
| 「参考图锁一致性」通用，只差数量 | Veo `referenceImages` 最多 3 张；Runway Gen-4 References 3 张；Flow Ingredients 每条 prompt 最多 3 个；Kling 3.0 Omni 图与元素合计 ≤7（**摘录级**） | <https://ai.google.dev/gemini-api/docs/veo>、<https://blog.google/innovation-and-ai/products/flow-video-tips/> |
| **续接是全行业做长片的唯一手段，且都有硬上限** | Sora `POST /videos/extensions`，单次最多 +20s、总长上限 120s；Veo 每次 **+7 秒、最多 20 次**，合并后最长 **148 秒**，且只有 3.1 与 3.1 Fast 支持；Kling 每次 **4–5 秒**、总长上限 **3 分钟**；Luma「A `type: "video"` request with exactly one `generation_id` keyframe is a video extend request」 | <https://developers.openai.com/api/docs/guides/video-generation>、<https://ai.google.dev/gemini-api/docs/veo>、<https://kling.ai/quickstart/ai-video-extension>、<https://docs.agents.lumalabs.ai/guides/videos/generation> |
| 「改已有视频」= 视频 + 自然语言 + 可选区域/帧锚点，且都带忠实度旋钮 | Luma `mode` 九档 `adhere_1..3` / `flex_1..3` / `reimagine_1..3`；Runway Aleph 2.0 `keyframes` **1–5 个**带 `range{start_seconds,end_seconds}`，输入 2–30 秒；Pika `pikaswaps` 用 `modify_region_roi`（自由文本描述区域）**或** `modify_region_mask` | <https://docs.lumalabs.ai/docs/modify-video>、<https://docs.dev.runwayml.com/guides/models.md>、<https://dev.pika.art/openapi.json> |

对我们的直接含义：**§4 的缺口 2（视频不可回读）与缺口 3（没有 extend/edit）不是可选项**。全行业做长片只有一条路，而我们的上游里 Grok Imagine 已经同时支持 `extend` 与 `edit`（`video-presets.ts:96-98`），协议也已经有了，只是没接进智能体。

### 5.3 「多镜头由谁来切」——五家给了四种互不兼容的答案

**这是本次调研最重要的发现：外部没有收敛，所以这一条是我们自己的产品裁决，不能指望抄。**

| 路线 | 谁在走 | 用户交付的是什么 | 一手证据 |
| --- | --- | --- | --- |
| **模型自己切**（一次生成含多镜头） | Kling 3.0 Multi-Shot：官方称「AI Director Onboard, One-Click Cinematic Output」，模型从 prompt 理解场面调度、自动调机位构图，能做正反打与交叉剪辑，15 秒输出、时长 3–15 秒任意；OpenAI cookbook 也认可单 prompt 写多镜头，但要求「each shot block distinct: one camera setup, one subject action, and one lighting recipe at a time」 | 一段戏 | <https://kling.ai/quickstart/klingai-video-3-model-user-guide>、<https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide> |
| **服务端 recipe 代拆** | Runway `POST /v1/recipes/multi_shot_video`，`mode: "auto"` 时只给一个 ≤2500 字符的 prompt，**recipe 自己拆成一组镜头**。官方对 recipes 的定义是「Runway-built endpoints with our prompting and workflow expertise packaged in」 | 一个故事 | <https://docs.dev.runwayml.com/recipes/multi-shot-video>、<https://docs.dev.runwayml.com/recipes/> |
| **用户显式列镜头清单** | 同一个 Runway 端点的 `mode: "custom"`：`shots` 数组 **3–5 个**，每个 `{ prompt: 3–512 字符, duration: 整数秒 }`，且**各 shot duration 之和必须等于总 duration**，总时长只能是 5/10/15；Pika `pikaframes` 收 **2–5 张有序关键帧**，官方原文「Consecutive pairs become transitions」，且 `transition_duration_s` 超过 5 秒时只允许恰好 2 张；Sora Storyboard 按时间戳摆卡片（**摘录级**） | 一张分镜表 | 同上 + <https://dev.pika.art/openapi.json> |
| **一镜一生成，再在时间线上串** | Flow Scenebuilder：**一个 project 一个 scene，由一串 clip 组成**，可拖拽重排、裁剪首尾、整段预览、下载整个 scene；多镜头叙事靠 **Jump To**（「transition a character or object to a completely new setting while preserving their appearance from the previous shot」）+ **Extend**（「analyzes the final frames and continues the action, letting your shot breathe without a full regeneration」）。Runway Workflows 用 **Stitch 节点**把多个 Video 输出按顺序拼成一条（**摘录级**） | 一串剪辑动作 | <https://support.google.com/flow/answer/16935718>、<https://blog.google/innovation-and-ai/products/flow-video-tips/> |

注意 Runway 的 `multi_shot_video` **同一个端点同时提供 auto 与 custom 两种模式**——这是最强的一条设计暗示：把「谁来切」做成用户可切换的开关，而不是产品立场。

另外：Runway 的 `multi_shot_video` **是否用前一镜末帧种下一镜，官方没说 —— 未找到官方说明**，不推断。

**运镜控制完全没有标准：** Luma 要先 `GET /generations/camera_motion/list` 拿列表，再把值「add the camera motion value as part of prompt itself」（<https://docs.lumalabs.ai/docs/video-generation>，2026-09-17）；Flow 有独立的 Camera edit mode，但**官方帮助页没有列出具体运镜项 —— 未找到官方说明**；Kling 有结构化 `camera_control`，但**其字段结构未找到官方说明**（API 文档站 WAF 未能直取）；Runway 的立场是运镜就写在 prompt 里。

我们今天的 `camera` 字段是自由文本（`storyboard.ts:47`），**这和多数厂商一致，不必改**。

### 5.4 Agent loop 的交互模式：问 vs 假设、长任务、中途转向

**(a) 什么时候该问用户。** 官方口径高度一致，而且和我们现在的做法**方向相反**：

- OpenAI 官方 Model guidance：「When the user's intent is unclear, the model is more likely to ask the user for clarification to proceed.」但紧接着：「When the user's prompt indicates a request for action, such as 'can you...', 'I want to...', 'help me...' treat these as instructions to do the work and take action.」以及最关键的一句——**「Before asking the user clarifying questions, you should complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable.」**
  <https://developers.openai.com/api/docs/guides/prompt-guidance>（2026-09-17）
- Anthropic Agent SDK 的 `AskUserQuestion` 定位：「When Claude needs more direction on a task with multiple valid approaches, it calls the `AskUserQuestion` tool.」并且「Clarifying questions are especially common in **plan mode**, where Claude explores the codebase and asks questions before proposing a plan.」
  <https://code.claude.com/docs/en/agent-sdk/user-input>（2026-09-17）
- Anthropic「Building effective agents」只给到「Agents can then pause for human feedback at checkpoints or when encountering blockers」这一句，**没有 ask-vs-assume 的具体判据 —— 未找到官方说明**。
  <https://www.anthropic.com/engineering/building-effective-agents>（2026-09-17）

**问题的形状**（这是我们和官方差最远的一处）。`AskUserQuestion` 的 input 形状：
- `questions` 数组，**1–4 个问题**，每问 **2–4 个选项**
- 每问有 `question`（全文）、`header`（≤12 字符的短标签）、`options[{label, description}]`、**`multiSelect`**
- 选项可带 `preview`（`previewFormat: "markdown" | "html"`），官方说明「Claude includes `preview` on options where a visual comparison helps (layout choices, color schemes)」
- 回答侧支持自由文本：官方建议「Display an additional "Other" choice after Claude's options that accepts text input」，另有 `response` 字段承接「用户不答任何一问、直接说一句」的情况
- 限制：一次调用 1–4 问、每问 2–4 选项；subagent 里不可用
<https://code.claude.com/docs/en/agent-sdk/user-input>（2026-09-17）

对比我们的 `clarification.ts:15-22`：**1 问、2–4 选项、无多选、无自由文本、无预览，且发出即结束本轮**。分镜场景最该一次问清的「画幅 / 时长 / 风格」三件并列的事，现在要占三轮。

**(b) 长任务怎么暴露。** 两家都把「后台跑 + 可查 + 可续流」当成一等能力：

- Anthropic Managed Agents 的定位就是「Best for long-running tasks and asynchronous work」、「Tasks that run for minutes or hours with multiple tool calls」。session 状态机是 `idle` / `running` / `rescheduling` / `terminated`，且官方特别说明「A session that finishes its work goes `idle`, not `terminated`」。
  <https://platform.claude.com/docs/en/managed-agents/overview>（2026-09-17）
- 断线重连的官方做法是**先开流再补历史去重**：「Open a new stream first (before listing history)」→ `events.list()` 拿全量事件 id → tail 实时流时跳过已见 id。
  <https://platform.claude.com/docs/en/managed-agents/events-and-streaming>（2026-09-17）
- OpenAI 的 `background: true` + `stream: true`：每个事件带 `sequence_number`，断线后用 `starting_after` 游标续播；取消是幂等的（「subsequent calls simply return the final Response object」）。
  <https://developers.openai.com/api/docs/guides/background>（2026-09-17）

我们的做法（会话内单调 `seq` + `Last-Event-ID` 重放，`events.ts:11-19`、`sse.ts`）**与 OpenAI 的 `sequence_number` + `starting_after` 是同一模式，且比 Anthropic 的「去重」更省**。这块不用改。

**(c) 中途怎么转向。** 三条原语，我们有两条：

| 原语 | 官方做法 | 我们有没有 |
| --- | --- | --- |
| 追加消息引导 | Managed Agents 的 `user.message` 事件；Agent SDK 的 streaming input mode，官方说它支持「Queued messages: send multiple messages that process sequentially, with ability to interrupt」 | ✅ `interject` → `agent.steer()`（`turn.ts:458-498`） |
| 硬打断后改向 | `user.interrupt` 事件：「A model response in progress stops immediately. The interrupt can take longer to apply while tool calls are running, and the session stays `running` until it does.」然后再发一条 `user.message` 重定向 | ⚠️ 只有 `abort()`（整轮死掉，`turn.ts:499-502`），**没有「打断后接着干」** |
| 逐次工具审批 | Managed Agents 的 `user.tool_confirmation` 事件：`always_ask` 策略下工具调用暂停，session 以 `stop_reason.type == "requires_action"` 变 `idle`，回 `allow` / `deny`（可带 `deny_message`）；Agent SDK 的 `canUseTool` 回调可 **allow / allow-with-modified-input / deny-with-message**，官方还列了「Approve with changes」「Suggest alternative」两种中间态 | ❌ 没有。但 pi 的 `beforeToolCall` 就是这个接缝（`{ block, reason, terminate }`，见 §1），**装了没用** |

对照 Flow Agent 的产品选择：官方文档说它**默认在花积分前先请示用户**，可配置为不确认直接生成（<https://support.google.com/flow/answer/17093911>，2026-09-17）。这与我们「一段视频是这里最贵的一件事」（`generateVideo.ts:78` 注释）的判断是同一条。

**(d) 一条别被名字骗了的事实。** Luma 把新 API 叫 "Agents API"，但官方文档里它是**无状态 REST**：`POST /v1/generations` → 轮询 → presigned URL，没有 session、没有 memory、没有 tool（<https://docs.agents.lumalabs.ai/>，2026-09-17）。"agent" 在这个赛道已是品牌词，不能当交互模型的信号读。

### 5.5 一条趋势：API 层正在聚合化

Runway 的 `/guides/models.md` 里跑着 `veo3.1`、`seedance2`、`hailuo3`、`wan3`、`grok_imagine_1_5`、`gemini_omni_flash`（<https://docs.dev.runwayml.com/guides/models.md>，2026-09-17）；Pika 官方 `openapi.json` 共 **144 条 path，只有 11 条是自家模型**，其余是 Seedream / Gemini / GPT Image / Veo / Kling / Seedance / Hailuo / Grok / FLUX / Topaz / ElevenLabs（<https://dev.pika.art/openapi.json>，2026-09-17）。Runway 2026-07-23 还上线了 **Model Router**，按 cost / latency / quality 自动选模型、用户不手选（<https://docs.dev.runwayml.com/api-details/api_changelog/>，2026-09-17）。

含义：「选哪个上游」在贬值，「用什么原语组织创作」在升值。我们本来就是聚合形态（channel + 支持矩阵，`video-presets.ts:87-155`），这条趋势对我们有利——**但也意味着 `clampVideoPreset` 那种"悄悄退档"的做法，将来要变成智能体能读懂、能向用户解释的东西**（`video-presets.ts:176-199`）。

---

## 六、三个候选交互模型

三者共享同一批新建件（§4 的 2、3、5），差别在**分镜这件产物存在于哪里**。

### 候选 A：对话 + 一份可改的分镜文档

分镜是服务端一份带修订号的结构化文档，智能体有 `readStoryboard` / `writeStoryboard`（或更细的 `patchShot`）工具。用户说「把第 3 镜改成黄昏」，模型读文档 → 改那一镜 → 写回 → 顺手重出那一镜的图。界面左边对话、右边是文档的只读渲染 + 少量直接编辑入口。

- **像谁**：Runway `multi_shot_video` 的 `custom` 模式 + Flow Scenebuilder 的「一串 clip」；用户手里始终有一张分镜表。
- **拿掉了哪些死板**：2.1（增量写，不再全有全无）、2.3（时间轴是文档字段，模型可决定）、2.6（说一句话改一镜）、2.7（改不是重来）、2.9（文档在服务端）。
- **遵守**：ADR 0003（pi 当库，工具就是普通函数）、ADR 0001（新能力位 deny by default）、ROADMAP 2.3 的「结构化输出」。
- **要小心的边界**：ADR 0005 把「项目」定为画布的稳定归属、会话 ID 只是关联信息。分镜文档**不能**塞进 `canvas_projects.document`（协议版本 1 只认文字/箭头/画笔，ADR 0002），要开一张新表，并明确它挂在会话上还是挂在项目上。**这是本候选唯一真正需要 ADR 级裁决的点。**
- **代价**：最大的一块新建。工具写文档要防并发（用户同时在右边手编）；修订号语义要和 ADR 0002 的 OCC 对齐但不是同一张表；文档形状一旦定了就是新的兼容负担。

### 候选 B：纯对话，没有文档

不建分镜产物。用户说一句，智能体出一段；说「接着往下」就调 `extendVideo`；说「第 2 段太快」就用那段的帧重出。分镜表如果需要，就是模型写在回复里的一段 Markdown（今天 `exportStoryboard.ts:15-39` 导出的本来就是 Markdown）。"成片"是用户拿走一串片段自己接，或后期补一个拼接工具。

- **像谁**：Flow Scenebuilder 的 Jump To + Extend，以及 Kling 的 Auto-Extend / Customized Extend 两种模式。
- **拿掉了哪些死板**：2.1–2.3、2.5–2.7、2.9 全部消失（因为根本没有那份结构）；**2.2 的 15 秒天花板也被 extend 捅破**（对照 §5.2：Veo 可到 148 秒、Kling 可到 3 分钟）。
- **遵守**：所有 ADR，零新增存储概念。改动最小的一条路。
- **违背 / 风险**：与 ROADMAP 2.3 的「产出分镜表（镜号、画面、运镜、时长、台词）」和「分镜可编辑后逐镜或整体生成」**直接冲突**——2.3 的验收要求一份可编辑的表。要走 B 就得改 ROADMAP 2.3 的验收，说清楚「表」降级为对话产物。
- **代价**：用户要重看第 3 镜的提示词得往上翻聊天记录；跨设备靠会话历史（有，但不是一张表）；上下文压缩会把早期镜头的原文折成摘要（`compaction.ts`），**长片做到后面模型会"忘记"前面镜头的确切措辞**——这是 B 最真实的风险，且和我们已有的压缩机制直接相撞。

### 候选 C：分镜是一份 Skill，产物仍是现有画布对象

不建文档、不建新模式。写一份 `SKILL.md`（Agent Skills 标准），内容就是今天 `buildStoryboardPrompt()` 里那套导演知识 + 何时该问、何时该直接做、每镜该带什么。智能体按 skill 干活，产出照旧落画布与结果卡。镜头之间的关系由画布上的空间排布承载（画布已经有 `anchorObjectId`「贴着源图放」的语义，`turn.ts:398`）。

- **像谁**：Runway 的 recipes（「packaged prompting and workflow expertise」）与 `mode: "auto"`；也是 ADR 0003 结尾明写的那条路。
- **遵守**：ADR 0003 的原话「给分镜这类专业形态留了一条不写代码的路」。存储零新增。
- **代价 / 未解**：pi 的 skills 在 **harness 层**（`dist/harness/skills.d.ts`），而 `turn.ts:237` 直接 new 的是 `Agent` 类，`AgentOptions` 里**没有 skills/resources 字段**（`dist/agent.d.ts:5-24`）。要么接 harness（改动比想象大），要么把 skill 内容直接拼进 `systemPrompt()`（那就只是个提示词文件，叫 skill 是抬举）。**「不写代码」这个承诺，在当前接法下并不成立——这是本次调研对 ADR 0003 那句话的一条修正。**
- 另外：画布承载不了「顺序」与「时长」。分镜最核心的两个属性在画布上没有表达。

### 三者对照

| | A 文档 | B 纯对话 | C Skill |
| --- | --- | --- | --- |
| 拿掉第 2 节几条死板 | 5 条（2.1/2.3/2.6/2.7/2.9） | 7 条 + 捅破 2.2 | 5 条 |
| 需要 `extendVideo` / 视频可回读 | 是 | **是，且是命根子** | 是 |
| 新增存储 | 一张新表 + OCC | 无 | 无 |
| 触到的 ADR | ADR 0005 的归属边界要澄清 | 无 | ADR 0003 的「不写代码」不成立 |
| 与 ROADMAP 2.3 验收 | 吻合 | **冲突，要改 2.3** | 部分吻合（无「可编辑的表」） |
| 长会话下会不会丢细节 | 不会（文档是事实源） | **会**（靠压缩后的历史） | 会 |
| 最大风险 | 文档形状定早了 | 长片后半段失忆 | 顺序与时长无处安放 |

---

## 七、建议

**倾向：A 为主干，B 的原语先做，C 当 A 的提示词层。** 理由逐条：

1. **`extendVideo` + 视频可回读是三条路的公约数，且外部证据说它是做长片的唯一手段（§5.2）。它还独立于交互模型的裁决。** 所以不管最后选哪个，这两件先做：给 `outputsFromHistory` 放行 `media === 'video'`（`agent/images.ts:120`），加 `extendVideo` / `editVideo` 两个工具（协议与上游都现成，`video-presets.ts:26-59`、`derive.ts:31-50`）。做完这一步，**今天的智能体就已经能做出比导演台更长的片子**——15 秒天花板是导演台的，不是上游的。

2. **B 不能当终点，因为它和我们自己的压缩机制相撞。** 一条 5 镜的片子做到第 20 轮，早期镜头的原文已经被折进摘要（`compaction.ts`、`CONTEXT.md` 的「上下文压缩」词条）。分镜恰恰是那种「第 15 轮还要精确回到第 2 镜措辞」的活。**文档是唯一能让压缩不伤及事实的结构**——这也正好是压缩机制设计时留的口子：存储里的消息一条不改，模型输入才塑形。文档同理，它是事实源，压缩动不了它。

3. **A 的「谁来切镜头」照抄 Runway 的双模式，不要自己立场。** `multi_shot_video` 在同一个端点提供 `auto`（服务端拆）与 `custom`（用户列表）（§5.3）。落到我们这里就是：用户说一句创意 → 智能体**先直接拆一版写进文档**（对应 OpenAI 那条「complete the work that is already authorized from context and necessary to make the proposed action concrete and reviewable」），而不是先弹表单问镜数。想要精确控制的用户直接改文档。**这一条同时解决了「太难用」：第一版是免费的，改是可选的。**

4. **澄清工具要扩到官方 `AskUserQuestion` 的形状。** 1–4 问、每问 2–4 选项、支持 `multiSelect`、支持自由文本兜底（§5.4）。并且要重新考虑「发出即结束本轮」这条（`turn.ts:261`）——分镜里「画幅？时长？风格？」应该一次问完、一次答完、继续同一轮，而不是三个来回。

5. **贵操作要走审批，不要走澄清。** pi 的 `beforeToolCall` 已经在（`{ block, reason, terminate }`），这正是 Anthropic `user.tool_confirmation` / `canUseTool` 和 Flow Agent「默认花积分前先请示」的同一条接缝（§5.4）。`generateVideo` 已经是 `onError: 'abort'` 因为「视频是这里最贵的一件事」（`generateVideo.ts:78`）——把它升格成「跑之前先给用户看一眼参数」，比事后失败更省钱。

6. **C 不作为独立候选，但它的内容要留下。** `buildStoryboardPrompt()` 里那套导演知识（`apps/bff/src/lib/storyboard.ts:16-46`）是真资产，不该随 `/api/storyboard/plan` 一起删。它应该变成 A 里智能体的分镜提示词层。至于是不是叫 skill、要不要接 pi 的 harness，那是实现细节，不值得为它改 ADR 0003。

**第一刀怎么切**（建议顺序，每一步独立可上）：
1. 视频产物可回读 + `extendVideo` / `editVideo` 工具 → 智能体立刻能做长片，导演台不动。
2. 澄清工具扩形状（多问 + 多选 + 自由文本 + 不再强制结束轮）。
3. 分镜文档 + 读写工具 + 右侧渲染，智能体面板进视频模式（或视频创作并入创作模式）。
4. 导演台整套下线，`generation:storyboard` 能力位与 `/api/storyboard/plan` 一并退役。

---

## 八、要所有者裁决的问题

本文没有权限定的，共六条：

1. **分镜文档挂在哪儿？** 挂会话（跟着对话走，换会话就没了）、挂项目（ADR 0005 已把项目定为稳定归属，但它现在只管画布）、还是独立一张表？——这是唯一触到 ADR 0005 的裁决。

2. **ROADMAP 2.3 的验收改不改？** 现在写的是「分镜可编辑后逐镜或整体生成；提示词按目标模型切换方言」（`docs/ROADMAP.md:99`）。走 A 基本吻合；「按目标模型切换方言」这条在智能体里怎么落——是模型自己按工具描述适配，还是仍要一张方言表？**本次没有找到任何一家厂商把"方言"做成显式产品概念**，各家都是让模型直接按自家 prompt 指南写。

3. **成片到底做不做？** 全仓没有拼接（§1）。选项：(a) 不做，用 extend 链出一条长片，接受上限（Kling 3 分钟 / Veo 148 秒，§5.2）；(b) 做服务端拼接，那是一条全新的媒体处理链路（ffmpeg / 对象存储 / 新任务类型），成本远超本次范围；(c) 只导出素材包让用户自己剪（今天 `exportZip` 已经在做一半）。

4. **导演台立即下线还是并存一段？** 分镜存在 IndexedDB（`storyboardStore.ts:11-16`），下线等于用户本机的分镜全部作废，且**没有迁移路径**（服务端没有这些数据）。要不要给一次导出/迁移。

5. **贵操作默认问还是默认做？** Flow Agent 官方默认「花积分前先请示」且可关（§5.4）；OpenAI 的 guidance 则说先把活干到可审阅再问。视频一条几分钟几十积分，这两条在这里是真冲突。建议按金额分档，但档位谁定、由 `operator-config` 还是硬编码，要裁。

6. **视频创作在哪个模式里？** 并进创作模式（一个对话 + 一块画布，`docs/design/creation-studio.md` 的既有形态），还是视频模式单独挂一个智能体面板（两套会话、两套历史）？前者更省，但画布承载不了时间轴；后者要复制一遍会话 UI。

---

## 附：外部来源清单（全部 2026-09-17 抓取）

- OpenAI：<https://developers.openai.com/api/docs/deprecations>、<https://developers.openai.com/api/docs/guides/video-generation>、<https://developers.openai.com/api/docs/api-reference/videos>、<https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide>、<https://developers.openai.com/api/docs/guides/background>、<https://developers.openai.com/api/docs/guides/prompt-guidance>
- OpenAI（**摘录级，403 未直读**）：help.openai.com 文章 9957612 / 12460853 / 20001152
- Runway：<https://docs.dev.runwayml.com/llms.txt>、<https://docs.dev.runwayml.com/api.md>、<https://docs.dev.runwayml.com/guides/models.md>、<https://docs.dev.runwayml.com/recipes/>、<https://docs.dev.runwayml.com/recipes/multi-shot-video>、<https://docs.dev.runwayml.com/api-details/api_changelog/>、<https://academy.runwayml.com/course/video-magic-aleph>
- Runway（**摘录级，403 未直读**）：help.runwayml.com 文章 33545310653203（Generative Sessions）、42290974553875（Chat Mode）、51683104370451（Edit Studio）、45763528999699 / 47184761711379（Workflows / Stitch）、40042718905875（Gen-4 References）
- Google：<https://ai.google.dev/gemini-api/docs/veo>、<https://ai.google.dev/gemini-api/docs/video>、<https://support.google.com/flow/answer/16353334>、<https://support.google.com/flow/answer/16935718>、<https://support.google.com/flow/answer/16352836>、<https://support.google.com/flow/answer/17093911>、<https://blog.google/innovation-and-ai/products/flow-video-tips/>
- Luma：<https://docs.lumalabs.ai/docs/video-generation>、<https://docs.lumalabs.ai/docs/modify-video>、<https://docs.agents.lumalabs.ai/>、<https://docs.agents.lumalabs.ai/guides/videos/generation>、<https://docs.agents.lumalabs.ai/guides/videos/editing>
- Pika：<https://dev.pika.art/>、<https://dev.pika.art/openapi.json>、<https://api.dev.pika.art/catalog/apis>
- Kling：<https://kling.ai/quickstart/ai-video-extension>、<https://kling.ai/quickstart/klingai-video-3-model-user-guide>、<https://kling.ai/quickstart/klingai-video-3-omni-model-user-guide>、<https://kling.ai/quickstart/motion-control-user-guide>；**`kling.ai/document-api/*`（API 参考）SPA + WAF 未能直取，其 API 字段名一律未采用**
- Anthropic：<https://www.anthropic.com/engineering/building-effective-agents>、<https://platform.claude.com/docs/en/managed-agents/overview>、<https://platform.claude.com/docs/en/managed-agents/session-operations>、<https://platform.claude.com/docs/en/managed-agents/events-and-streaming>、<https://code.claude.com/docs/en/agent-sdk/user-input>、<https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>
