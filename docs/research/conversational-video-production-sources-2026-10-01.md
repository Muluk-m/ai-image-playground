# 对话承接的视频制作模式：外部一手证据

> 研究范围修正：本文件保留为外围资料，不再作为国内竞品选择或产品形态决策的主报告。用户指出原样本偏离目标市场；请先阅读[国内同赛道竞品报告](china-conversational-video-competitors-2026-10-01.md)。Adobe / Apple 只与特定工程格式有关，不属于本站本次核心竞争对象。

调研日期：2026-10-01（Asia/Shanghai）。范围：Runway、Google Flow、LTX Studio 的公开官方说明，以及 Apple / Adobe 的工程互操作文档。未登录产品、未消费生成额度、未验证实际输出质量。以下“已确认”指公开文档能确认能力入口，不代表已经完成端到端实测。

## 研究结论

**建议把首版定义为“对话推进的短片制作项目”：用可编辑的剧本、角色卡和镜头清单承接对话，按需生成部分镜头，交付可继续创作的素材包。** 这是基于下列证据的产品判断，并非竞品能力必然推导出的唯一形态。

三个产品都将可复用参考素材与镜头生产连接起来，但承接形式不同：Runway 偏对话和自动编排，Flow 偏项目资产加场景序列，LTX 偏结构化分镜工作区。它们说明“对话入口”和“显式项目对象”可以共存；不能据此断言纯聊天或固定向导是行业标准。

## 1. Runway：对话之外保留明确的产物与编辑面

