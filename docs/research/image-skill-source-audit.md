# 截图中七个生图 Skill 的来源与复用边界

核查日期：2026-09-24。以下只依据各作者 GitHub 仓库在核查时的 `main` 提交；链接固定到相应 commit，避免后续文件变化造成结论漂移。截图是待核查的名称清单，不是本项目的实现或授权依据。本记录评估源码与素材可否纳入产品，未验证生成效果。

## 来源、能力与许可

| 截图名称 / 作者 | 核实的能力与运行依赖 | 当前许可与本项目可复用范围 |
| --- | --- | --- |
| `scenes-gathered-zine-v1-3` / Zeejay0 | [Skill](https://github.com/Zeejay0/gathered-scenes-zine-skill/blob/b9edb836c9dd5c5d80995e89ebcaba34b75fd58f/skills/scenes-gathered-zine-v1-3/SKILL.md)：以用户照片为真实锚点，组合抽象插画、结构性色彩、撕纸边缘和留白；依赖宿主的读图与生图能力，仓库没有随该 Skill 提供执行脚本。 | [当前 LICENSE](https://github.com/Zeejay0/gathered-scenes-zine-skill/blob/b9edb836c9dd5c5d80995e89ebcaba34b75fd58f/LICENSE) 是 **Personal Non-Commercial**，明确禁止用于商业应用、付费生图、SaaS/API 和代表机构使用，也限制商业产出。不能直接复制或密切改写进本产品；若需同款，应取得作者书面授权。 |
| `photo-abstract-editorial` / ZzzLc0405 | [Skill](https://github.com/ZzzLc0405/photo-abstract-editorial/blob/49e55073d6d0330274d31f75d27f5dd6eb35fd6d/SKILL.md)：保留原照片区，再用照片中的空间与色彩关系制作下方抽象面板和标题；[README](https://github.com/ZzzLc0405/photo-abstract-editorial/blob/49e55073d6d0330274d31f75d27f5dd6eb35fd6d/README.md) 的当前仓库提供中英提示词与示例，没有脚本。 | [LICENSE.md](https://github.com/ZzzLc0405/photo-abstract-editorial/blob/49e55073d6d0330274d31f75d27f5dd6eb35fd6d/LICENSE.md) 将 Skill、提示词、工作流设计和文档限制为个人、教育、研究和非商业用途；商业产品/Agent 或修改后商业分发须先获授权。不能将原文、提示词或其独特编排直接纳入产品。 |
| `surreal-pop-collage` / 2998980-hue | [Skill](https://github.com/2998980-hue/surreal-pop-collage/blob/5bcf6f52592b3c83a384e5314556d2eac804dcc0/SKILL.md)：照片去色作现实锚点，从原图推导大块平涂色形，并只加入一个“不可能的巨物”；含场景卡、四段式 prompt、一次定向纠偏和质量门。仓库没有执行脚本，依赖宿主生图能力。 | [LICENSE](https://github.com/2998980-hue/surreal-pop-collage/blob/5bcf6f52592b3c83a384e5314556d2eac804dcc0/LICENSE) 为 MIT。可选择性改编 Skill 文字和流程，分发时保留版权与许可声明；不必连同示例素材一起引入。 |
| `gc-minimal-zine-poster-v0-3` / LiamGvchi | [Skill](https://github.com/LiamGvchi/gc-minimal-zine-poster/blob/ddb0d66b24a94f9c4fdd1f02835a836a2db3774e/SKILL.md)：把主题、照片或参考图路由到生成、照片输入、参考分析、仅 prompt、分析后生成等模式；[README](https://github.com/LiamGvchi/gc-minimal-zine-poster/blob/ddb0d66b24a94f9c4fdd1f02835a836a2db3774e/README.md) 说明包中有独立的风格系统、prompt 编译、变体与质检文档，且无运行脚本、字体或 API key。 | [LICENSE](https://github.com/LiamGvchi/gc-minimal-zine-poster/blob/ddb0d66b24a94f9c4fdd1f02835a836a2db3774e/LICENSE) 为 MIT。最适合作为**路由和质量门的结构参考**；如实际复制内容，保留版权与许可声明，并将 Codex 专用图像工具调用替换为本项目接口。 |
| `travel-memory-sticker-card` / carolinaaafy | [Skill](https://github.com/carolinaaafy/travel-memory-sticker-card/blob/25ac9753bae206e452f1501c9a57f93f853df408/SKILL.md)：把一张用户照片制成横向记忆卡，含大幅插画、六个贴纸母题和三个英文关键词；靠宿主生图工具，没有脚本。 | [LICENSE](https://github.com/carolinaaafy/travel-memory-sticker-card/blob/25ac9753bae206e452f1501c9a57f93f853df408/LICENSE) 仅授予个人非商用，并明确禁止将 Skill 或实质相似衍生物作为其他应用的模板、预设、工作流、插件或内置功能；[Skill 末尾](https://github.com/carolinaaafy/travel-memory-sticker-card/blob/25ac9753bae206e452f1501c9a57f93f853df408/SKILL.md#license) 也重申了限制。不能直接收录，也应避免改名后照搬其固定版式与规则。 |
| `heytea-doodle-poster` / Hchen1218 | 实际仓库是 [`heytea-style`](https://github.com/Hchen1218/heytea-style/tree/d5125372adcc945c2314cfb649c50407379a18ab)，其 [Skill](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/SKILL.md) 已扩展到带字/无字物件涂鸦海报、风味小怪兽和桌宠；带字版分底图、标题参考板和标题层。部分脚本需要 [Pillow](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/requirements.txt)。 | 根目录 [LICENSE](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/LICENSE) 为 MIT，但 [ASSET-NOTICE](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/ASSET-NOTICE.md) 单独规定：作者示例是 CC BY 4.0，`private-assets/reference-cutouts/` 的品牌图、包装、活动碎片和提取图**不在授权范围**。可借鉴或改编“真实物件 + 无字叙事 / 分层中文标题”的通用工作流及 MIT 代码；不要导入品牌参考图、logo 或把它包装为官方品牌模板。 |
| `make-tape-collage` / SherlyRyn | 仓库账号实际拼写为 [`sherlyryn`](https://github.com/sherlyryn/make-tape-collage/tree/b5b400b3becf13195ceadc92671a224e96deb7f4)。[Skill](https://github.com/sherlyryn/make-tape-collage/blob/b5b400b3becf13195ceadc92671a224e96deb7f4/SKILL.md) 路由照片转胶带画、保留原图的照片/纸张拼接、文字生成和定向修改；保留原图模式以透明胶带母题加 [Python/Pillow 合成器](https://github.com/sherlyryn/make-tape-collage/blob/b5b400b3becf13195ceadc92671a224e96deb7f4/scripts/compose_direct_split.py) 保持照片像素与排字可控。[README](https://github.com/sherlyryn/make-tape-collage/blob/b5b400b3becf13195ceadc92671a224e96deb7f4/README.md) 说明宿主内置生图和手动合成依赖。 | [LICENSE](https://github.com/sherlyryn/make-tape-collage/blob/b5b400b3becf13195ceadc92671a224e96deb7f4/LICENSE) 为 MIT。可改编流程与合成脚本并保留版权与许可声明；运行脚本前还需评估与本项目服务端语言、依赖及图片处理链路的适配成本。 |

## 初步选择

1. **优先试点**：`gc-minimal-zine-poster-v0-3` 的多模式路由/参考分析/质量门，`surreal-pop-collage` 的单一视觉概念，`make-tape-collage` 的胶带媒材与保留原图合成。三者均为 MIT；先将适用规则改造成本项目可独立评估的配方，并保留相应许可声明。[GC Skill](https://github.com/LiamGvchi/gc-minimal-zine-poster/blob/ddb0d66b24a94f9c4fdd1f02835a836a2db3774e/SKILL.md)、[超现实 Skill](https://github.com/2998980-hue/surreal-pop-collage/blob/5bcf6f52592b3c83a384e5314556d2eac804dcc0/SKILL.md)、[胶带 Skill](https://github.com/sherlyryn/make-tape-collage/blob/b5b400b3becf13195ceadc92671a224e96deb7f4/SKILL.md)。
2. **拆开吸收**：`heytea-doodle-poster` 中带字和无字海报是两个不同生成路线，中文标题分层处理也有通用价值；由于[品牌资产排除条款](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/ASSET-NOTICE.md)，只保留无品牌的物件涂鸦能力，桌宠部分不属于本次生图路由范围。[Skill](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/SKILL.md)。
3. **暂不搬运**：`scenes-gathered-zine-v1-3`、`photo-abstract-editorial`、`travel-memory-sticker-card` 的当前许可都排除本产品内置/商用复用；具体同款需要作者授权。[三份当前许可](https://github.com/Zeejay0/gathered-scenes-zine-skill/blob/b9edb836c9dd5c5d80995e89ebcaba34b75fd58f/LICENSE)、[照片抽象许可](https://github.com/ZzzLc0405/photo-abstract-editorial/blob/49e55073d6d0330274d31f75d27f5dd6eb35fd6d/LICENSE.md)、[旅行卡许可](https://github.com/carolinaaafy/travel-memory-sticker-card/blob/25ac9753bae206e452f1501c9a57f93f853df408/LICENSE)。

## 本项目现有路由与落地方案

### 现状与约束

- 仓库当前有 16 条图片 Skill，已按 `image` / `video` / `shared` 加载；每轮在 `<available_skills>` 列出所有可见技能的 `name` 和 `description`，模型匹配后调用 `loadSkill` 读正文，用户也可用 `/skill-name` 明确指定。这里的“自动路由”目前依靠描述文案，没有独立的分类器。[渐进加载设计](../adr/0007-agent-skills-progressive-loading.md)、[技能装配](../../apps/bff/src/lib/agent/skills.ts)、[清单生成](../../apps/bff/src/lib/agent/turn-input.ts)。
- `poster` 管带文案的海报流程，`art-direction` 管笼统想法到生图简报，`image-remix` 管参考图构图复刻；用户自建及预置“模板”则是一种效果配置，借用同一套 Skill 加载外壳。新增七个顶层 Skill 会与现有入口争抢路由并增加每轮清单成本。[海报 Skill](../../apps/bff/skills/image/poster/SKILL.md)、[美术指导 Skill](../../apps/bff/skills/image/art-direction/SKILL.md)、[模板定义](../../CONTEXT.md)。
- 预置模板现须有 `purpose`、固定模型与尺寸、封面，并至少有 **1 个素材位**；最多一次组装 4 张输入图。因此纯主题生成的极简 zine 不能直接作为现行模板卡片，先作为流程参考；带原照片的胶带拼接可以考虑做模板，但要先有自己的合法封面和样图。[模板元数据校验](../../apps/bff/src/lib/agent/skills.ts)、[模板组装](../../packages/shared/src/look-assembly.ts)。
- 现有 `generateImage` / `editImage` 走生成模型，其中改图只约定第一张为目标、其余为参考；没有把原照片像素原样拼入成品的确定性合成工具。源 Skill 写“原照不动”时，不能只靠 `editImage` 的提示词承诺像素级保真。[生图工具](../../apps/bff/src/lib/agent/tools/generateImage.ts)、[改图工具](../../apps/bff/src/lib/agent/tools/editImage.ts)。

### 建议的两层路由

先按**任务**选一条流程 Skill，再在其内部选至多一种**视觉配方**。用户明确点名 `/skill` 或选模板时优先；其余请求由任务输入和保真要求路由，避免七种风格同时进入顶层清单。

| 路由问题 | 选用的现有或拟增流程 | 可选的下层配方 |
| --- | --- | --- |
| 从主题做海报，有标题/文案 | `poster` | 极简 zine、无品牌物件涂鸦；具体规则放 `references/`，由流程按需读。 |
| 用用户照片做艺术化拼贴，允许重绘 | 拟增一条通用 `photo-collage` 流程；或先在 `art-direction` 的改图分支试验 | 超现实波普、胶带画；选择一种，保留项和可重绘项要分别写。 |
| 原照片必须原样保留，外加版式/纸张/胶带 | 先做确定性合成能力再开放该路线 | 胶带拼接；生成模型只制作装饰层，原照和准确文字由合成器放入。 |
| 给产品素材套一个可复用的固定效果 | 现有预置/用户模板 | 有合法封面、固定模型尺寸与素材位的验证后效果；不把第三方示例图直接当封面。 |

路由输入建议显式提取四项：`任务（新图/改图）`、`输入图角色（目标/风格参考）`、`原图保真要求（像素保留/主体可辨/自由重绘）`、`输出物（海报/拼贴/卡片及文字）`。任务流程处理工具选择、图片顺序和交付检查；配方只处理构图、媒材、色彩和质量门。这样 `poster` 的文字规则不会被某份外部配方覆盖，也能避免两种互斥风格被同时套用。路由字段是下一步的方案建议，**当前代码尚未实现**。

### 试点顺序与通过条件

1. **低成本试点**：从 MIT 的极简 zine 与超现实波普各提取一份适配本项目工具的原创/改编配方，记录来源 commit 与版权声明；先放进相应流程的 `references/`，不把原仓库整体拷入。测试“明确点名”“同义表达”“不应触发”的请求，检查是否选中正确流程与配方。
2. **照片试点**：胶带 Skill 先试允许重绘的版本；若要实现“原照片像素不变”，评估移植其 MIT 合成器或用现有技术栈重写等价能力。只有在实际输出上核对源图像素与文字后，才将这条路线对用户表述为“保留原图”。
3. **质量门**：用同一批用户任务比较现有 `poster` / `art-direction` 与新配方的成图，至少覆盖无参考主题、人物照、街景、产品照、中文标题、反向请求；人工检查路由正确率、主体/原图保真、版式差异、文字准确性，以及多一次 `loadSkill` 带来的延迟。通过后再决定是否制作预置模板卡片和扩充可见目录。

本阶段只完成源码、授权和适配路径调研；未安装或运行外部 Skill，未改动线上路由。

## 尚未核实

- 未在本项目图像模型上运行这些 Skill，也未比较样图与用户原图，因此不能据此宣称效果稳定、像素保真或文字准确。上述“优先”仅指许可和流程复用价值。
- 除 `heytea-style` 的 [ASSET-NOTICE](https://github.com/Hchen1218/heytea-style/blob/d5125372adcc945c2314cfb649c50407379a18ab/ASSET-NOTICE.md) 有明确分项授权外，未逐张核验各仓库示例图片、参考照片和字体的上游权利；试点不导入第三方样图或品牌素材。
- GitHub 网页搜索缓存中曾出现 Zeejay0 仓库为 MIT 的旧内容；本记录以 2026-09-24 的 [固定提交 LICENSE](https://github.com/Zeejay0/gathered-scenes-zine-skill/blob/b9edb836c9dd5c5d80995e89ebcaba34b75fd58f/LICENSE) 为准。后续实际搬运前仍需重新核对当时的提交和授权。