| 问题 | 已确认事实 | 一手来源 |
| --- | --- | --- |
| 能否从讨论进入制作 | Agent 支持脚本和叙事结构、分镜及角色参考表，并可生成图像、视频和音频；文档明确说明生成存在随机性，计划不是结果保证。 | [Creating with Runway Agent](https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent) |
| 怎样迭代局部 | 对话可修改计划与素材；生成结果集中在 Generations；多镜头内容可进入 Final Cut，支持手动裁剪、分割、排列及通过对话编辑。 | [Creating with Runway Agent](https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent) |
| 怎样管理参考素材 | 图片、视频和音频可作为参考，具体输入取决于模型；`@` 引用素材。临时参考只在当前会话有效，命名保存后可跨会话复用，也可共享到工作区。 | [Using reference media](https://help.runwayml.com/hc/en-us/articles/52963720640275-Using-reference-media-to-guide-your-generations) |
| 三视图是否硬前置 | Gen-4 References 文档给出从单张角色图生成不同场景/角度的工作流，最多三个参考输入，并建议自然均匀光照。文档没有要求先做三视图。此数量仅适用于该模型。 | [Gen-4 Image References](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References) |
| 如何控制花费 | Agent 有生成前展示模型、提示词和预计积分并确认的模式，也有自动生成模式；当前文档将自动生成列为默认。不能沿用旧笔记对默认行为的描述。 | [Creating with Runway Agent](https://help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent) |
| 固定制作流程如何承接 | Skills 是对话中的可复用工作指引；Workflows 是独立的可编辑、可复跑节点流程。官方明确区分二者。 | [Using Agent Skills](https://help.runwayml.com/hc/en-us/articles/53907039424915-Using-Agent-Skills)、[Workflows with Agent](https://help.runwayml.com/hc/en-us/articles/53645211363475-Building-and-running-Workflows-with-Agent) |

**未核实：** 本轮所读文档不足以确认 Agent 的完整 ZIP / 剪辑工程导出列表，因此不写“只支持 MP4”或“不支持工程导出”。

**设计启发（建议）：** 可以把“短片制作”作为对话的一种工作方式，但应让用户随时定位并修改角色、镜头及选用版本。不要把制作项目全部藏在聊天记录里。

## 2. Google Flow：角色、版本、场景序列都是显式对象

| 问题 | 已确认事实 | 一手来源 |
| --- | --- | --- |
| 对话能做什么 | Agent 可讨论分镜、视觉情绪板和提示词，生成媒体，修改选中的素材并批量生成变体。 | [Use the Google Flow Agent](https://support.google.com/flow/answer/17093911?hl=en) |
| 角色怎样复用 | 角色对象包含名称、图像参考、声音和可选信息；创建流程允许 1–2 张角色图，并要求至少一张才能使用。后续可通过 `@角色名` 调用。官方的一致性宣传不等于本轮已验证效果。 | [Manage projects, assets & collections](https://support.google.com/flow/answer/16935308?hl=en)、[Create videos](https://support.google.com/flow/answer/16353334?hl=en) |
| 参考图和首尾帧是否等价 | 官方把 Ingredients 与 Frames 列为不同路径；前者指导主体与场景，后者指定起始/结束画面。输入与功能可用性仍受模型、地区限制。 | [Create videos](https://support.google.com/flow/answer/16353334?hl=en) |
| 局部修改会覆盖原件吗 | 视频编辑保留原视频与提示词历史；旧版本可另存回项目。Scenebuilder 支持排列片段、重排、裁剪首尾、整体预览与下载场景。 | [Edit videos & build scenes](https://support.google.com/flow/answer/16935718?hl=en) |
| 资产交接能保留什么 | Takeout 导出含生成/上传媒体、提示词和设置、项目和集合、角色和场景、编辑版本链；结构数据为 JSON，媒体文件旁附对应元数据 JSON。它是数据导出文档，没有承诺该包能作为 Premiere / Final Cut 工程直接打开。 | [Download your Google Flow data](https://support.google.com/flow/answer/17571126?hl=en) |

**设计启发（建议）：** 角色卡中的身份参考与镜头关键帧应分开。每个镜头保留多个候选 take，并单独记录“采用哪一个”；角色修改后提示受影响镜头，不自动覆盖已选片段。

## 3. LTX Studio：脚本先拆成可检查的镜头结构

| 问题 | 已确认事实 | 一手来源 |
| --- | --- | --- |
| 脚本如何进入制作 | 官方流程是输入想法或剧本、设置、确认抽取的 Elements，再检查场景/镜头拆解；Elements 包括角色、物件和地点。 | [AI Storyboard Generator](https://ltx.io/studio/platform/ai-storyboard-generator) |
| 生成后怎样处理 | 官方教程把 Storyboard 作为排序和时长调整空间，源生成文件不变，编辑引用关系；支持替换单镜头和重排序列。 | [LTX Studio Tutorial](https://ltx.io/blog/ltx-studio-tutorial) |
| 局部重做与导出 | 官方产品页描述通过 Retake 调整特定镜头/片段，输出 MP4、pitch deck 或 XML；分镜专页明确 MP4 和 PDF pitch deck。 | [AI Movie Maker](https://ltx.io/studio/platform/ai-movie-maker)、[AI Storyboard Generator](https://ltx.io/studio/platform/ai-storyboard-generator) |

**证据边界：** XML 能力目前只有本轮读到的官方产品页声明，未核实 XML 方言、打包内容、目标软件版本与导入保真度。不能直接提升为“与所有剪辑软件兼容”。官方营销页关于角色完全一致的表达也不作为效果保证。

**设计启发（建议）：** 用户应该能在昂贵视频生成之前检查拆镜。一个项目可以只完成剧本和分镜图，也可以只挑关键镜头生成视频，不必以“所有镜头都生成”才算完成。

## 4. ZIP 素材包与剪辑工程不是同一项交付

Apple 将 FCPXML 定义为交换库、事件、项目和片段信息的专门格式；导入后可生成相应对象，也有版本选择要求。[Apple：用 XML 传输项目](https://support.apple.com/zh-cn/guide/final-cut-pro/verdbd66ae/mac)

Adobe 明确说 Premiere 不能直接导入 Final Cut Pro X 的 `.fcpxml`，需要转换成受支持的 XML；转换也不能保证复杂效果、转场和第三方插件完整迁移。[Adobe：Import XML files from Final Cut Pro X](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/migrate-from-final-cut-pro-x.html)

因此，“ZIP”只定义交付容器；“工程”还需要目标软件理解的时间线结构、素材引用和兼容性验证。以下是本项目建议，而非外部标准：

| 交付层级 | 用户得到什么 | 需要承诺什么 |
| --- | --- | --- |
| 素材包，建议首版 | 剧本、分镜表、角色参考、已采用图片/视频、提示词、资源清单 | 文件完整、名称和镜号对应、能解压和查看；用户自己导入目标软件并编排 |
| 预演片，可后续做 | 静帧与已有片段按计划顺序播放 | 标明占位镜头；用于看节奏，不等同最终成片 |
| 指定软件工程，后续单独立项 | 已编排镜头、时间、音轨、素材引用 | 明确支持的软件/版本，实测打开、重链接、时长/帧率/裁剪和音频行为 |

建议首版包结构：

```text
project-name/
  README.md                 # 使用方法、尚未制作的镜头
  script.md
  storyboard.csv            # 稳定 shot_id、显示镜号、计划时长、描述、对白、采用文件
  manifest.json             # 格式版本、稳定 ID、关系、文件路径、实际媒体参数
  characters/character-id/   # 角色卡、主参考、可选多视图
  shots/shot-id/             # 采用的关键帧、片段、生成提示词
```

默认只导出已采用版本，可选导出全部候选；未生成镜头保留说明，不伪装成视频文件。只有真实音频与经校对的时间信息存在时才导出字幕时码，不能用剧本文字冒充精准字幕。

## 5. 对“三视图”和固定阶段的建议

本轮 Runway 的单参考路径与 Flow 的 1–2 张角色图流程，都不把“三视图”作为所有项目的必要前置。这不足以证明三视图无用，却足以避免把它硬编码为通用门槛。[Runway](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References)、[Flow](https://support.google.com/flow/answer/16935308?hl=en)

建议以“角色定稿”作为目标，允许主形象图、多角度参考、服装/道具细节和声音信息按需要补充。产品广告可能没有人物；用户可能已有角色图或现成剧本；短概念片可能先探索视觉再改剧本。因此提供推荐顺序，同时允许跳过、回退和并行准备素材。

最值得验证的交互问题是：用户在聊天里说“把第 3 镜改成背影”时，能否清楚看到修改影响了哪条分镜、哪些参考图和哪个候选视频，以及这次是否需要重新付费生成。

## 6. 本轮未解决的问题

- 用户主要制作广告、叙事短片、漫剧还是知识视频；用途会改变角色/旁白/镜头表的优先级。
- 外部创作目的地首先是剪映、Premiere、Final Cut 还是另一家 AI 平台；首版不承诺未验证的工程互操作。
- 三视图、单主参考、拆分多角度图分别对站点现有视频模型的一致性帮助，需要同提示词、同角色的 A/B 生成验证；官方能力页不能代替测试。
- 镜头重写后的下游“待检查”标记、选用版本、导出缺失报告，属于本站数据与交互设计任务，不由上述产品文档决定实现方式。
- 旧研究笔记只用于发现议题；本报告没有沿用其中的“所有平台都如此”“某家只能下载单条”等绝对化结论。
